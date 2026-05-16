#![forbid(unsafe_code)]

use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub command_buffer: usize,
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
            command_buffer = self.cfg.command_buffer,
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
