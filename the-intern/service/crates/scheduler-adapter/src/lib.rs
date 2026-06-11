#![forbid(unsafe_code)]

use bob_core::types::ScheduleEntry;
use requests_handler::Handle as IntakeHandle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::info;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Cheaply cloneable handle that signals a configuration reload to the
/// scheduler-adapter actor.
///
/// When all clones of a `ReloadHandle` are dropped, the actor exits cleanly.
#[derive(Clone)]
pub struct ReloadHandle {
    /// Keeping a sender alive keeps the actor running.
    /// Dropping every clone closes the watch channel, which the actor detects.
    _tx: watch::Sender<()>,
}

// ---------------------------------------------------------------------------
// Internal actor
// ---------------------------------------------------------------------------

struct Actor {
    /// Held for future use: T-095 will submit scheduled events through this handle.
    _intake: IntakeHandle,
    /// Job table initialised from the entries supplied to `start`.
    entries: Vec<ScheduleEntry>,
    /// Actor exits when this receiver sees the channel closed (all senders dropped).
    reload_rx: watch::Receiver<()>,
}

impl Actor {
    async fn run(mut self) {
        info!("scheduler-adapter actor started");

        // Log initial job table size at DEBUG level.
        tracing::debug!(
            job_count = self.entries.len(),
            "scheduler-adapter job table initialised"
        );

        // Wait for a reload signal or for all ReloadHandles to be dropped.
        // `changed()` returns Err when the sender side is closed.
        loop {
            match self.reload_rx.changed().await {
                Ok(()) => {
                    tracing::debug!("scheduler-adapter received reload signal");
                    // Reload logic (T-095+): re-read entries and rebuild job table.
                }
                Err(_) => {
                    // All ReloadHandle clones have been dropped — shut down.
                    break;
                }
            }
        }

        info!("scheduler-adapter actor stopped");
    }
}

// ---------------------------------------------------------------------------
// Public constructor
// ---------------------------------------------------------------------------

/// Starts the scheduler-adapter actor.
///
/// Returns:
/// - A [`ReloadHandle`] that callers use to signal a configuration reload.
///   The handle is cheaply cloneable; when all clones are dropped the actor
///   exits cleanly.
/// - A [`JoinHandle`] for the spawned actor task.  Await it after dropping
///   the last `ReloadHandle` to confirm clean shutdown.
///
/// No cron ticks fire yet; that is implemented in T-095.
#[must_use]
pub fn start(intake: IntakeHandle, entries: Vec<ScheduleEntry>) -> (ReloadHandle, JoinHandle<()>) {
    // The watch channel carries the reload signal.  The receiver is held by the
    // actor; the sender is wrapped in ReloadHandle.  When the last sender clone
    // is dropped, `reload_rx.changed()` returns Err and the actor exits.
    let (tx, rx) = watch::channel(());
    let handle = ReloadHandle { _tx: tx };
    let actor = Actor {
        _intake: intake,
        entries,
        reload_rx: rx,
    };
    let join = tokio::spawn(actor.run());
    (handle, join)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use bob_core::types::ScheduleEntry;
    use requests_handler::{start_with, Config as QueueConfig};
    use std::time::Duration;
    use tokio::sync::watch;

    fn make_intake() -> (
        requests_handler::Handle,
        tokio::task::JoinHandle<()>,
        watch::Sender<bool>,
    ) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (handle, task) = start_with(cfg, |_pair| async {}, cancel_rx);
        (handle, task, cancel_tx)
    }

    // AC-2 + AC-4: start() with empty entries returns (ReloadHandle, JoinHandle)
    // and the actor starts (does not immediately resolve its JoinHandle).
    #[tokio::test(flavor = "current_thread")]
    async fn start_with_empty_entries_returns_reload_handle_and_running_join_handle() {
        let (intake, _intake_task, _cancel) = make_intake();
        let entries: Vec<ScheduleEntry> = vec![];
        let (reload_handle, join_handle) = crate::start(intake, entries);
        // The handle must be cheaply cloneable.
        let _clone = reload_handle.clone();
        // The actor should still be running (JoinHandle not yet resolved).
        assert!(
            !join_handle.is_finished(),
            "actor task must still be running after start"
        );
        join_handle.abort();
    }

    // AC-3 + AC-4: when all ReloadHandle clones are dropped, the actor exits cleanly.
    #[tokio::test(flavor = "current_thread")]
    async fn actor_exits_cleanly_when_all_reload_handles_are_dropped() {
        let (intake, _intake_task, _cancel) = make_intake();
        let entries: Vec<ScheduleEntry> = vec![];
        let (reload_handle, join_handle) = crate::start(intake, entries);

        // Clone once, then drop both.
        let reload_clone = reload_handle.clone();
        drop(reload_handle);
        drop(reload_clone);

        // Actor should exit within a short timeout.
        tokio::time::timeout(Duration::from_secs(2), join_handle)
            .await
            .expect("actor must exit within 2 seconds after all handles dropped")
            .expect("actor task must not panic");
    }
}
