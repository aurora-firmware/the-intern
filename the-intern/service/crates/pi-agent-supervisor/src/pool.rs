use crate::{
    process::{InteractiveProcess, InteractiveProcessConfig, WorkerProcessConfig},
    rpc, Config,
};
use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use std::collections::HashMap;
use std::os::unix::io::OwnedFd;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::ChildStdout;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;

#[derive(Debug)]
struct ActiveSessionWorker {
    worker: crate::process::RpcWorkerProcess,
    last_prompt_activity: Instant,
    /// Background task draining the worker's stdout after a fire-and-forget
    /// periodic prompt, if one is running. Aborted when the worker is removed
    /// (killed, reaped, or shut down); otherwise it ends on its own at EOF.
    drain_handle: Option<JoinHandle<()>>,
}

/// Reads and discards a detached worker's stdout until EOF.
///
/// After a periodic prompt is accepted the agent run keeps streaming RPC
/// records to stdout with no other reader. Continuously draining them keeps the
/// OS pipe from filling: a full stdout pipe blocks the child mid-run, so
/// without this the scheduled action would freeze before completing (e.g.
/// before writing its output file). Ends when the child exits (EOF) or on a
/// read error.
fn spawn_stdout_drain(session_id: SessionId, mut stdout: BufReader<ChildStdout>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut line = String::new();
        loop {
            line.clear();
            match stdout.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    tracing::trace!(
                        session_id = %session_id,
                        "pi-agent-supervisor drained periodic worker stdout record"
                    );
                }
                Err(error) => {
                    tracing::debug!(
                        session_id = %session_id,
                        error = %error,
                        "pi-agent-supervisor stdout drain ended on read error"
                    );
                    break;
                }
            }
        }
    })
}

/// A warm worker waiting to be assigned to a session.
///
/// The `session_id` is pre-allocated at spawn time and set as `BOB_SESSION_ID`
/// on the child process environment.  The same id is used as the canonical
/// session id when the worker is promoted to active.
#[derive(Debug)]
struct WarmWorker {
    session_id: SessionId,
    worker: crate::process::RpcWorkerProcess,
}

#[derive(Debug)]
pub struct SessionPool {
    cfg: Config,
    warm_workers: Vec<WarmWorker>,
    active_workers: HashMap<SessionId, ActiveSessionWorker>,
    /// Interactive sessions tracked separately from RPC workers.
    interactive_sessions: HashMap<SessionId, InteractiveProcess>,
    /// Exit watchers registered via `watch_interactive_exit`.
    ///
    /// When an interactive session exits (naturally or via `kill_session`), the
    /// corresponding sender is fired so the waiting receiver is notified (AC-2).
    /// The process remains in `interactive_sessions` so `kill_session` can still
    /// terminate it (AC-3).
    interactive_exit_watchers: HashMap<SessionId, oneshot::Sender<()>>,
}

impl SessionPool {
    pub fn new(cfg: &Config) -> ServiceResult<Self> {
        let mut warm_workers = Vec::new();
        let warm_target = cfg.warm_pool_size.min(cfg.max_processes);

        for _ in 0..warm_target {
            warm_workers.push(Self::spawn_warm_worker(cfg)?);
        }

        Ok(Self {
            cfg: cfg.clone(),
            warm_workers,
            active_workers: HashMap::new(),
            interactive_sessions: HashMap::new(),
            interactive_exit_watchers: HashMap::new(),
        })
    }

    /// Acquires a worker for a new session.
    ///
    /// Returns the `SessionId` that was allocated for the session.  For warm
    /// workers the id was pre-allocated at spawn time and is already set as
    /// `BOB_SESSION_ID` on the child process.  For overflow workers a fresh id
    /// is generated and set at spawn time.
    pub fn acquire_session(&mut self) -> ServiceResult<SessionId> {
        let (session_id, worker) = if let Some(warm) = self.warm_workers.pop() {
            (warm.session_id, warm.worker)
        } else if self.total_process_count() < self.cfg.max_processes {
            let session_id = SessionId::new();
            let process_cfg = Self::worker_process_config_for_session(&self.cfg, session_id);
            let worker = crate::process::RpcWorkerProcess::spawn(&process_cfg)?;
            (session_id, worker)
        } else {
            return Err(ServiceError::ChildProcess {
                detail: format!(
                    "cannot acquire session because active + warm workers reached max_processes ({})",
                    self.cfg.max_processes
                ),
            });
        };

        self.track_active_worker(session_id, worker);
        Ok(session_id)
    }

