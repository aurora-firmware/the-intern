#![forbid(unsafe_code)]

use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use std::time::Duration;
use tokio::{sync::mpsc, task::JoinHandle};

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
    ListSessions,
    KillSession(SessionId),
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Command>,
}

pub struct Actor {
    cfg: Config,
    rx: mpsc::Receiver<Command>,
}

impl Handle {
    pub async fn list_sessions(&self) -> ServiceResult<Vec<SessionId>> {
        let _ = self.tx.send(Command::ListSessions).await;
        Ok(Vec::new())
    }

    pub async fn kill_session(&self, session_id: SessionId) -> ServiceResult<()> {
        let _ = self.tx.send(Command::KillSession(session_id)).await;
        Err(ServiceError::NotImplemented)
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
                Command::ListSessions => {
                    tracing::debug!("pi-agent-supervisor list sessions command received");
                }
                Command::KillSession(session_id) => {
                    tracing::debug!(
                        session_id = %session_id,
                        "pi-agent-supervisor kill session command received"
                    );
                }
            }
        }
        tracing::info!("pi-agent-supervisor actor stopped");
    }
}

pub fn start(cfg: Config) -> (Handle, JoinHandle<()>) {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let actor = Actor { cfg, rx };
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    (Handle { tx }, join)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bob_core::error::ServiceError;
    use std::time::Duration;

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
        let (handle, task) = start(Config::default());

        let result = handle.list_sessions().await;

        assert!(matches!(result, Ok(sessions) if sessions.is_empty()));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn kill_session_returns_not_implemented() {
        let (handle, task) = start(Config::default());

        let result = handle.kill_session(SessionId::new()).await;

        assert!(matches!(result, Err(ServiceError::NotImplemented)));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, task) = start(Config::default());

        let _clone = handle.clone();

        task.abort();
    }
}
