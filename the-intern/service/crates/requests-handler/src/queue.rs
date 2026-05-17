#![forbid(unsafe_code)]

use std::time::Duration;

use async_trait::async_trait;
use bob_core::{
    error::{ServiceError, ServiceResult},
    ports::RequestsHandler,
    types::InternalEvent,
};
use tokio::sync::{mpsc, watch};

/// Configuration for the queue-backed requests handler.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// Maximum number of events the queue can hold at one time.
    pub request_queue_capacity: usize,
    /// How long `submit` waits for space before returning `Timeout`.
    pub request_submit_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            request_queue_capacity: 1024,
            request_submit_timeout: Duration::from_secs(5),
        }
    }
}

/// Cloneable handle callers use to submit events.
#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<InternalEvent>,
    /// Signals whether the actor has been shut down; used to reject new
    /// submissions after cancellation.
    shutdown_rx: watch::Receiver<bool>,
    submit_timeout: Duration,
}

impl Handle {
    /// Submit an event to the queue.
    ///
    /// Returns `Ok(())` when the event is accepted.
    ///
    /// # Errors
    ///
    /// - `ServiceError::Shutdown` — the actor has been cancelled.
    /// - `ServiceError::Timeout { operation: "requests-handler.submit" }` — the
    ///   queue remained full beyond `cfg.request_submit_timeout`.
    pub async fn submit_event(&self, event: InternalEvent) -> ServiceResult<()> {
        // Reject immediately if the actor is already shut down.
        if *self.shutdown_rx.borrow() {
            return Err(ServiceError::Shutdown);
        }

        match tokio::time::timeout(self.submit_timeout, self.tx.send(event)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => {
                // Channel closed means actor shut down.
                Err(ServiceError::Shutdown)
            }
            Err(_elapsed) => Err(ServiceError::Timeout {
                operation: "requests-handler.submit",
            }),
        }
    }
}

#[async_trait]
impl RequestsHandler for Handle {
    async fn submit(&self, event: InternalEvent) -> ServiceResult<()> {
        self.submit_event(event).await
    }
}

/// Actor that drains the queue and forwards events to a downstream handler.
struct Actor<F> {
    rx: mpsc::Receiver<InternalEvent>,
    downstream: F,
    shutdown_tx: watch::Sender<bool>,
    /// Receives a signal to stop the actor.
    cancel_rx: watch::Receiver<bool>,
}

impl<F, Fut> Actor<F>
where
    F: Fn(InternalEvent) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    /// Run the actor until cancellation, then drain remaining queued events.
    async fn run(mut self) {
        tracing::info!("requests-handler queue actor started");

        // Process events until the cancel signal fires.
        loop {
            tokio::select! {
                biased;

                _ = self.cancel_rx.changed() => {
                    if *self.cancel_rx.borrow() {
                        break;
                    }
                }

                event = self.rx.recv() => {
                    match event {
                        Some(ev) => (self.downstream)(ev).await,
                        None => {
                            // Sender side dropped; nothing more to receive.
                            break;
                        }
                    }
                }
            }
        }

        // Drain remaining events before terminating.
        tracing::info!("requests-handler queue actor draining on shutdown");
        self.rx.close();
        while let Some(ev) = self.rx.recv().await {
            (self.downstream)(ev).await;
        }

        // Signal the handle that the actor is down so new submits are rejected.
        let _ = self.shutdown_tx.send(true);
        tracing::info!("requests-handler queue actor stopped");
    }
}