    /// Acquires a dedicated worker bound to a caller-supplied working directory.
    ///
    /// Per S-002 Component 6 (warm-pool contract), warm-pool workers are
    /// pre-spawned with the service-wide cwd, so a request naming its own
    /// working directory cannot reuse one. This always spawns a **dedicated**
    /// worker whose `current_dir` is `cwd`, bypassing the warm pool entirely.
    ///
    /// Bound by `max_processes` exactly like [`Self::acquire_session`]: when
    /// active plus warm workers already fill the limit, the acquisition is
    /// refused rather than evicting a live worker or exceeding the bound.
    pub fn acquire_session_with_cwd(&mut self, cwd: PathBuf) -> ServiceResult<SessionId> {
        if self.total_process_count() >= self.cfg.max_processes {
            return Err(ServiceError::ChildProcess {
                detail: format!(
                    "cannot acquire cwd-scoped session because active + warm workers reached max_processes ({})",
                    self.cfg.max_processes
                ),
            });
        }

        let session_id = SessionId::new();
        let process_cfg = Self::worker_process_config_for_cwd_session(&self.cfg, session_id, cwd);
        let worker = crate::process::RpcWorkerProcess::spawn(&process_cfg)?;

        self.track_active_worker(session_id, worker);
        Ok(session_id)
    }

    /// Records a newly-acquired worker as an active session with fresh
    /// prompt-activity tracking, shared by both [`Self::acquire_session`] and
    /// [`Self::acquire_session_with_cwd`].
    fn track_active_worker(
        &mut self,
        session_id: SessionId,
        worker: crate::process::RpcWorkerProcess,
    ) {
        self.active_workers.insert(
            session_id,
            ActiveSessionWorker {
                worker,
                last_prompt_activity: Instant::now(),
                drain_handle: None,
            },
        );
    }

    pub fn list_sessions(&self) -> Vec<SessionId> {
        self.active_workers
            .keys()
            .copied()
            .chain(self.interactive_sessions.keys().copied())
            .collect()
    }

    pub async fn kill_session(&mut self, session_id: SessionId) -> ServiceResult<()> {
        // Check active RPC workers first.
        if let Some(mut worker) = self.active_workers.remove(&session_id) {
            if let Some(handle) = worker.drain_handle.take() {
                handle.abort();
            }
            worker.worker.terminate().await?;
            return Ok(());
        }
        // Also handle interactive sessions (needed by T-105: terminate on client disconnect).
        if let Some(process) = self.interactive_sessions.remove(&session_id) {
            // Fire the exit watcher (if registered) before terminating so the
            // AC-2 notification is sent promptly, before the await below.
            if let Some(tx) = self.interactive_exit_watchers.remove(&session_id) {
                let _ = tx.send(());
            }
            process.terminate().await?;
            return Ok(());
        }
        Err(ServiceError::InvalidRequest {
            detail: "session is not active".to_string(),
        })
    }

    pub async fn send_prompt(
        &mut self,
        session_id: SessionId,
        message: String,
    ) -> ServiceResult<()> {
        let active_worker =
            self.active_workers
                .get_mut(&session_id)
                .ok_or_else(|| ServiceError::ChildProcess {
                    detail: format!(
                        "no active worker for session {session_id}; call acquire_session first"
                    ),
                })?;
        let command = rpc::PromptCommand::new(message);
        active_worker.worker.send_json(&command.to_json()).await?;

        loop {
            let Some(record) = active_worker.worker.read_next_stdout_json().await? else {
                return Err(ServiceError::ChildProcess {
                    detail: "child stdout ended before prompt response".to_string(),
                });
            };

            match rpc::parse_prompt_response(&record, &command.id)? {
                Some(true) => {
                    active_worker.last_prompt_activity = Instant::now();
                    return Ok(());
                }
                Some(false) => {
                    return Err(ServiceError::ChildProcess {
                        detail: "prompt command rejected by child worker".to_string(),
                    });
                }
                None => {}
            }
        }
    }

