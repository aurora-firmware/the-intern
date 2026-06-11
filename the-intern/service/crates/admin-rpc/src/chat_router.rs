//! Service-scoped chat reply router.
//!
//! # Design
//!
//! The [`ChatReplyRouter`] is the single entry point through which any producer
//! delivers a reply addressed to an open chat subscription.  It maintains a
//! registry of open subscription ids, each with a bounded per-subscription queue.
//!
//! # Registration lifecycle
//!
//! 1. On `chat.open`, the dispatch layer calls [`ChatReplyRouter::register`],
//!    receiving a [`ChatReplyReceiver`] (the consume end of the queue).
//! 2. On `chat.close` or connection drop, the dispatch layer calls
//!    [`ChatReplyRouter::deregister`], which drops the send end so an awaiting
//!    consumer observes end-of-stream.
//!
//! # Delivery
//!
//! [`DeliveryHandle`] is cheaply cloneable and `Send + Sync`.  Any number of
//! producers can hold a clone and call [`DeliveryHandle::deliver`] concurrently.
//!
//! - Replies addressed to unknown or deregistered ids are dropped; a `tracing`
//!   entry is emitted at WARN level and the call reports success to the producer.
//! - If a subscription's bounded queue is full the subscription is evicted
//!   immediately (mirroring the slow-consumer policy of [`super::subscriptions::SubscriptionBus`]).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::mpsc;

use crate::subscriptions::AdminSubscriptionId;

/// Bounded channel capacity for each per-subscription reply queue.
const REPLY_QUEUE_CAPACITY: usize = 64;

/// The receive end of a per-subscription reply queue.
///
/// Returned by [`ChatReplyRouter::register`] and consumed by the connection
/// forwarder task.
pub type ChatReplyReceiver = mpsc::Receiver<serde_json::Value>;

/// Shared state behind both [`ChatReplyRouter`] and [`DeliveryHandle`].
struct RouterState {
    senders: HashMap<AdminSubscriptionId, mpsc::Sender<serde_json::Value>>,
}

/// Service-scoped registry of open chat subscriptions.
///
/// Holds the authoritative list of open subscription ids and the send end of
/// each per-subscription reply queue.  Deregistering a subscription drops the
/// send end, which closes the channel and causes an awaiting consumer to observe
/// end-of-stream (AC-5).
///
/// Clone [`DeliveryHandle`] from this via [`ChatReplyRouter::delivery_handle`]
/// to hand a lightweight handle to producers.
pub struct ChatReplyRouter {
    state: Arc<Mutex<RouterState>>,
}

impl ChatReplyRouter {
    /// Create a new, empty router.
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RouterState {
                senders: HashMap::new(),
            })),
        }
    }

    /// Return a cheaply cloneable delivery handle that shares state with this router.
    pub fn delivery_handle(&self) -> DeliveryHandle {
        DeliveryHandle {
            state: Arc::clone(&self.state),
        }
    }

    /// Register a new chat subscription.
    ///
    /// Allocates a bounded per-subscription reply queue and stores the send end
    /// in the registry.  Returns the receive end to the caller (typically the
    /// connection forwarder task).
    pub fn register(&self, id: AdminSubscriptionId) -> ChatReplyReceiver {
        let (tx, rx) = mpsc::channel(REPLY_QUEUE_CAPACITY);
        let mut state = self.state.lock().expect("chat router state lock poisoned");
        state.senders.insert(id, tx);
        rx
    }

    /// Deregister a chat subscription.
    ///
    /// Removes the send end of the queue for `id`, which drops it and closes the
    /// channel.  An awaiting consumer on the receive end will observe
    /// end-of-stream (AC-5).
    ///
    /// Returns `true` when the id was registered, `false` when it was already
    /// absent.
    pub fn deregister(&self, id: AdminSubscriptionId) -> bool {
        let mut state = self.state.lock().expect("chat router state lock poisoned");
        state.senders.remove(&id).is_some()
    }
}

impl Default for ChatReplyRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// A cheaply cloneable, `Send + Sync` handle for delivering replies to chat
/// subscriptions.
///
/// Obtain one from [`ChatReplyRouter::delivery_handle`].  Multiple clones can
/// be held by different producers and used concurrently without coordination.
#[derive(Clone)]
pub struct DeliveryHandle {
    state: Arc<Mutex<RouterState>>,
}

impl DeliveryHandle {
    /// Deliver `payload` to the subscription identified by `id`.
    ///
    /// - If `id` is not registered the payload is dropped and a WARN log entry
    ///   is emitted; the function returns normally (AC-2).
    /// - If the subscription's queue is full the subscription is evicted
    ///   immediately and the payload is dropped (AC-3).
    /// - On success the payload is placed in the subscription's queue in
    ///   delivery order (AC-1).
    pub fn deliver(&self, id: AdminSubscriptionId, payload: serde_json::Value) {
        let sender = {
            let state = self.state.lock().expect("chat router state lock poisoned");
            state.senders.get(&id).cloned()
        };

        match sender {
            None => {
                tracing::warn!(
                    subscription_id = %id,
                    "chat reply dropped: subscription not registered or already closed"
                );
            }
            Some(tx) => match tx.try_send(payload) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // Evict the slow subscriber immediately.
                    tracing::warn!(
                        subscription_id = %id,
                        "chat reply queue full: evicting slow subscriber"
                    );
                    let mut state = self.state.lock().expect("chat router state lock poisoned");
                    state.senders.remove(&id);
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    // The receiver was already dropped; clean up silently.
                    let mut state = self.state.lock().expect("chat router state lock poisoned");
                    state.senders.remove(&id);
                }
            },
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // AC-1: deliver makes a payload available on the registered receiver in
    // delivery order.
    #[tokio::test(flavor = "current_thread")]
    async fn deliver_makes_payload_available_on_registered_receiver_in_order() {
        let router = ChatReplyRouter::new();
        let id = AdminSubscriptionId::parse("1").unwrap();
        let mut rx = router.register(id);
        let handle = router.delivery_handle();

        let first = serde_json::json!({"text": "hello"});
        let second = serde_json::json!({"text": "world"});
        handle.deliver(id, first.clone());
        handle.deliver(id, second.clone());

        let got_first = rx.recv().await.expect("first payload must be available");
        let got_second = rx.recv().await.expect("second payload must be available");
        assert_eq!(got_first, first, "first payload must match in order");
        assert_eq!(got_second, second, "second payload must match in order");
    }

