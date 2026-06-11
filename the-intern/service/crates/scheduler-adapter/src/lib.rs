#![forbid(unsafe_code)]

use bob_core::types::{
    ChannelId, DeliveryKind, InternalEvent, RequestContext, ScheduleEntry, UserId,
};
use chrono::Utc;
use croner::parser::{CronParser, Seconds};
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
// Internal types
// ---------------------------------------------------------------------------

/// Per-job state created once at actor startup.
///
/// The `channel_id` and `user_id` are fixed for the lifetime of the job so
/// that every tick for a given job appears to come from the same virtual
/// channel and user. Operators can reference these IDs in policy rules.
struct JobState {
    entry: ScheduleEntry,
    channel_id: ChannelId,
    user_id: UserId,
}

// ---------------------------------------------------------------------------
// Internal actor
// ---------------------------------------------------------------------------

struct Actor {
    intake: IntakeHandle,
    /// Job table initialised from the entries supplied to `start`.
    jobs: Vec<JobState>,
    /// Actor exits when this receiver sees the channel closed (all senders dropped).
    reload_rx: watch::Receiver<()>,
}

impl Actor {
    async fn run(mut self) {
        info!("scheduler-adapter actor started");

        tracing::debug!(
            job_count = self.jobs.len(),
            "scheduler-adapter job table initialised"
        );

        if self.jobs.is_empty() {
            // No jobs: just wait for shutdown.
            loop {
                match self.reload_rx.changed().await {
                    Ok(()) => {
                        tracing::debug!("scheduler-adapter received reload signal");
                    }
                    Err(_) => break,
                }
            }
            info!("scheduler-adapter actor stopped");
            return;
        }

        let parser = CronParser::builder().seconds(Seconds::Disallowed).build();

        // Parse all cron expressions once at startup. Log fixed IDs.
        let parsed: Vec<(croner::Cron, &JobState)> = self
            .jobs
            .iter()
            .filter_map(|job| match parser.parse(&job.entry.cron) {
                Ok(cron) => {
                    info!(
                        job_id = %job.entry.id,
                        channel_id = %job.channel_id,
                        user_id = %job.user_id,
                        cron = %job.entry.cron,
                        "scheduler-adapter job registered — fixed channel/user IDs for policy rules"
                    );
                    Some((cron, job))
                }
                Err(err) => {
                    tracing::warn!(
                        job_id = %job.entry.id,
                        cron = %job.entry.cron,
                        error = %err,
                        "scheduler-adapter failed to parse cron expression; job will not fire"
                    );
                    None
                }
            })
            .collect();

        // Spawn one task per job; each loops independently over its next-fire times.
        let mut task_handles: Vec<tokio::task::JoinHandle<()>> = parsed
            .into_iter()
            .map(|(cron, job)| {
                let intake = self.intake.clone();
                let job_id = job.entry.id.clone();
                let job_prompt = job.entry.prompt.clone();
                let channel_id = job.channel_id;
                let user_id = job.user_id;

                tokio::spawn(async move {
                    run_job_tick_loop(intake, cron, job_id, job_prompt, channel_id, user_id).await;
                })
            })
            .collect();

        // Wait for reload or shutdown while job tick loops run in parallel.
        loop {
            match self.reload_rx.changed().await {
                Ok(()) => {
                    tracing::debug!("scheduler-adapter received reload signal");
                    // TODO(T-096+): rebuild job table on reload.
                }
                Err(_) => {
                    // All ReloadHandle clones dropped — shut down.
                    break;
                }
            }
        }

        // Cancel all job tick tasks.
        for handle in &task_handles {
            handle.abort();
        }
        // Await completion (aborted tasks finish quickly).
        for handle in &mut task_handles {
            let _ = handle.await;
        }

        info!("scheduler-adapter actor stopped");
    }
}

