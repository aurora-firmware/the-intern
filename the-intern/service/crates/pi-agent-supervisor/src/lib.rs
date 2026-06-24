#![forbid(unsafe_code)]

pub mod pool;
pub mod process;
pub mod reaper;
pub mod rpc;

use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use std::os::unix::io::OwnedFd;
use std::path::PathBuf;
use std::time::Duration;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{self, MissedTickBehavior},
};

const INTERACTIVE_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub worker_command: String,
    pub worker_args: Vec<String>,
    pub warm_pool_size: usize,
    pub max_processes: usize,
    pub idle_reap_timeout: Duration,
    pub command_buffer: usize,
    pub child_termination_deadline: Duration,
    /// Absolute path to the extension socket passed to each child as
    /// `BOB_EXTENSION_SOCK_PATH`.  An empty path means the variable is not set.
    pub extension_sock_path: PathBuf,
    /// Resolved path to the pi extension that enforces tool-call authorization.
    pub extension_path: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            worker_command: "pi".to_string(),
            worker_args: vec!["--mode".to_string(), "rpc".to_string()],
            warm_pool_size: 1,
            max_processes: 8,
            idle_reap_timeout: Duration::from_secs(300),
            command_buffer: 64,
            child_termination_deadline: Duration::from_secs(10),
            extension_sock_path: PathBuf::new(),
            extension_path: PathBuf::new(),
        }
    }
}

#[derive(Debug)]
enum Command {
    AcquireSession {
        response_tx: oneshot::Sender<ServiceResult<SessionId>>,
    },
    ListSessions {
        response_tx: oneshot::Sender<ServiceResult<Vec<SessionId>>>,
    },
    KillSession {
        session_id: SessionId,
        response_tx: oneshot::Sender<ServiceResult<()>>,
    },
    SendPrompt {
        session_id: SessionId,
        message: String,
        response_tx: oneshot::Sender<ServiceResult<()>>,
    },
    StartInteractiveSession {
        command: String,
        args: Vec<String>,
        child_termination_deadline: Duration,
        session_id: SessionId,
        extension_sock_path: PathBuf,
        extension_path: PathBuf,
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: OwnedFd,
        response_tx: oneshot::Sender<ServiceResult<SessionId>>,
    },
    /// Subscribe to the exit event of an interactive session.
    ///
    /// The actor retains the session in the pool so it remains killable and
    /// sends the caller a [`oneshot::Receiver`] that fires when the dedicated
    /// interactive-exit poll detects that the child has exited.
    ///
    /// Returns `ServiceError::InvalidRequest` if no interactive session with
    /// the given id exists.
    WatchInteractiveSessionExit {
        session_id: SessionId,
        response_tx: oneshot::Sender<ServiceResult<oneshot::Receiver<()>>>,
    },
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Command>,
}

pub struct Actor {
    cfg: Config,
    pool: pool::SessionPool,
    rx: mpsc::Receiver<Command>,
}

impl Handle {
    /// Acquires a worker for a new session.
    ///
    /// Returns the `SessionId` that was allocated for the session.  For warm
    /// workers this is the id that was pre-allocated at spawn time and set as
    /// `BOB_SESSION_ID` on the child process.  Callers must use the returned id
    /// for all subsequent operations (`send_prompt`, `kill_session`, etc.).
    pub async fn acquire_session(&self) -> ServiceResult<SessionId> {
        let (response_tx, response_rx) = oneshot::channel();
        self.tx
            .send(Command::AcquireSession { response_tx })
            .await
            .map_err(|_| ServiceError::Shutdown)?;

        response_rx.await.map_err(|_| ServiceError::Shutdown)?
    }

    pub async fn list_sessions(&self) -> ServiceResult<Vec<SessionId>> {
        let (response_tx, response_rx) = oneshot::channel();
        self.tx
            .send(Command::ListSessions { response_tx })
            .await
            .map_err(|_| ServiceError::Shutdown)?;

        response_rx.await.map_err(|_| ServiceError::Shutdown)?
    }

