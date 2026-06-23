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
use tokio::time::Instant;

#[derive(Debug)]
struct ActiveSessionWorker {
    worker: crate::process::RpcWorkerProcess,
    last_prompt_activity: Instant,
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

        self.active_workers.insert(
            session_id,
            ActiveSessionWorker {
                worker,
                last_prompt_activity: Instant::now(),
            },
        );
        Ok(session_id)
    }

    pub fn list_sessions(&self) -> Vec<SessionId> {
        self.active_workers
            .keys()
            .copied()
            .chain(self.interactive_sessions.keys().copied())
            .collect()
    }

    pub async fn kill_session(&mut self, session_id: SessionId) -> ServiceResult<()> {
        let worker = self.active_workers.remove(&session_id).ok_or_else(|| {
            ServiceError::InvalidRequest {
                detail: "session is not active".to_string(),
            }
        })?;

        worker.worker.terminate().await?;
        Ok(())
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
            if let Some(worker) = self.active_workers.remove(&session_id) {
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

        for (_session_id, worker) in self.active_workers.drain() {
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