    /// Sends a prompt, then detaches the worker's stdout into a background drain.
    ///
    /// Used by the periodic dispatcher for fire-and-forget scheduled runs. Like
    /// [`send_prompt`] it returns once the child acknowledges *receipt* of the
    /// prompt; the agent run then continues asynchronously. Unlike `send_prompt`
    /// it then hands the worker's stdout to a background task that drains it to
    /// EOF, so the child never blocks on a full stdout pipe mid-run. The worker
    /// stays in the pool and is reclaimed by the idle reaper (or `kill_session`)
    /// as before.
    pub async fn send_prompt_and_drain(
        &mut self,
        session_id: SessionId,
        message: String,
    ) -> ServiceResult<()> {
        self.send_prompt(session_id, message).await?;

        if let Some(active_worker) = self.active_workers.get_mut(&session_id) {
            if let Some(stdout) = active_worker.worker.take_stdout() {
                let handle = spawn_stdout_drain(session_id, stdout);
                if let Some(previous) = active_worker.drain_handle.replace(handle) {
                    previous.abort();
                }
            }
        }
        Ok(())
    }

    /// Starts an interactive pi session on the supplied terminal file descriptors.
    ///
    /// The caller must supply the three stdio fds (typically received from the
    /// client via `SCM_RIGHTS` per ADR-011).  The session is added to the
    /// session table and appears in `list_sessions` immediately.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::ChildProcess` if the extension file is missing or
    /// if the OS rejects the spawn.
    /// Registers an exit watcher for an interactive session.
    ///
    /// The `sender` is fired the next time the session exits (naturally or via
    /// `kill_session`).  The process remains in the pool so `kill_session` can
    /// still terminate it (AC-3).
    ///
    /// Returns `Err` when no interactive session with `session_id` is currently
    /// tracked.
    pub fn register_interactive_exit_watcher(
        &mut self,
        session_id: SessionId,
        sender: oneshot::Sender<()>,
    ) -> Result<(), ()> {
        if !self.interactive_sessions.contains_key(&session_id) {
            return Err(());
        }
        // Replace any previous watcher (in practice only one is ever registered).
        self.interactive_exit_watchers.insert(session_id, sender);
        Ok(())
    }

    /// Polls all interactive sessions that have registered exit watchers.
    ///
    /// For each session whose child process has exited (detected via
    /// `try_poll_exit()`), fires the exit watcher and removes the session from
    /// the pool. Called from the actor's dedicated interactive-exit tick so
    /// natural exits are detected promptly without blocking (AC-2).
    pub fn poll_interactive_exits(&mut self) {
        let exited: Vec<SessionId> = self
            .interactive_exit_watchers
            .keys()
            .copied()
            .filter(|id| {
                self.interactive_sessions
                    .get_mut(id)
                    .map(|p| p.try_poll_exit())
                    .unwrap_or(false)
            })
            .collect();

        for session_id in exited {
            // Remove from pool first so the Drop on InteractiveProcess runs.
            self.interactive_sessions.remove(&session_id);
            if let Some(tx) = self.interactive_exit_watchers.remove(&session_id) {
                let _ = tx.send(());
            }
        }
    }

    /// Removes an interactive session from the pool and returns it.
    ///
    /// Legacy method retained for tests that directly manipulate the pool.
    /// Production code uses `register_interactive_exit_watcher` +
    /// `poll_interactive_exits` instead.
    ///
    /// Returns `None` if no interactive session with the given id exists.
    pub fn take_interactive_session(
        &mut self,
        session_id: SessionId,
    ) -> Option<InteractiveProcess> {
        self.interactive_exit_watchers.remove(&session_id);
        self.interactive_sessions.remove(&session_id)
    }

