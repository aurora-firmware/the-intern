#![forbid(unsafe_code)]

use bob_core::error::{ServiceError, ServiceResult};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub command_buffer: usize,
}

#[derive(Debug)]
enum Command {
    Evaluate(String),
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
    pub async fn evaluate_policy(&self, request_id: impl Into<String>) -> ServiceResult<()> {
        let _ = self.tx.send(Command::Evaluate(request_id.into())).await;
        Err(ServiceError::NotImplemented)
    }
}

impl Actor {
    async fn run(mut self) {
        tracing::info!(
            command_buffer = self.cfg.command_buffer,
            "policy-control actor started"
        );
        while let Some(command) = self.rx.recv().await {
            match command {
                Command::Evaluate(request_id) => {
                    tracing::debug!(
                        request_id_len = request_id.len(),
                        "policy-control command received"
                    );
                }
            }
        }
        tracing::info!("policy-control actor stopped");
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
    async fn evaluate_policy_returns_not_implemented() {
        let (handle, task) = start(Config::default());

        let result = handle.evaluate_policy("req-1").await;

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
