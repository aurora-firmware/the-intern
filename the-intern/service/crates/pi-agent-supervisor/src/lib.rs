#![forbid(unsafe_code)]

pub mod pool;
pub mod process;
pub mod reaper;
pub mod rpc;

use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use std::time::Duration;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{self, MissedTickBehavior},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub worker_command: String,
    pub worker_args: Vec<String>,
    pub warm_pool_size: usize,
    pub max_processes: usize,
    pub idle_reap_timeout: Duration,
    pub command_buffer: usize,
    pub child_termination_deadline: Duration,
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
        }
    }
}

#[derive(Debug)]
enum Command {
    AcquireSession {
        session_id: SessionId,
        response_tx: oneshot::Sender<ServiceResult<()>>,
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
    pub async fn acquire_session(&self, session_id: SessionId) -> ServiceResult<()> {
        let (response_tx, response_rx) = oneshot::channel();
        self.tx
            .send(Command::AcquireSession {
                session_id,
                response_tx,
            })
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

        loop {
            tokio::select! {
                command = self.rx.recv() => {
                    let Some(command) = command else {
                        break;
                    };

                    match command {
                        Command::AcquireSession {
                            session_id,
                            response_tx,
                        } => {
                            tracing::debug!(
                                session_id = %session_id,
                                "pi-agent-supervisor acquire session command received"
                            );
                            let _ = response_tx.send(self.pool.acquire_session(session_id));
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
                    }
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
            child_termination_deadline: Duration::from_millis(50),
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
        let session_id = SessionId::new();

        handle
            .acquire_session(session_id)
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
        let session_id = SessionId::new();

        handle
            .acquire_session(session_id)
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
        let session_id = SessionId::new();

        handle
            .acquire_session(session_id)
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
            .acquire_session(SessionId::new())
            .await
            .expect("first session acquire should succeed");
        let error = handle
            .acquire_session(SessionId::new())
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
        let session_id = SessionId::new();
        handle
            .acquire_session(session_id)
            .await
            .expect("session should be active");

        let result = handle
            .send_prompt(session_id, "hello prompt".to_string())
            .await;

        assert!(result.is_ok());
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_prompt_acquires_missing_session_before_sending() {
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
        let session_id = SessionId::new();

        handle
            .send_prompt(session_id, "hello prompt".to_string())
            .await
            .expect("prompt routing should succeed");

        let sessions = handle
            .list_sessions()
            .await
            .expect("session listing should succeed");
        assert_eq!(sessions, vec![session_id]);
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
        let session_id = SessionId::new();

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
        let session_id = SessionId::new();

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
        };

        let (handle, task) = start(cfg).expect("startup should succeed");
        handle
            .acquire_session(SessionId::new())
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
}