    pub fn start_interactive_session(
        &mut self,
        cfg: InteractiveProcessConfig,
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: OwnedFd,
    ) -> ServiceResult<SessionId> {
        let session_id = cfg.session_id;
        let process = InteractiveProcess::spawn(cfg, stdin, stdout, stderr)?;
        self.interactive_sessions.insert(session_id, process);
        Ok(session_id)
    }

    pub fn warm_worker_count(&self) -> usize {
        self.warm_workers.len()
    }

    pub async fn reap_idle_and_surplus(&mut self) -> ServiceResult<crate::reaper::ReapReport> {
        let now = Instant::now();
        let stale_sessions = crate::reaper::select_idle_sessions(
            now,
            self.cfg.idle_reap_timeout,
            self.active_workers
                .iter()
                .map(|(session_id, worker)| (*session_id, worker.last_prompt_activity)),
        );
        let mut report = crate::reaper::ReapReport::default();

        for session_id in stale_sessions {
            if let Some(mut worker) = self.active_workers.remove(&session_id) {
                if let Some(handle) = worker.drain_handle.take() {
                    handle.abort();
                }
                worker.worker.terminate().await?;
                report.idle_sessions_reaped += 1;
            }
        }

        let surplus = crate::reaper::surplus_warm_worker_count(
            self.warm_workers.len(),
            self.cfg.warm_pool_size,
        );
        for _ in 0..surplus {
            if let Some(warm) = self.warm_workers.pop() {
                warm.worker.terminate().await?;
                report.warm_workers_reaped += 1;
            }
        }

        Ok(report)
    }

