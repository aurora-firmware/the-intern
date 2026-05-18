use crate::{process::WorkerProcessConfig, Config};
use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use std::collections::HashMap;

#[derive(Debug)]
pub struct SessionPool {
    cfg: Config,
    warm_workers: Vec<crate::process::RpcWorkerProcess>,
    active_workers: HashMap<SessionId, crate::process::RpcWorkerProcess>,
}

impl SessionPool {
    pub fn new(cfg: &Config) -> ServiceResult<Self> {
        let mut warm_workers = Vec::new();
        let warm_target = cfg.warm_pool_size.min(cfg.max_processes);
        let process_cfg = Self::worker_process_config(cfg);

        for _ in 0..warm_target {
            warm_workers.push(crate::process::RpcWorkerProcess::spawn(&process_cfg)?);
        }

        Ok(Self {
            cfg: cfg.clone(),
            warm_workers,
            active_workers: HashMap::new(),
        })
    }

    pub fn acquire_session(&mut self, _session_id: SessionId) -> ServiceResult<()> {
        Err(ServiceError::NotImplemented)
    }

    pub fn list_sessions(&self) -> Vec<SessionId> {
        Vec::new()
    }

    pub fn warm_worker_count(&self) -> usize {
        self.warm_workers.len()
    }

    fn worker_process_config(cfg: &Config) -> WorkerProcessConfig {
        WorkerProcessConfig {
            command: cfg.worker_command.clone(),
            args: cfg.worker_args.clone(),
            child_termination_deadline: cfg.child_termination_deadline,
        }
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
            child_termination_deadline: Duration::from_millis(50),
        }
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
}