    pub async fn kill_session(&self, session_id: SessionId) -> ServiceResult<()> {
        let (response_tx, response_rx) = oneshot::channel();
        self.tx
            .send(Command::KillSession {
                session_id,
                response_tx,
            })
            .await
            .map_err(|_| ServiceError::Shutdown)?;

        response_rx.await.map_err(|_| ServiceError::Shutdown)?
    }

    pub async fn send_prompt(&self, session_id: SessionId, message: String) -> ServiceResult<()> {
        let (response_tx, response_rx) = oneshot::channel();
        self.tx
            .send(Command::SendPrompt {
                session_id,
                message,
                response_tx,
            })
            .await
            .map_err(|_| ServiceError::Shutdown)?;

        response_rx.await.map_err(|_| ServiceError::Shutdown)?
    }

    /// Subscribes to the exit event of a running interactive session.
    ///
    /// The actor retains the session in the pool so it remains killable. The
    /// caller receives a [`oneshot::Receiver<()>`] that resolves when the
    /// dedicated interactive-exit poll detects a natural exit or after
    /// `kill_session` terminates the child.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::InvalidRequest` if no interactive session with
    /// `session_id` is currently tracked, or `ServiceError::Shutdown` if the
    /// actor has already stopped.
    pub async fn watch_interactive_session_exit(
        &self,
        session_id: SessionId,
    ) -> ServiceResult<oneshot::Receiver<()>> {
        let (response_tx, response_rx) = oneshot::channel();
        self.tx
            .send(Command::WatchInteractiveSessionExit {
                session_id,
                response_tx,
            })
            .await
            .map_err(|_| ServiceError::Shutdown)?;
        response_rx.await.map_err(|_| ServiceError::Shutdown)?
    }

    /// Starts a supervised interactive pi session on the supplied terminal fds.
    ///
    /// The three `OwnedFd` arguments are the client's stdio file descriptors,
    /// typically received via `SCM_RIGHTS` over `admin.sock` (ADR-011).
    /// The session is tracked in the session table and appears in
    /// `list_sessions` immediately.  It is terminated on actor shutdown.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::ChildProcess` if the extension file is missing or
    /// if the OS rejects the spawn, or `ServiceError::Shutdown` if the actor
    /// has already stopped.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_interactive_session(
        &self,
        command: String,
        args: Vec<String>,
        child_termination_deadline: Duration,
        session_id: SessionId,
        extension_sock_path: PathBuf,
        extension_path: PathBuf,
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: OwnedFd,
    ) -> ServiceResult<SessionId> {
        let (response_tx, response_rx) = oneshot::channel();
        self.tx
            .send(Command::StartInteractiveSession {
                command,
                args,
                child_termination_deadline,
                session_id,
                extension_sock_path,
                extension_path,
                stdin,
                stdout,
                stderr,
                response_tx,
            })
            .await
            .map_err(|_| ServiceError::Shutdown)?;

        response_rx.await.map_err(|_| ServiceError::Shutdown)?
    }
}