    pub async fn shutdown_all(&mut self) -> ServiceResult<crate::reaper::ShutdownReport> {
        let mut report = crate::reaper::ShutdownReport::default();
        let mut first_error = None;

        for (_session_id, mut worker) in self.active_workers.drain() {
            if let Some(handle) = worker.drain_handle.take() {
                handle.abort();
            }
            match worker.worker.terminate().await {
                Ok(_) => report.active_workers_terminated += 1,
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }

        while let Some(warm) = self.warm_workers.pop() {
            match warm.worker.terminate().await {
                Ok(_) => report.warm_workers_terminated += 1,
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }

        // Fire all exit watchers before terminating so receivers are notified.
        for (_session_id, tx) in self.interactive_exit_watchers.drain() {
            let _ = tx.send(());
        }

        for (_session_id, process) in self.interactive_sessions.drain() {
            match process.terminate().await {
                Ok(_) => report.interactive_sessions_terminated += 1,
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }

        if let Some(error) = first_error {
            return Err(error);
        }

        Ok(report)
    }

    /// Spawns a warm worker with a freshly-allocated `SessionId`.
    fn spawn_warm_worker(cfg: &Config) -> ServiceResult<WarmWorker> {
        let session_id = SessionId::new();
        let process_cfg = Self::worker_process_config_for_session(cfg, session_id);
        let worker = crate::process::RpcWorkerProcess::spawn(&process_cfg)?;
        Ok(WarmWorker { session_id, worker })
    }

    fn worker_process_config_for_session(
        cfg: &Config,
        session_id: SessionId,
    ) -> WorkerProcessConfig {
        WorkerProcessConfig {
            command: cfg.worker_command.clone(),
            args: cfg.worker_args.clone(),
            child_termination_deadline: cfg.child_termination_deadline,
            session_id,
            extension_sock_path: cfg.extension_sock_path.clone(),
            extension_path: cfg.extension_path.clone(),
            worker_cwd: cfg.worker_cwd.clone(),
        }
    }

    /// Builds a [`WorkerProcessConfig`] for a cwd-scoped dedicated worker,
    /// overriding the service-wide `worker_cwd` with the caller-supplied `cwd`.
    fn worker_process_config_for_cwd_session(
        cfg: &Config,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> WorkerProcessConfig {
        WorkerProcessConfig {
            worker_cwd: Some(cwd),
            ..Self::worker_process_config_for_session(cfg, session_id)
        }
    }

    fn total_process_count(&self) -> usize {
        self.warm_workers.len() + self.active_workers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn test_config(
        command: &str,
        args: &[&str],
        warm_pool_size: usize,
        max_processes: usize,
    ) -> Config {
        Config {
            worker_command: command.to_string(),
            worker_args: args.iter().map(|arg| arg.to_string()).collect(),
            warm_pool_size,
            max_processes,
            idle_reap_timeout: Duration::from_secs(30),
            command_buffer: 8,
            child_termination_deadline: Duration::from_millis(2000),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
        }
    }

    #[test]
    fn worker_process_config_carries_resolved_extension_path() {
        let extension_path = std::env::current_exe().expect("current executable should exist");
        let mut cfg = test_config("sh", &["-c", "exit 0"], 0, 1);
        cfg.extension_path = extension_path.clone();

        let process_cfg = SessionPool::worker_process_config_for_session(&cfg, SessionId::new());

        assert_eq!(process_cfg.extension_path, extension_path);
    }

    // AC-2 (T-121): the pool threads the configured service-wide worker cwd
    // into the per-worker spawn config used for warm-worker spawning.
    #[test]
    fn worker_process_config_carries_configured_worker_cwd() {
        let worker_cwd = std::path::PathBuf::from("/opt/bob/workspace");
        let mut cfg = test_config("sh", &["-c", "exit 0"], 0, 1);
        cfg.worker_cwd = Some(worker_cwd.clone());

        let process_cfg = SessionPool::worker_process_config_for_session(&cfg, SessionId::new());

        assert_eq!(process_cfg.worker_cwd, Some(worker_cwd));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pool_new_spawns_warm_workers_up_to_min_of_warm_pool_and_max_processes() {
        let cfg = test_config("sh", &["-c", "exit 0"], 3, 2);

        let pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        assert_eq!(
            pool.warm_worker_count(),
            2,
            "startup should cap warm workers at max_processes"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pool_new_returns_child_process_error_when_warm_worker_spawn_fails() {
        let cfg = test_config("__definitely_missing_pi_binary__", &["--mode", "rpc"], 2, 4);

        let error = SessionPool::new(&cfg).expect_err("pool startup should fail");

        assert!(
            matches!(error, ServiceError::ChildProcess { .. }),
            "expected ServiceError::ChildProcess, got: {error:?}"
        );
    }

    // AC-1/AC-4: warm worker is promoted to active using its pre-allocated session id.
    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_binds_idle_warm_worker_using_preallocated_session_id() {
        let cfg = test_config("sh", &["-c", "exit 0"], 1, 2);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");
        // Capture the warm worker's pre-allocated id before promoting it.
        let expected_session_id = pool.warm_workers[0].session_id;

        let returned_id = pool
            .acquire_session()
            .expect("acquiring first session should succeed");

        let sessions = pool.list_sessions();
        assert_eq!(
            pool.warm_worker_count(),
            0,
            "warm worker should be consumed"
        );
        assert_eq!(sessions.len(), 1, "one session should be active");
        assert_eq!(
            returned_id, expected_session_id,
            "acquire_session should return the warm worker's pre-allocated session id"
        );
        assert_eq!(
            sessions[0], expected_session_id,
            "active sessions list should use the pre-allocated session id"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_spawns_new_worker_when_no_warm_worker_exists() {
        let cfg = test_config("sh", &["-c", "exit 0"], 1, 2);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        let session_a = pool
            .acquire_session()
            .expect("first session should consume warm worker");
        let session_b = pool
            .acquire_session()
            .expect("second session should spawn new worker");

        let sessions = pool.list_sessions();
        assert_eq!(pool.warm_worker_count(), 0);
        assert_eq!(sessions.len(), 2);
        assert!(sessions.contains(&session_a));
        assert!(sessions.contains(&session_b));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_returns_child_process_when_max_processes_would_be_exceeded() {
        let cfg = test_config("sh", &["-c", "exit 0"], 1, 1);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        pool.acquire_session()
            .expect("first session should succeed");
        let error = pool
            .acquire_session()
            .expect_err("second session should fail at max capacity");

        assert!(matches!(error, ServiceError::ChildProcess { .. }));
    }

    // AC-1 (T-122): acquire_session_with_cwd must not consume a pre-spawned
    // warm worker even when one is available, because warm workers carry the
    // service-wide cwd and cannot be reused for a caller-supplied directory.
    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_with_cwd_does_not_consume_a_warm_worker() {
        let cfg = test_config("sh", &["-c", "exit 0"], 1, 2);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");
        assert_eq!(
            pool.warm_worker_count(),
            1,
            "test setup expects one pre-spawned warm worker"
        );

        let worker_cwd = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-dedicated-cwd-warm-check-{}",
            SessionId::new()
        ));
        std::fs::create_dir_all(&worker_cwd).expect("create dedicated cwd should succeed");

        pool.acquire_session_with_cwd(worker_cwd.clone())
            .expect("acquiring a cwd-scoped session should succeed");

        assert_eq!(
            pool.warm_worker_count(),
            1,
            "cwd-scoped acquisition must not consume the pre-spawned warm worker"
        );

        std::fs::remove_dir_all(&worker_cwd).ok();
    }

    // AC-1 (T-122): the dedicated worker actually runs in the caller-supplied
    // directory rather than the (unset) service-wide cwd.
    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_with_cwd_spawns_dedicated_worker_running_in_given_directory() {
        let worker_cwd = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-dedicated-cwd-{}",
            SessionId::new()
        ));
        std::fs::create_dir_all(&worker_cwd).expect("create dedicated cwd should succeed");

        let cfg = test_config("sh", &["-c", "pwd > marker.txt"], 0, 1);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        pool.acquire_session_with_cwd(worker_cwd.clone())
            .expect("acquiring a cwd-scoped session should succeed");

        let marker_path = worker_cwd.join("marker.txt");
        for _ in 0..100 {
            if marker_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let contents = std::fs::read_to_string(&marker_path)
            .expect("dedicated worker should have written the marker file in its cwd");
        let actual =
            std::fs::canonicalize(contents.trim()).expect("canonicalize actual reported cwd");
        let expected =
            std::fs::canonicalize(&worker_cwd).expect("canonicalize expected worker cwd");

        assert_eq!(
            actual, expected,
            "dedicated worker should run in the caller-supplied cwd"
        );

        std::fs::remove_dir_all(&worker_cwd).ok();
    }

    // AC-2 (T-122): when active + warm workers already fill max_processes, a
    // cwd-scoped acquisition must be refused without evicting the existing
    // warm worker or exceeding the bound.
    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_with_cwd_refuses_without_evicting_when_max_processes_is_full() {
        let cfg = test_config("sh", &["-c", "exit 0"], 1, 1);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");
        assert_eq!(
            pool.warm_worker_count(),
            1,
            "test setup expects the warm worker to already fill max_processes"
        );

        let worker_cwd = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-dedicated-cwd-refuse-{}",
            SessionId::new()
        ));
        std::fs::create_dir_all(&worker_cwd).expect("create dedicated cwd should succeed");

        let error = pool
            .acquire_session_with_cwd(worker_cwd.clone())
            .expect_err("cwd-scoped acquisition should be refused at max capacity");

        assert!(
            matches!(error, ServiceError::ChildProcess { .. }),
            "expected ServiceError::ChildProcess, got: {error:?}"
        );
        assert_eq!(
            pool.warm_worker_count(),
            1,
            "refused acquisition must not evict the existing warm worker"
        );
        assert_eq!(
            pool.list_sessions().len(),
            0,
            "refused acquisition must not create an active session"
        );

        std::fs::remove_dir_all(&worker_cwd).ok();
    }

    // AC-3 (T-122): while a cwd-scoped dedicated worker is active it counts
    // against max_processes, so a subsequent acquisition of any kind is
    // refused until the dedicated worker is removed (killed or reaped).
    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_with_cwd_counts_toward_max_processes_while_active() {
        let cfg = test_config(
            "sh",
            &["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
            0,
            1,
        );
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        let worker_cwd = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-dedicated-cwd-bound-{}",
            SessionId::new()
        ));
        std::fs::create_dir_all(&worker_cwd).expect("create dedicated cwd should succeed");

        pool.acquire_session_with_cwd(worker_cwd.clone())
            .expect("first cwd-scoped acquisition should succeed within max_processes");

        let error = pool
            .acquire_session()
            .expect_err("acquisition should be refused while dedicated worker fills max_processes");

        assert!(
            matches!(error, ServiceError::ChildProcess { .. }),
            "expected ServiceError::ChildProcess, got: {error:?}"
        );

        std::fs::remove_dir_all(&worker_cwd).ok();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reap_idle_and_surplus_terminates_surplus_warm_workers_above_configured_pool_size() {
        let cfg = test_config(
            "sh",
            &["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
            1,
            4,
        );
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        pool.warm_workers
            .push(SessionPool::spawn_warm_worker(&cfg).expect("spawn should work"));
        pool.warm_workers
            .push(SessionPool::spawn_warm_worker(&cfg).expect("spawn should work"));

        let report = pool
            .reap_idle_and_surplus()
            .await
            .expect("reap should succeed");

        assert_eq!(report.idle_sessions_reaped, 0);
        assert_eq!(report.warm_workers_reaped, 2);
        assert_eq!(pool.warm_worker_count(), 1);
    }

    // AC-2: list_sessions includes interactive session ids.
    #[tokio::test(flavor = "current_thread")]
    async fn list_sessions_includes_interactive_session_after_start() {
        use crate::process::InteractiveProcessConfig;
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let cfg = test_config("sh", &["-c", "exit 0"], 0, 4);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        let stdin_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stdout_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stderr_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();

        let interactive_cfg = InteractiveProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "trap 'exit 0' TERM; while :; do sleep 1; done".to_string(),
            ],
            child_termination_deadline: std::time::Duration::from_millis(2000),
            session_id: bob_core::types::SessionId::new(),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
        };

        let session_id = pool
            .start_interactive_session(interactive_cfg, stdin_fd, stdout_fd, stderr_fd)
            .expect("interactive session should start");

        let sessions = pool.list_sessions();

        assert!(
            sessions.contains(&session_id),
            "list_sessions must include the interactive session id"
        );
    }

    // AC-3: shutdown_all terminates interactive sessions.
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_all_terminates_interactive_sessions() {
        use crate::process::InteractiveProcessConfig;
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let pid_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-interactive-shutdown-{}.txt",
            bob_core::types::SessionId::new()
        ));
        let _ = std::fs::remove_file(&pid_file);
        let pid_file_path = pid_file.to_string_lossy().into_owned();

        let script = format!(
            "printf '%s\\n' $$ >> \"{}\"; trap '' TERM; while :; do :; done",
            pid_file_path
        );

        let cfg = test_config("sh", &["-c", "exit 0"], 0, 4);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        let stdin_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stdout_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stderr_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();

        let interactive_cfg = InteractiveProcessConfig {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), script],
            child_termination_deadline: std::time::Duration::from_millis(50),
            session_id: bob_core::types::SessionId::new(),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
        };

        pool.start_interactive_session(interactive_cfg, stdin_fd, stdout_fd, stderr_fd)
            .expect("interactive session should start");

        tokio::time::sleep(std::time::Duration::from_millis(30)).await;

        let report = pool.shutdown_all().await.expect("shutdown should succeed");

        assert!(
            report.interactive_sessions_terminated >= 1,
            "shutdown must terminate interactive sessions"
        );

        // Give child a moment to exit after force-kill, then check it is gone.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        if let Ok(content) = std::fs::read_to_string(&pid_file) {
            for line in content.lines() {
                let pid: i32 = line.parse().expect("pid should be numeric");
                let proc_path = format!("/proc/{pid}");
                assert!(
                    !std::path::Path::new(&proc_path).exists(),
                    "interactive worker pid {pid} should not exist after shutdown"
                );
            }
        }

        let _ = std::fs::remove_file(&pid_file);
    }
}
