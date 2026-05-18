use bob_core::error::{ServiceError, ServiceResult};
use std::time::Duration;
use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerProcessConfig {
    pub command: String,
    pub args: Vec<String>,
    pub child_termination_deadline: Duration,
}

#[derive(Debug)]
pub struct RpcWorkerProcess {
    child: Child,
}

impl RpcWorkerProcess {
    pub fn spawn(cfg: &WorkerProcessConfig) -> ServiceResult<Self> {
        let child = Command::new(&cfg.command)
            .args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| ServiceError::ChildProcess {
                detail: format!(
                    "failed to spawn worker process for command '{}' ({error})",
                    cfg.command
                ),
            })?;

        Ok(Self { child })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat_worker_config() -> WorkerProcessConfig {
        WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            child_termination_deadline: Duration::from_millis(50),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_starts_configured_command_with_piped_stdio() {
        let worker = RpcWorkerProcess::spawn(&cat_worker_config()).expect("spawn should succeed");

        assert!(worker.child.stdin.is_some(), "stdin should be piped");
        assert!(worker.child.stdout.is_some(), "stdout should be piped");
        assert!(worker.child.stderr.is_some(), "stderr should be piped");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_failure_returns_child_process_error_with_safe_detail() {
        let config = WorkerProcessConfig {
            command: "__definitely_missing_pi_binary__".to_string(),
            args: vec!["--mode".to_string(), "rpc".to_string()],
            child_termination_deadline: Duration::from_millis(25),
        };

        let error = RpcWorkerProcess::spawn(&config).expect_err("spawn should fail");

        assert!(
            matches!(error, ServiceError::ChildProcess { ref detail } if detail.contains("failed to spawn worker process")),
            "expected ServiceError::ChildProcess with safe detail, got: {error:?}"
        );
    }
}
