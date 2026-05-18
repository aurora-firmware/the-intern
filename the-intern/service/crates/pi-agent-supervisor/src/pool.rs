use crate::{process::WorkerProcessConfig, rpc, Config};
use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use std::collections::HashMap;
use tokio::time::Instant;

#[derive(Debug)]
struct ActiveSessionWorker {
    worker: crate::process::RpcWorkerProcess,
    last_prompt_activity: Instant,
}

#[derive(Debug)]
pub struct SessionPool {
    cfg: Config,
    warm_workers: Vec<crate::process::RpcWorkerProcess>,
    active_workers: HashMap<SessionId, ActiveSessionWorker>,
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

        self.active_workers.insert(
            session_id,
            ActiveSessionWorker {
                worker,
                last_prompt_activity: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<SessionId> {
        self.active_workers.keys().copied().collect()
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
        if !self.active_workers.contains_key(&session_id) {
            self.acquire_session(session_id)?;
        }

        let active_worker =
            self.active_workers
                .get_mut(&session_id)
                .ok_or_else(|| ServiceError::ChildProcess {
                    detail: "session worker missing after acquire".to_string(),
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
            if let Some(worker) = self.warm_workers.pop() {
                worker.terminate().await?;
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

        while let Some(worker) = self.warm_workers.pop() {
            match worker.terminate().await {
                Ok(_) => report.warm_workers_terminated += 1,
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

    #[tokio::test(flavor = "current_thread")]
    async fn reap_idle_and_surplus_terminates_surplus_warm_workers_above_configured_pool_size() {
        let cfg = test_config(
            "sh",
            &["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
            1,
            4,
        );
        let mut pool = SessionPool::new(&cfg).expect("pool startup should succeed");

        let process_cfg = SessionPool::worker_process_config(&cfg);
        pool.warm_workers.push(
            crate::process::RpcWorkerProcess::spawn(&process_cfg).expect("spawn should work"),
        );
        pool.warm_workers.push(
            crate::process::RpcWorkerProcess::spawn(&process_cfg).expect("spawn should work"),
        );

        let report = pool
            .reap_idle_and_surplus()
            .await
            .expect("reap should succeed");

        assert_eq!(report.idle_sessions_reaped, 0);
        assert_eq!(report.warm_workers_reaped, 2);
        assert_eq!(pool.warm_worker_count(), 1);
    }
}
