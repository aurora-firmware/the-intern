use bob_core::types::SessionId;
use std::time::Duration;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReapReport {
    pub idle_sessions_reaped: usize,
    pub warm_workers_reaped: usize,
}

impl ReapReport {
    pub fn total_reaped(self) -> usize {
        self.idle_sessions_reaped + self.warm_workers_reaped
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ShutdownReport {
    pub active_workers_terminated: usize,
    pub warm_workers_terminated: usize,
}

pub fn select_idle_sessions<I>(
    now: Instant,
    idle_reap_timeout: Duration,
    sessions: I,
) -> Vec<SessionId>
where
    I: IntoIterator<Item = (SessionId, Instant)>,
{
    sessions
        .into_iter()
        .filter_map(|(session_id, last_prompt_activity)| {
            if now.duration_since(last_prompt_activity) >= idle_reap_timeout {
                Some(session_id)
            } else {
                None
            }
        })
        .collect()
}

pub fn surplus_warm_worker_count(current_warm_workers: usize, warm_pool_size: usize) -> usize {
    current_warm_workers.saturating_sub(warm_pool_size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn select_idle_sessions_returns_sessions_at_or_over_idle_timeout() {
        let now = Instant::now();
        let stale_a = SessionId::new();
        let stale_b = SessionId::new();
        let fresh = SessionId::new();

        let selected = select_idle_sessions(
            now,
            Duration::from_secs(5),
            vec![
                (stale_a, now - Duration::from_secs(5)),
                (stale_b, now - Duration::from_secs(9)),
                (fresh, now - Duration::from_secs(2)),
            ],
        );

        assert_eq!(selected.len(), 2);
        assert!(selected.contains(&stale_a));
        assert!(selected.contains(&stale_b));
        assert!(!selected.contains(&fresh));
    }

    #[test]
    fn surplus_warm_worker_count_returns_only_workers_above_pool_size() {
        assert_eq!(surplus_warm_worker_count(0, 1), 0);
        assert_eq!(surplus_warm_worker_count(1, 1), 0);
        assert_eq!(surplus_warm_worker_count(4, 1), 3);
    }
}