impl Actor {
    async fn run(mut self) {
        tracing::info!(
            worker_command = %self.cfg.worker_command,
            worker_args = ?self.cfg.worker_args,
            warm_pool_size = self.cfg.warm_pool_size,
            max_processes = self.cfg.max_processes,
            idle_reap_timeout = ?self.cfg.idle_reap_timeout,
            command_buffer = self.cfg.command_buffer,
            child_termination_deadline = ?self.cfg.child_termination_deadline,
            "pi-agent-supervisor actor started"
        );
        let mut reap_tick =
            time::interval(self.cfg.idle_reap_timeout.max(Duration::from_millis(1)));
        reap_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut interactive_exit_tick = time::interval(INTERACTIVE_EXIT_POLL_INTERVAL);
        interactive_exit_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                command = self.rx.recv() => {
                    let Some(command) = command else {
                        break;
                    };

                    match command {
                        Command::AcquireSession { response_tx } => {
                            tracing::debug!(
                                "pi-agent-supervisor acquire session command received"
                            );
                            let result = self.pool.acquire_session();
                            if let Ok(session_id) = &result {
                                tracing::debug!(
                                    session_id = %session_id,
                                    "pi-agent-supervisor session acquired"
                                );
                            }
                            let _ = response_tx.send(result);
                        }
                        Command::ListSessions { response_tx } => {
                            tracing::debug!("pi-agent-supervisor list sessions command received");
                            let _ = response_tx.send(Ok(self.pool.list_sessions()));
                        }
                        Command::KillSession {
                            session_id,
                            response_tx,
                        } => {
                            tracing::debug!(
                                session_id = %session_id,
                                "pi-agent-supervisor kill session command received"
                            );
                            let _ = response_tx.send(self.pool.kill_session(session_id).await);
                        }
                        Command::SendPrompt {
                            session_id,
                            message,
                            response_tx,
                        } => {
                            tracing::debug!(
                                session_id = %session_id,
                                message_len = message.len(),
                                "pi-agent-supervisor send prompt command received"
                            );
                            let _ = response_tx.send(self.pool.send_prompt(session_id, message).await);
                        }
                        Command::WatchInteractiveSessionExit {
                            session_id,
                            response_tx,
                        } => {
                            tracing::debug!(
                                session_id = %session_id,
                                "pi-agent-supervisor watch interactive session exit command received"
                            );
                            // Register a watcher WITHOUT taking the process from the pool.
                            // The process stays in `interactive_sessions` so `kill_session`
                            // can still terminate it (AC-3). The dedicated interactive
                            // exit tick polls `try_poll_exit()` and fires the sender when
                            // the child exits naturally (AC-2).
                            let (exit_tx, exit_rx) = oneshot::channel::<()>();
                            match self.pool.register_interactive_exit_watcher(session_id, exit_tx) {
                                Ok(()) => {
                                    let _ = response_tx.send(Ok(exit_rx));
                                }
                                Err(()) => {
                                    let _ = response_tx.send(Err(ServiceError::InvalidRequest {
                                        detail: format!(
                                            "no interactive session with id {session_id}"
                                        ),
                                    }));
                                }
                            }
                        }
                        Command::StartInteractiveSession {
                            command,
                            args,
                            child_termination_deadline,
                            session_id,
                            extension_sock_path,
                            extension_path,
                            stdin,
                            stdout,
                            stderr,
                            response_tx,
                        } => {
                            tracing::debug!(
                                session_id = %session_id,
                                "pi-agent-supervisor start interactive session command received"
                            );
                            let cfg = process::InteractiveProcessConfig {
                                command,
                                args,
                                child_termination_deadline,
                                session_id,
                                extension_sock_path,
                                extension_path,
                            };
                            let result =
                                self.pool.start_interactive_session(cfg, stdin, stdout, stderr);
                            if let Ok(id) = &result {
                                tracing::debug!(
                                    session_id = %id,
                                    "pi-agent-supervisor interactive session started"
                                );
                            }
                            let _ = response_tx.send(result);
                        }
                    }
                }
                _ = interactive_exit_tick.tick() => {
                    self.pool.poll_interactive_exits();
                }
                _ = reap_tick.tick() => {
                    match self.pool.reap_idle_and_surplus().await {
                        Ok(report) if report.total_reaped() > 0 => {
                            tracing::info!(
                                idle_sessions_reaped = report.idle_sessions_reaped,
                                warm_workers_reaped = report.warm_workers_reaped,
                                "pi-agent-supervisor reap tick removed workers"
                            );
                        }
                        Ok(_) => {}
                        Err(error) => {
                            tracing::warn!(error = ?error, "pi-agent-supervisor reap tick failed");
                        }
                    }
                }
            }
        }

        if let Err(error) = self.pool.shutdown_all().await {
            tracing::warn!(
                error = ?error,
                "pi-agent-supervisor failed to terminate all workers during shutdown"
            );
        }
        tracing::info!("pi-agent-supervisor actor stopped");
    }
}

