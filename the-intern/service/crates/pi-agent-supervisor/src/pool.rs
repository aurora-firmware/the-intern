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

    pub fn acquire_session(&mut self, session_id: SessionId) -> ServiceResult<()> {
        if self.active_workers.contains_key(&session_id) {
            return Ok(());
        }

        let worker = if let Some(worker) = self.warm_workers.pop() {
            worker
        } else if self.total_process_count() < self.cfg.max_processes {
            let process_cfg = Self::worker_process_config(&self.cfg);
            crate::process::RpcWorkerProcess::spawn(&process_cfg)?
        } else {
            return Err(ServiceError::ChildProcess {
                detail: format!(
                    "cannot acquire session because active + warm workers reached max_processes ({})",
                    self.cfg.max_processes
                ),
            });
        };

        self.active_workers.insert(session_id, worker);
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<SessionId> {
        self.active_workers.keys().copied().collect()
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

    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_binds_idle_warm_worker_when_available() {
        let cfg = test_config("sh", &["-c", "exit 0"], 1, 2);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");
        let session_id = SessionId::new();

        pool.acquire_session(session_id)
            .expect("acquiring first session should succeed");

        let sessions = pool.list_sessions();
        assert_eq!(
            pool.warm_worker_count(),
            0,
            "warm worker should be consumed"
        );
        assert_eq!(sessions.len(), 1, "one session should be active");
        assert_eq!(sessions[0], session_id, "session id should be bound");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn acquire_session_spawns_new_worker_when_no_warm_worker_exists() {
        let cfg = test_config("sh", &["-c", "exit 0"], 1, 2);
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");
        let session_a = SessionId::new();
        let session_b = SessionId::new();

        pool.acquire_session(session_a)
            .expect("first session should consume warm worker");
        pool.acquire_session(session_b)
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

        pool.acquire_session(SessionId::new())
            .expect("first session should succeed");
        let error = pool
            .acquire_session(SessionId::new())
            .expect_err("second session should fail at max capacity");

        assert!(matches!(error, ServiceError::ChildProcess { .. }));
    }
}