    // AC-2: delivering to an unknown id drops the payload and returns normally
    // (does not error the producer).
    #[test]
    fn deliver_to_unknown_id_drops_payload_and_returns_normally() {
        let router = ChatReplyRouter::new();
        let handle = router.delivery_handle();
        let ghost = AdminSubscriptionId::parse("9999").unwrap();

        // Must not panic or return an error.
        handle.deliver(ghost, serde_json::json!({"text": "dropped"}));
    }

    // AC-2: delivering to a deregistered id drops the payload without error.
    #[tokio::test(flavor = "current_thread")]
    async fn deliver_to_deregistered_id_drops_payload_without_error() {
        let router = ChatReplyRouter::new();
        let id = AdminSubscriptionId::parse("2").unwrap();
        let _rx = router.register(id);
        let handle = router.delivery_handle();

        router.deregister(id);

        // Must not panic or return an error.
        handle.deliver(id, serde_json::json!({"text": "dropped"}));
    }

    // AC-3: when the queue is full the subscription is evicted rather than
    // blocking or failing the producer.
    #[tokio::test(flavor = "current_thread")]
    async fn deliver_evicts_slow_subscriber_when_queue_is_full() {
        let router = ChatReplyRouter::new();
        let id = AdminSubscriptionId::parse("3").unwrap();
        let _rx = router.register(id); // hold rx so the channel stays open
        let handle = router.delivery_handle();

        // Fill the queue to capacity without consuming.
        for i in 0..REPLY_QUEUE_CAPACITY {
            handle.deliver(id, serde_json::json!({"seq": i}));
        }

        // Verify the subscription is still registered before the overflow.
        {
            let state = router.state.lock().unwrap();
            assert!(
                state.senders.contains_key(&id),
                "subscription must still be registered before overflow"
            );
        }

        // One more delivery overflows the queue — the subscription must be evicted.
        handle.deliver(id, serde_json::json!({"text": "overflow"}));

        let state = router.state.lock().unwrap();
        assert!(
            !state.senders.contains_key(&id),
            "slow subscriber must be evicted when queue is full"
        );
    }

    // AC-4: concurrent delivery from multiple cloned handles delivers all
    // payloads to the registered receiver without loss.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_delivery_from_multiple_handles_delivers_all_payloads() {
        let router = ChatReplyRouter::new();
        let id = AdminSubscriptionId::parse("4").unwrap();
        let mut rx = router.register(id);

        const SENDERS: usize = 4;
        const MSGS_PER_SENDER: usize = 8;

        let handles: Vec<_> = (0..SENDERS).map(|_| router.delivery_handle()).collect();

        // Spawn one task per handle, each delivering MSGS_PER_SENDER payloads.
        let tasks: Vec<_> = handles
            .into_iter()
            .enumerate()
            .map(|(sender_idx, handle)| {
                tokio::spawn(async move {
                    for msg_idx in 0..MSGS_PER_SENDER {
                        handle.deliver(
                            id,
                            serde_json::json!({"sender": sender_idx, "msg": msg_idx}),
                        );
                    }
                })
            })
            .collect();

        for t in tasks {
            t.await.expect("sender task must not panic");
        }

        // Collect all received payloads.
        let mut received = 0usize;
        loop {
            match rx.try_recv() {
                Ok(_) => received += 1,
                Err(_) => break,
            }
        }

        assert_eq!(
            received,
            SENDERS * MSGS_PER_SENDER,
            "all {} payloads must be received without loss",
            SENDERS * MSGS_PER_SENDER
        );
    }

    // AC-5: deregister closes the receiver so an awaiting consumer observes
    // end-of-stream.
    #[tokio::test(flavor = "current_thread")]
    async fn deregister_closes_receiver_so_consumer_observes_end_of_stream() {
        let router = ChatReplyRouter::new();
        let id = AdminSubscriptionId::parse("5").unwrap();
        let mut rx = router.register(id);

        router.deregister(id);

        // The receiver must observe end-of-stream (recv returns None).
        let result = rx.recv().await;
        assert!(
            result.is_none(),
            "receiver must observe end-of-stream after deregister"
        );
    }

    // AC-5: deregister returns true for a known id and false for an unknown one.
    #[test]
    fn deregister_returns_true_for_known_id_and_false_for_unknown() {
        let router = ChatReplyRouter::new();
        let id = AdminSubscriptionId::parse("6").unwrap();
        let _rx = router.register(id);

        assert!(
            router.deregister(id),
            "deregister of a known id must return true"
        );
        assert!(
            !router.deregister(id),
            "deregister of an already-absent id must return false"
        );
    }

    // DeliveryHandle is Clone, Send, and Sync (compile-time check).
    #[test]
    fn delivery_handle_is_clone_send_sync() {
        fn assert_send_sync<T: Send + Sync + Clone>() {}
        assert_send_sync::<DeliveryHandle>();
    }
}