/// Infinite loop that sleeps until the next cron fire, then submits one
/// `InternalEvent` to the intake. Errors from `submit_event` are logged as
/// warnings and do not stop the loop.
async fn run_job_tick_loop(
    intake: IntakeHandle,
    cron: croner::Cron,
    job_id: String,
    job_prompt: String,
    channel_id: ChannelId,
    user_id: UserId,
) {
    loop {
        // Compute wall-clock duration to the next cron fire.
        let now = Utc::now();
        let next = match cron.find_next_occurrence(&now, false) {
            Ok(dt) => dt,
            Err(err) => {
                tracing::warn!(
                    job_id = %job_id,
                    error = %err,
                    "scheduler-adapter failed to compute next occurrence; retrying in 60 seconds"
                );
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                continue;
            }
        };

        // Convert to a tokio-compatible duration and sleep.
        let duration_to_next = match (next - now).to_std() {
            Ok(d) => d,
            Err(_) => {
                // next is in the past (shouldn't happen with inclusive=false, but be safe)
                std::time::Duration::ZERO
            }
        };

        tokio::time::sleep(duration_to_next).await;

        // Fire: construct and submit the periodic event.
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: job_prompt.clone(),
        };
        let context = RequestContext {
            sender: user_id,
            source: channel_id,
            context_id: Some(job_id.clone()),
            reply_address: None,
        };

        if let Err(err) = intake.submit_event(event, context).await {
            tracing::warn!(
                job_id = %job_id,
                error = %err,
                "scheduler-adapter failed to submit periodic event; continuing"
            );
        }
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
/// For each `ScheduleEntry`, a fixed `ChannelId` and `UserId` are created
/// at startup. These IDs are reused on every tick for that job so that
/// policy rules can reference them consistently. They are logged at `INFO`
/// level when each job is registered.
#[must_use]
pub fn start(intake: IntakeHandle, entries: Vec<ScheduleEntry>) -> (ReloadHandle, JoinHandle<()>) {
    // The watch channel carries the reload signal.  The receiver is held by the
    // actor; the sender is wrapped in ReloadHandle.  When the last sender clone
    // is dropped, `reload_rx.changed()` returns Err and the actor exits.
    let (tx, rx) = watch::channel(());
    let handle = ReloadHandle { _tx: tx };

    // Build per-job state with fixed, stable IDs created once at startup.
    let jobs = entries
        .into_iter()
        .map(|entry| JobState {
            entry,
            channel_id: ChannelId::new(),
            user_id: UserId::new(),
        })
        .collect();

    let actor = Actor {
        intake,
        jobs,
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
    use bob_core::types::{DeliveryKind, InternalEvent, RequestContext, ScheduleEntry};
    use requests_handler::{start_with, Config as QueueConfig};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::watch;

    fn make_intake_with_collector() -> (
        requests_handler::Handle,
        tokio::task::JoinHandle<()>,
        watch::Sender<bool>,
        Arc<Mutex<Vec<(InternalEvent, RequestContext)>>>,
    ) {
        let collected: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>> =
            Arc::new(Mutex::new(vec![]));
        let collected_clone = collected.clone();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (handle, task) = start_with(
            cfg,
            move |(ev, ctx)| {
                let c = collected_clone.clone();
                async move {
                    c.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );
        (handle, task, cancel_tx, collected)
    }

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

    // AC-1, AC-2: when a scheduled job's cron fires, the actor submits one
    // InternalEvent with kind=Periodic and payload=job.prompt to the intake,
    // and the RequestContext has context_id=job.id, reply_address=None.
    // Uses tokio::time::pause() + advance() to drive the clock.
    #[tokio::test(flavor = "current_thread")]
    async fn cron_tick_submits_periodic_event_with_correct_payload_and_context() {
        tokio::time::pause();

        let (intake, intake_task, intake_cancel, collected) = make_intake_with_collector();

        let job_id = "daily-report".to_owned();
        let job_prompt = "Generate the daily report".to_owned();
        // "* * * * *" fires every minute; advancing 61 seconds triggers at least one tick.
        let entry = ScheduleEntry {
            id: job_id.clone(),
            cron: "* * * * *".to_owned(),
            prompt: job_prompt.clone(),
        };
        let entries = vec![entry];

        let (_reload_handle, _scheduler_join) = crate::start(intake, entries);

        // Yield to let the actor task run and spawn per-job tick tasks, which
        // will register their tokio sleep timers before we advance the clock.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // Advance tokio time by 61 seconds to trigger the first cron minute boundary.
        // `advance` itself yields back to the runtime so the sleeping tasks wake up.
        tokio::time::advance(Duration::from_secs(61)).await;
        // Yield again to let the woken tick task submit its event to the intake
        // and let the intake actor process it.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // Shut down the intake so collected events are flushed.
        intake_cancel.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let events = collected.lock().unwrap();
        assert!(
            !events.is_empty(),
            "at least one periodic event must have been submitted"
        );
        let (ev, ctx) = &events[0];
        assert_eq!(
            ev.kind,
            DeliveryKind::Periodic,
            "event kind must be Periodic"
        );
        assert_eq!(
            ev.payload, job_prompt,
            "event payload must match job prompt"
        );
        assert_eq!(
            ctx.context_id,
            Some(job_id.clone()),
            "context_id must equal job id"
        );
        assert!(
            ctx.reply_address.is_none(),
            "reply_address must be None for scheduled events"
        );
    }

    // AC-2: the same ChannelId and UserId are reused across multiple ticks of the same job.
    #[tokio::test(flavor = "current_thread")]
    async fn cron_tick_reuses_same_channel_id_and_user_id_across_multiple_ticks() {
        tokio::time::pause();

        let (intake, intake_task, intake_cancel, collected) = make_intake_with_collector();

        let entry = ScheduleEntry {
            id: "repeating-job".to_owned(),
            cron: "* * * * *".to_owned(),
            prompt: "repeat".to_owned(),
        };

        let (_reload_handle, _scheduler_join) = crate::start(intake, vec![entry]);

        // Yield first to let the actor task start and spawn per-job tasks which
        // register their tokio sleep timers.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // Drive the clock in 65-second steps to collect two ticks. Each step:
        //   1. Wakes any sleeping task whose timer has elapsed.
        //   2. The task fires, submits the event, then sleeps until the next minute.
        //   3. Yielding lets the newly registered sleep take effect before the next advance.
        for _ in 0..2 {
            tokio::time::advance(Duration::from_secs(65)).await;
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
        }

        intake_cancel.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let events = collected.lock().unwrap();
        assert!(
            events.len() >= 2,
            "at least two periodic events must have been submitted for identity consistency check, got {}",
            events.len()
        );

        let sender_0 = events[0].1.sender;
        let source_0 = events[0].1.source;
        let sender_1 = events[1].1.sender;
        let source_1 = events[1].1.source;

        assert_eq!(
            sender_0, sender_1,
            "UserId must be the same across ticks of the same job"
        );
        assert_eq!(
            source_0, source_1,
            "ChannelId must be the same across ticks of the same job"
        );
    }

    // AC-3: if intake.submit_event returns an error, the actor logs a warning
    // and continues processing subsequent ticks without crashing.
    // We test this by filling the intake queue and verifying the actor stays alive.
    #[tokio::test(flavor = "current_thread")]
    async fn actor_continues_running_when_intake_submit_returns_error() {
        tokio::time::pause();

        // Create an intake with capacity 1 and a very short timeout so submits fail quickly.
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 1,
            request_submit_timeout: Duration::from_millis(10),
        };
        // The downstream blocks forever, keeping the queue slot permanently occupied.
        let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel::<()>();
        let blocked_rx = Arc::new(tokio::sync::Mutex::new(Some(blocked_rx)));
        let (intake, intake_task) = start_with(
            cfg,
            move |_pair| {
                let rx_arc = blocked_rx.clone();
                async move {
                    let mut guard = rx_arc.lock().await;
                    if let Some(rx) = guard.take() {
                        let _ = rx.await;
                    }
                }
            },
            cancel_rx,
        );

        let entry = ScheduleEntry {
            id: "blocked-job".to_owned(),
            cron: "* * * * *".to_owned(),
            prompt: "probe".to_owned(),
        };
        let (_reload_handle, scheduler_join) = crate::start(intake, vec![entry]);

        // Yield first to let the actor start and register timers.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // Advance time to trigger two ticks.
        tokio::time::advance(Duration::from_secs(130)).await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // The scheduler actor must still be alive (not crashed) after failed submits.
        assert!(
            !scheduler_join.is_finished(),
            "scheduler actor must keep running even after intake submit errors"
        );

        // Clean up.
        let _ = blocked_tx.send(());
        cancel_tx.send(true).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), intake_task).await;
        scheduler_join.abort();
    }
}