/// Start the queue actor and return a `Handle` and a join handle.
///
/// The caller must keep the `watch::Sender<bool>` (created via
/// `tokio::sync::watch::channel(false)`) and send `true` on it to request
/// graceful shutdown. The actor stops accepting new events and drains any
/// remaining queued events before its task completes.
///
/// # Arguments
///
/// - `cfg` — queue capacity and submit timeout.
/// - `downstream` — called for each event drained from the queue.
/// - `cancel_rx` — the actor watches this; when it becomes `true` the actor
///   drains and exits.
pub fn start_with<F, Fut>(
    cfg: Config,
    downstream: F,
    cancel_rx: watch::Receiver<bool>,
) -> (Handle, tokio::task::JoinHandle<()>)
where
    F: Fn(InternalEvent) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let capacity = cfg.request_queue_capacity.max(1);
    let (tx, rx) = mpsc::channel(capacity);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let handle = Handle {
        tx,
        shutdown_rx,
        submit_timeout: cfg.request_submit_timeout,
    };

    let actor = Actor {
        rx,
        downstream,
        shutdown_tx,
        cancel_rx,
    };

    let join = tokio::spawn(actor.run());

    (handle, join)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use bob_core::ports::RequestsHandler;
    use bob_core::types::InternalEvent;
    use tokio::sync::watch;

    use super::{start_with, Config};
    use bob_core::error::ServiceError;

    fn test_config(capacity: usize, timeout: Duration) -> Config {
        Config {
            request_queue_capacity: capacity,
            request_submit_timeout: timeout,
        }
    }

    fn make_cancel_pair() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    fn chat_event(content: &str) -> InternalEvent {
        InternalEvent::ChatMessage {
            content: content.to_owned(),
        }
    }

    // AC-1: submit with available capacity enqueues and returns Ok(())
    #[tokio::test(flavor = "current_thread")]
    async fn submit_with_capacity_enqueues_and_returns_ok() {
        let (cancel_tx, cancel_rx) = make_cancel_pair();
        let cfg = test_config(16, Duration::from_secs(5));

        let (handle, task) = start_with(cfg, |_ev| async {}, cancel_rx);

        let result = handle.submit(chat_event("hello")).await;
        assert!(result.is_ok(), "expected Ok(()), got {result:?}");

        cancel_tx.send(true).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    // AC-1 (via trait): RequestsHandler::submit delegates correctly
    #[tokio::test(flavor = "current_thread")]
    async fn requests_handler_trait_submit_with_capacity_returns_ok() {
        let (cancel_tx, cancel_rx) = make_cancel_pair();
        let cfg = test_config(16, Duration::from_secs(5));

        let (handle, task) = start_with(cfg, |_ev| async {}, cancel_rx);

        let handler: &dyn RequestsHandler = &handle;
        let result = handler.submit(chat_event("test")).await;
        assert!(result.is_ok());

        cancel_tx.send(true).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    // AC-2: queue full beyond timeout returns Err(Timeout)
    #[tokio::test(flavor = "current_thread")]
    async fn submit_when_queue_full_beyond_timeout_returns_timeout_error() {
        use tokio::sync::Notify;

        let (_cancel_tx, cancel_rx) = make_cancel_pair();
        // Capacity of 1, very short timeout so the test stays fast.
        let cfg = test_config(1, Duration::from_millis(50));

        // The downstream blocks until we notify it, keeping the slot occupied.
        let gate = Arc::new(Notify::new());
        let gate_clone = gate.clone();

        let (handle, task) = start_with(
            cfg,
            move |_ev| {
                let g = gate_clone.clone();
                async move {
                    // Wait until the test releases the gate.
                    g.notified().await;
                }
            },
            cancel_rx,
        );

        // First submit fills the queue slot. The .await yields, letting the
        // actor consume the event and enter the downstream gate-wait.
        let r1 = handle.submit(chat_event("fills-slot")).await;
        assert!(r1.is_ok(), "first submit should succeed: {r1:?}");

        // Yield once more so the actor definitively enters the downstream wait.
        tokio::task::yield_now().await;

        // Now send another event to fill the queue slot again.
        let r_fill = handle.submit(chat_event("fills-queue")).await;
        assert!(
            r_fill.is_ok(),
            "second submit should succeed (queue empty): {r_fill:?}"
        );

        // Third submit should time out: the queue holds one event and the actor
        // is blocked on the gate, so no capacity is available.
        let r_timeout = handle.submit(chat_event("should-timeout")).await;
        assert!(
            matches!(
                r_timeout,
                Err(ServiceError::Timeout {
                    operation: "requests-handler.submit"
                })
            ),
            "expected Timeout error, got {r_timeout:?}"
        );

        // Release the gate and clean up.
        gate.notify_waiters();
        task.abort();
    }

    // AC-3: on cancellation, stop accepting and drain remaining events
    #[tokio::test(flavor = "current_thread")]
    async fn on_cancellation_drains_remaining_queued_events() {
        let received: Arc<Mutex<Vec<InternalEvent>>> = Arc::new(Mutex::new(vec![]));
        let received_clone = received.clone();

        let (cancel_tx, cancel_rx) = make_cancel_pair();
        // Large capacity so we can enqueue several events before the actor drains.
        let cfg = test_config(64, Duration::from_secs(5));

        let (handle, task) = start_with(
            cfg,
            move |ev| {
                let r = received_clone.clone();
                async move {
                    r.lock().unwrap().push(ev);
                }
            },
            cancel_rx,
        );

        // Submit several events.
        handle.submit(chat_event("a")).await.unwrap();
        handle.submit(chat_event("b")).await.unwrap();
        handle.submit(chat_event("c")).await.unwrap();

        // Signal cancellation.
        cancel_tx.send(true).unwrap();

        // Wait for the actor task to finish (it must drain before stopping).
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("actor must finish within 2 seconds")
            .expect("actor task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 3, "all 3 events should be drained, got {got:?}");
    }

    // AC-3: after cancellation, new submissions are rejected
    #[tokio::test(flavor = "current_thread")]
    async fn after_cancellation_new_submissions_are_rejected() {
        let (cancel_tx, cancel_rx) = make_cancel_pair();
        let cfg = test_config(16, Duration::from_millis(100));

        let (handle, task) = start_with(cfg, |_ev| async {}, cancel_rx);

        // Signal cancellation and wait for actor to finish.
        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("actor must finish within 2 seconds")
            .expect("actor task must not panic");

        // A new submit should fail (either Shutdown or Timeout as channel is closed).
        let result = handle.submit(chat_event("too-late")).await;
        assert!(
            result.is_err(),
            "expected error after shutdown, got {result:?}"
        );
    }

    // AC-4: Handle implements bob_core::ports::RequestsHandler (compile-time check)
    #[tokio::test(flavor = "current_thread")]
    async fn handle_implements_requests_handler_trait() {
        let (_cancel_tx, cancel_rx) = make_cancel_pair();
        let cfg = Config::default();

        let (handle, task) = start_with(cfg, |_ev| async {}, cancel_rx);

        // If this compiles, the trait is implemented.
        fn assert_requests_handler<T: bob_core::ports::RequestsHandler>(_: &T) {}
        assert_requests_handler(&handle);

        task.abort();
    }
}
