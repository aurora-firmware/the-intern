#![forbid(unsafe_code)]

pub mod pool;
pub mod process;
pub mod rpc;

use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use std::time::Duration;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
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
        while let Some(command) = self.rx.recv().await {
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
                    let _ = response_tx.send(Err(ServiceError::NotImplemented));
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
    async fn kill_session_returns_not_implemented() {
        let (handle, task) =
            start(test_config("sh", &["-c", "exit 0"], 1, 2)).expect("startup should succeed");

        let result = handle.kill_session(SessionId::new()).await;

        assert!(matches!(result, Err(ServiceError::NotImplemented)));
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
}