pub fn start(cfg: Config) -> ServiceResult<(Handle, JoinHandle<()>)> {
    let pool = pool::SessionPool::new(&cfg)?;
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let actor = Actor { cfg, pool, rx };
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    Ok((Handle { tx }, join))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bob_core::error::ServiceError;
    use std::{fs, time::Duration};

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
            idle_reap_timeout: Duration::from_secs(60),
            command_buffer: 16,
            child_termination_deadline: Duration::from_millis(2000),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
        }
    }

    #[test]
    fn default_config_sets_pi_rpc_and_positive_pool_settings() {
        let cfg = Config::default();

        assert_eq!(cfg.worker_command, "pi");
        assert_eq!(
            cfg.worker_args,
            vec!["--mode".to_string(), "rpc".to_string()]
        );
        assert!(cfg.warm_pool_size > 0);
        assert!(cfg.max_processes > 0);
        assert!(cfg.idle_reap_timeout > Duration::from_secs(0));
        assert!(cfg.child_termination_deadline > Duration::from_secs(0));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_sessions_returns_empty_when_no_sessions() {
        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 1, 2)).expect("startup should succeed");

        let result = handle.list_sessions().await;

        assert!(matches!(result, Ok(sessions) if sessions.is_empty()));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn kill_session_terminates_active_session_and_removes_it_from_list() {
        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 1, 2)).expect("startup should succeed");

        let session_id = handle
            .acquire_session()
            .await
            .expect("session should be acquired");
        let result = handle.kill_session(session_id).await;
        let sessions = handle
            .list_sessions()
            .await
            .expect("listing sessions should succeed");

        assert!(result.is_ok());
        assert!(sessions.is_empty(), "killed session should be removed");
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn kill_session_returns_invalid_request_for_unknown_session() {
        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 1, 2)).expect("startup should succeed");

        let result = handle.kill_session(SessionId::new()).await;

        assert!(
            matches!(result, Err(ServiceError::InvalidRequest { .. })),
            "expected invalid request for unknown session, got {result:?}"
        );
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 1, 2)).expect("startup should succeed");

        let _clone = handle.clone();

        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_sessions_returns_bound_session_ids() {
        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 1, 2)).expect("startup should succeed");

        let session_id = handle
            .acquire_session()
            .await
            .expect("session acquire should succeed");
        let sessions = handle
            .list_sessions()
            .await
            .expect("list sessions should succeed");

        assert_eq!(sessions, vec![session_id]);
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn idle_reaper_removes_session_after_idle_timeout_without_prompt_activity() {
        let mut cfg = test_config(
            "sh",
            &["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
            1,
            1,
        );
        cfg.idle_reap_timeout = Duration::from_millis(40);
        let (handle, task) = start(cfg).expect("startup should succeed");

        handle
            .acquire_session()
            .await
            .expect("session acquire should succeed");

        tokio::time::sleep(Duration::from_millis(180)).await;

        let sessions = handle
            .list_sessions()
            .await
            .expect("list sessions should succeed");

        assert!(
            sessions.is_empty(),
            "idle reaper should remove sessions without prompt activity"
        );
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_returns_child_process_error_when_max_processes_reached() {
        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 1, 1)).expect("startup should succeed");

        handle
            .acquire_session()
            .await
            .expect("first session acquire should succeed");
        let error = handle
            .acquire_session()
            .await
            .expect_err("second session should fail at max capacity");

        assert!(matches!(error, ServiceError::ChildProcess { .. }));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn start_returns_child_process_error_when_warm_pool_cannot_spawn() {
        let error = match start(test_config(
            "__definitely_missing_pi_binary__",
            &["--mode", "rpc"],
            1,
            2,
        )) {
            Ok(_) => panic!("startup should fail when warm pool cannot spawn"),
            Err(error) => error,
        };

        assert!(matches!(error, ServiceError::ChildProcess { .. }));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_prompt_returns_ok_for_active_session_on_success_response() {
        let (handle, task) = start(test_config(
            "sh",
            &[
                "-c",
                "while IFS= read -r line; do id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; done",
            ],
            1,
            2,
        ))
        .expect("startup should succeed");
        let session_id = handle
            .acquire_session()
            .await
            .expect("session should be active");

        let result = handle
            .send_prompt(session_id, "hello prompt".to_string())
            .await;

        assert!(result.is_ok());
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_prompt_returns_child_process_error_when_session_not_yet_acquired() {
        let (handle, task) = start(test_config(
            "sh",
            &[
                "-c",
                "while IFS= read -r line; do id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; done",
            ],
            0,
            1,
        ))
        .expect("startup should succeed");

        // send_prompt no longer implicitly acquires; callers must call acquire_session first.
        let unknown_session = SessionId::new();
        let result = handle
            .send_prompt(unknown_session, "hello prompt".to_string())
            .await;

        assert!(
            matches!(result, Err(ServiceError::ChildProcess { .. })),
            "send_prompt to an unacquired session should return ChildProcess error, got {result:?}"
        );
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_prompt_returns_child_process_error_on_unsuccessful_response() {
        let (handle, task) = start(test_config(
            "sh",
            &[
                "-c",
                "while IFS= read -r line; do id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":false}\\n' \"$id\"; done",
            ],
            1,
            2,
        ))
        .expect("startup should succeed");
        let session_id = handle
            .acquire_session()
            .await
            .expect("session acquire should succeed");

        let result = handle
            .send_prompt(session_id, "hello prompt".to_string())
            .await;

        assert!(matches!(result, Err(ServiceError::ChildProcess { .. })));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_prompt_keeps_session_available_when_events_follow_success_response() {
        let (handle, task) = start(test_config(
            "sh",
            &[
                "-c",
                "while IFS= read -r line; do id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; printf '{\"type\":\"event\",\"name\":\"progress\"}\\n'; done",
            ],
            1,
            2,
        ))
        .expect("startup should succeed");
        let session_id = handle
            .acquire_session()
            .await
            .expect("session acquire should succeed");

        handle
            .send_prompt(session_id, "first".to_string())
            .await
            .expect("first prompt should succeed");
        handle
            .send_prompt(session_id, "second".to_string())
            .await
            .expect("second prompt should succeed");

        let sessions = handle
            .list_sessions()
            .await
            .expect("session listing should succeed");
        assert_eq!(sessions, vec![session_id]);
        task.abort();
    }

    // AC-1/AC-2: start_interactive_session spawns the child and exposes its id via list_sessions.
    #[tokio::test(flavor = "current_thread")]
    async fn start_interactive_session_returns_session_id_visible_in_list_sessions() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 0, 4)).expect("startup should succeed");

        let stdin_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stdout_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stderr_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();

        let session_id = handle
            .start_interactive_session(
                "sh".to_string(),
                vec![
                    "-c".to_string(),
                    "trap 'exit 0' TERM; while :; do sleep 1; done".to_string(),
                ],
                Duration::from_millis(2000),
                SessionId::new(),
                std::path::PathBuf::new(),
                std::env::current_exe().expect("current executable should exist"),
                stdin_fd,
                stdout_fd,
                stderr_fd,
            )
            .await
            .expect("interactive session should start");

        let sessions = handle
            .list_sessions()
            .await
            .expect("list sessions should succeed");

        assert!(
            sessions.contains(&session_id),
            "list_sessions must include the interactive session id; got {sessions:?}"
        );

        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn interactive_exit_watcher_is_not_delayed_by_idle_reap_timeout() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let mut cfg = test_config("sh", &["-c", "exit 0"], 0, 4);
        cfg.idle_reap_timeout = Duration::from_secs(60);
        let (handle, task) = start(cfg).expect("startup should succeed");

        // Let the idle interval's immediate first tick complete before the
        // interactive child starts, so this test exercises later exit polling.
        tokio::time::sleep(Duration::from_millis(20)).await;

        let stdin_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stdout_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stderr_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let session_id = handle
            .start_interactive_session(
                "sh".to_string(),
                vec!["-c".to_string(), "exit 0".to_string()],
                Duration::from_secs(2),
                SessionId::new(),
                std::path::PathBuf::new(),
                std::env::current_exe().expect("current executable should exist"),
                stdin_fd,
                stdout_fd,
                stderr_fd,
            )
            .await
            .expect("interactive session should start");
        let exit_rx = handle
            .watch_interactive_session_exit(session_id)
            .await
            .expect("interactive exit watcher should register");

        tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .expect("natural exit notification must not wait for idle reaping")
            .expect("interactive exit watcher sender should fire");

        task.abort();
    }

    // AC-3: actor shutdown terminates interactive sessions.
    #[tokio::test(flavor = "current_thread")]
    async fn actor_shutdown_terminates_interactive_sessions() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let pid_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-interactive-actor-shutdown-{}.txt",
            SessionId::new()
        ));
        let _ = fs::remove_file(&pid_file);
        let pid_file_path = pid_file.to_string_lossy().into_owned();

        let script = format!(
            "printf '%s\\n' $$ >> \"{}\"; trap '' TERM; while :; do :; done",
            pid_file_path
        );

        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 0, 4)).expect("startup should succeed");

        let stdin_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stdout_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stderr_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();

        handle
            .start_interactive_session(
                "sh".to_string(),
                vec!["-c".to_string(), script],
                Duration::from_millis(50),
                SessionId::new(),
                std::path::PathBuf::new(),
                std::env::current_exe().expect("current executable should exist"),
                stdin_fd,
                stdout_fd,
                stderr_fd,
            )
            .await
            .expect("interactive session should start");

        tokio::time::sleep(Duration::from_millis(30)).await;

        drop(handle);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("actor should stop after handle drop")
            .expect("actor join should succeed");

        let started = fs::read_to_string(&pid_file).expect("pid file should exist");
        let pids: Vec<i32> = started
            .lines()
            .map(|line| {
                line.parse::<i32>()
                    .expect("pid file should contain numeric pids")
            })
            .collect();

        assert!(
            !pids.is_empty(),
            "interactive child should have written a pid"
        );
        for pid in pids {
            let proc_path = format!("/proc/{pid}");
            assert!(
                !std::path::Path::new(&proc_path).exists(),
                "interactive worker pid {pid} should not exist after actor shutdown"
            );
        }

        let _ = fs::remove_file(&pid_file);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn actor_shutdown_terminates_active_and_warm_worker_processes() {
        let pid_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-shutdown-pids-{}.log",
            SessionId::new()
        ));
        let _ = fs::remove_file(&pid_file);
        let pid_file_path = pid_file.to_string_lossy();
        let shutdown_script = format!(
            "printf \"%s\\n\" $$ >> \"{}\"; trap '' TERM; while :; do :; done",
            pid_file_path
        );

        let cfg = Config {
            worker_command: "sh".to_string(),
            worker_args: vec!["-c".to_string(), shutdown_script],
            warm_pool_size: 2,
            max_processes: 2,
            idle_reap_timeout: Duration::from_secs(60),
            command_buffer: 8,
            child_termination_deadline: Duration::from_millis(25),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
        };

        let (handle, task) = start(cfg).expect("startup should succeed");
        handle
            .acquire_session()
            .await
            .expect("session acquire should succeed");
        tokio::time::sleep(Duration::from_millis(20)).await;

        drop(handle);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("actor should stop after handle drop")
            .expect("actor join should succeed");

        let started = fs::read_to_string(&pid_file).expect("pid file should exist");
        let pids: Vec<i32> = started
            .lines()
            .map(|line| {
                line.parse::<i32>()
                    .expect("pid file should contain numeric pids")
            })
            .collect();
        assert_eq!(
            pids.len(),
            2,
            "shutdown should terminate one active and one warm worker"
        );
        for pid in pids {
            let proc_path = format!("/proc/{pid}");
            assert!(
                !std::path::Path::new(&proc_path).exists(),
                "worker pid {pid} should not exist after actor shutdown"
            );
        }

        let _ = fs::remove_file(pid_file);
    }

    // AC-4: sessions.list reports the same id that is set as BOB_SESSION_ID on the
    // worker process.  The sh child writes its BOB_SESSION_ID to a temp file on
    // startup; we compare that against the id returned by list_sessions.
    #[tokio::test(flavor = "current_thread")]
    async fn sessions_list_reports_same_id_as_bob_session_id_env_on_worker_process() {
        let id_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-session-id-{}.txt",
            SessionId::new()
        ));
        let _ = fs::remove_file(&id_file);
        let id_file_path = id_file.to_string_lossy().into_owned();

        // Worker script: write BOB_SESSION_ID to a file, then loop to stay alive.
        let worker_script = format!(
            "printf '%s\\n' \"$BOB_SESSION_ID\" > \"{}\"; trap 'exit 0' TERM; while :; do sleep 0.1; done",
            id_file_path
        );

        let (handle, task) = start(test_config("sh", &["-c", &worker_script], 1, 1))
            .expect("startup should succeed");

        // Acquire a session — the warm worker is promoted.
        let session_id = handle
            .acquire_session()
            .await
            .expect("acquire should succeed");

        // Give the worker a moment to write the file.
        tokio::time::sleep(Duration::from_millis(100)).await;

        // sessions.list must return the same id that is set as BOB_SESSION_ID.
        let sessions = handle
            .list_sessions()
            .await
            .expect("list sessions should succeed");
        assert_eq!(
            sessions,
            vec![session_id],
            "sessions.list should return the acquired session id"
        );

        let written = fs::read_to_string(&id_file)
            .expect("worker should have written BOB_SESSION_ID to file");
        let written_id = written.trim().to_string();

        assert_eq!(
            session_id.to_string(),
            written_id,
            "sessions.list session id must equal BOB_SESSION_ID set on the worker process"
        );

        task.abort();
        let _ = fs::remove_file(id_file);
    }

    // AC-2: when extension_sock_path is non-empty, BOB_EXTENSION_SOCK_PATH is set on the worker.
    #[tokio::test(flavor = "current_thread")]
    async fn extension_sock_path_is_propagated_to_worker_process_environment() {
        let id_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-ext-path-{}.txt",
            SessionId::new()
        ));
        let _ = fs::remove_file(&id_file);
        let id_file_path = id_file.to_string_lossy().into_owned();
        let sock_path = std::path::PathBuf::from("/run/bob/extension.sock");

        let worker_script = format!(
            "printf '%s\\n' \"$BOB_EXTENSION_SOCK_PATH\" > \"{}\"; trap 'exit 0' TERM; while :; do sleep 0.1; done",
            id_file_path
        );

        let mut cfg = test_config("sh", &["-c", &worker_script], 1, 1);
        cfg.extension_sock_path = sock_path.clone();

        let (handle, task) = start(cfg).expect("startup should succeed");
        handle
            .acquire_session()
            .await
            .expect("acquire should succeed");

        tokio::time::sleep(Duration::from_millis(100)).await;

        let written = fs::read_to_string(&id_file)
            .expect("worker should have written BOB_EXTENSION_SOCK_PATH to file");
        let written_path = written.trim().to_string();

        assert_eq!(
            written_path,
            sock_path.to_string_lossy(),
            "BOB_EXTENSION_SOCK_PATH on worker must match configured extension_sock_path"
        );

        task.abort();
        let _ = fs::remove_file(id_file);
    }

    // AC-3: when extension_sock_path is empty, BOB_EXTENSION_SOCK_PATH is NOT set.
    #[tokio::test(flavor = "current_thread")]
    async fn empty_extension_sock_path_does_not_set_bob_extension_sock_path_on_worker() {
        let id_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-ext-path-absent-{}.txt",
            SessionId::new()
        ));
        let _ = fs::remove_file(&id_file);
        let id_file_path = id_file.to_string_lossy().into_owned();

        // Write "unset" if BOB_EXTENSION_SOCK_PATH is absent, "set:<value>" if present.
        let worker_script = format!(
            "if [ -z \"${{BOB_EXTENSION_SOCK_PATH+x}}\" ]; then printf 'unset\\n' > \"{0}\"; else printf 'set:%s\\n' \"$BOB_EXTENSION_SOCK_PATH\" > \"{0}\"; fi; trap 'exit 0' TERM; while :; do sleep 0.1; done",
            id_file_path
        );

        // extension_sock_path is empty (the default).
        let cfg = test_config("sh", &["-c", &worker_script], 1, 1);

        let (handle, task) = start(cfg).expect("startup should succeed");
        handle
            .acquire_session()
            .await
            .expect("acquire should succeed");

        tokio::time::sleep(Duration::from_millis(100)).await;

        let written =
            fs::read_to_string(&id_file).expect("worker should have written result to file");
        let result = written.trim().to_string();

        assert_eq!(
            result, "unset",
            "BOB_EXTENSION_SOCK_PATH should not be set on worker when extension_sock_path is empty"
        );

        task.abort();
        let _ = fs::remove_file(id_file);
    }
}
