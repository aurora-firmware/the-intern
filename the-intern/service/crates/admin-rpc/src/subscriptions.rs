//! Subscription registry and fan-out bus for the admin-rpc channel.
//!
//! # Design
//!
//! Audit tail subscriptions are backed by the `monitoring` crate's
//! `subscribe_tail` API.  The [`ConnectionRegistry`] tracks active audit
//! subscription ids and holds a cancellation sender for each one.  Dropping
//! or cancelling the cancellation sender signals the associated forwarder task
//! (in `lib.rs`) to exit cleanly.
//!
//! Chat subscriptions still use the local [`SubscriptionBus`] fan-out bus
//! (Phase 2 work that remains unchanged).
//!
//! # Connection-level cleanup (AC-5)
//!
//! Each connection holds a [`ConnectionRegistry`].  When the registry is
//! dropped (connection ends) it cancels every audit subscription and removes
//! every chat subscription from the bus, preventing leaks.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use tokio::sync::{mpsc, oneshot};

/// An opaque, unique identifier for a subscription within the admin-rpc bus.
///
/// This is a monotonically increasing `u64` counter local to the admin-rpc
/// subscription bus. It is distinct from `bob_core::types::SubscriptionId`,
/// which is a UUID-based public subscription handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AdminSubscriptionId(u64);

impl std::fmt::Display for AdminSubscriptionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl AdminSubscriptionId {
    /// Parse an `AdminSubscriptionId` from its string representation.
    ///
    /// # Errors
    ///
    /// Returns `None` when the string is not a valid `u64`.
    pub fn parse(s: &str) -> Option<Self> {
        s.parse::<u64>().ok().map(AdminSubscriptionId)
    }
}

/// A record published on the local fan-out bus, used by chat subscriptions.
#[derive(Debug, Clone)]
pub struct AuditRecord {
    /// Opaque payload — the JSON representation of the event.
    pub payload: serde_json::Value,
}

/// Bounded channel capacity for each subscriber queue.
const SUBSCRIBER_CAPACITY: usize = 64;

/// State shared between all clones of a [`SubscriptionBus`].
struct BusState {
    subscribers: HashMap<AdminSubscriptionId, mpsc::Sender<AuditRecord>>,
    slow_since: HashMap<AdminSubscriptionId, Instant>,
    slow_evicted: HashSet<AdminSubscriptionId>,
    next_id: AtomicU64,
}

/// A fan-out bus that delivers [`AuditRecord`]s to every registered subscriber.
///
/// Clone-able and `Send + Sync`: multiple producers can share a single bus.
///
/// Slow subscribers (those whose bounded channel is full) are evicted
/// immediately using `try_send` so that they cannot block the bus.
#[derive(Clone)]
pub struct SubscriptionBus {
    state: Arc<Mutex<BusState>>,
    slow_subscriber_deadline: Duration,
}

impl SubscriptionBus {
    /// Create a new bus.
    ///
    pub fn new(slow_subscriber_deadline: Duration) -> Self {
        Self {
            state: Arc::new(Mutex::new(BusState {
                subscribers: HashMap::new(),
                slow_since: HashMap::new(),
                slow_evicted: HashSet::new(),
                next_id: AtomicU64::new(1),
            })),
            slow_subscriber_deadline,
        }
    }

    /// Register a new subscriber and return its id plus the receive end of the
    /// bounded channel.
    pub fn subscribe(&self) -> (AdminSubscriptionId, mpsc::Receiver<AuditRecord>) {
        let mut state = self.state.lock().expect("bus state lock poisoned");
        let id_raw = state.next_id.fetch_add(1, Ordering::Relaxed);
        let id = AdminSubscriptionId(id_raw);
        let (tx, rx) = mpsc::channel(SUBSCRIBER_CAPACITY);
        state.subscribers.insert(id, tx);
        (id, rx)
    }

    /// Remove a subscriber by id.
    ///
    /// Returns `true` when the id existed, `false` when it was already absent.
    pub fn remove(&self, id: AdminSubscriptionId) -> bool {
        let mut state = self.state.lock().expect("bus state lock poisoned");
        state.slow_since.remove(&id);
        state.slow_evicted.remove(&id);
        state.subscribers.remove(&id).is_some()
    }

    /// Returns whether `id` was evicted for exceeding the slow-subscriber
    /// deadline since the last call.
    ///
    /// The marker is consumed when read so ordinary receiver shutdown
    /// (unsubscribe/cleanup) does not look like AC-4 eviction.
    pub fn take_slow_evicted(&self, id: AdminSubscriptionId) -> bool {
        self.state
            .lock()
            .expect("bus state lock poisoned")
            .slow_evicted
            .remove(&id)
    }

    /// Publish `record` to every subscriber.
    ///
    /// Subscribers whose queues are full beyond [`Self::slow_subscriber_deadline`]
    /// are removed from the registry before this call returns. The removal is
    /// best-effort: on the next publish cycle the slot will be gone.
    ///
    /// This function is synchronous (blocking) to avoid holding the mutex across
    /// `await` points. The bounded send uses `try_send`; on first full queue we
    /// mark when saturation started, and remove only if it stays full longer
    /// than `slow_subscriber_deadline`.
    pub fn publish(&self, record: AuditRecord) {
        let mut state = self.state.lock().expect("bus state lock poisoned");
        let now = Instant::now();
        let mut to_remove = Vec::new();

        // Clone senders to avoid borrowing `state.subscribers` while mutating
        // `state.slow_since`.
        let subscribers: Vec<_> = state
            .subscribers
            .iter()
            .map(|(id, tx)| (*id, tx.clone()))
            .collect();

        for (id, tx) in subscribers {
            match tx.try_send(record.clone()) {
                Ok(()) => {
                    // Subscriber recovered and has capacity again.
                    state.slow_since.remove(&id);
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    let slow_since = state.slow_since.entry(id).or_insert(now);
                    if now.duration_since(*slow_since) >= self.slow_subscriber_deadline {
                        state.slow_evicted.insert(id);
                        to_remove.push(id);
                    }
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    // Receiver was dropped — clean up silently.
                    to_remove.push(id);
                }
            }
        }
        for id in to_remove {
            state.slow_since.remove(&id);
            state.subscribers.remove(&id);
        }
    }

    /// Returns how many active subscribers are currently registered.
    pub fn subscriber_count(&self) -> usize {
        self.state
            .lock()
            .expect("bus state lock poisoned")
            .subscribers
            .len()
    }
}

/// Kind of subscription held by the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionKind {
    /// An `audit.tail` subscription.
    Audit,
    /// A `chat` subscription.
    Chat,
}

/// Per-connection registry of subscription ids.
///
/// When the connection task exits and this value is dropped, every remaining
/// subscription is cleaned up:
/// - Audit subscriptions: their cancellation sender is dropped, signalling the
///   associated forwarder task to exit.
/// - Chat subscriptions: removed from the local [`SubscriptionBus`].
///
/// # Audit subscription lifecycle
///
/// 1. The dispatcher calls [`ConnectionRegistry::register_audit_subscription`]
///    to allocate a fresh id and receive a cancellation receiver.
/// 2. The dispatcher returns `DispatchOutcome::Subscribed` carrying both the
///    monitoring `UnboundedReceiver` and the cancellation receiver.
/// 3. `lib.rs` spawns an `audit_forwarder` task that drives both.
/// 4. On `audit.tail.unsubscribe`, the dispatcher calls
///    [`ConnectionRegistry::unsubscribe`] which drops the cancellation sender,
///    signalling the forwarder to stop.
pub struct ConnectionRegistry {
    /// Local fan-out bus — used by chat subscriptions (Phase 2).
    bus: SubscriptionBus,
    /// All open subscription ids and their kinds.
    ids: Vec<(AdminSubscriptionId, SubscriptionKind)>,
    /// Cancellation senders for active audit subscriptions.
    ///
    /// Dropping an entry signals the forwarder task to exit.
    audit_cancel_txs: HashMap<AdminSubscriptionId, oneshot::Sender<()>>,
    /// Monotonically increasing id counter for audit subscriptions.
    next_audit_id: u64,
}

impl ConnectionRegistry {
    /// Create a new, empty registry tied to `bus`.
    pub fn new(bus: SubscriptionBus) -> Self {
        Self {
            bus,
            ids: Vec::new(),
            audit_cancel_txs: HashMap::new(),
            next_audit_id: 1,
        }
    }

    /// Returns `true` when `id` is an open chat subscription on this connection.
    pub fn is_open_chat_subscription(&self, id: AdminSubscriptionId) -> bool {
        self.ids
            .iter()
            .any(|&(i, k)| i == id && k == SubscriptionKind::Chat)
    }

    /// Register a new Monitoring-backed audit subscription.
    ///
    /// Allocates a fresh [`AdminSubscriptionId`] and creates a cancellation
    /// pair.  The returned `oneshot::Receiver<()>` should be passed to the
    /// audit forwarder task so it can stop cleanly when `unsubscribe` is called
    /// or the connection closes.
    pub fn register_audit_subscription(&mut self) -> (AdminSubscriptionId, oneshot::Receiver<()>) {
        let id = AdminSubscriptionId(self.next_audit_id);
        self.next_audit_id = self.next_audit_id.saturating_add(1);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.ids.push((id, SubscriptionKind::Audit));
        self.audit_cancel_txs.insert(id, cancel_tx);
        (id, cancel_rx)
    }

    /// Remove an audit subscription explicitly (e.g. on `audit.tail.unsubscribe`).
    ///
    /// Drops the cancellation sender, which signals the associated forwarder
    /// task to exit.  Returns `true` when the id existed and was removed.
    pub fn unsubscribe(&mut self, id: AdminSubscriptionId) -> bool {
        if let Some(pos) = self
            .ids
            .iter()
            .position(|&(i, k)| i == id && k == SubscriptionKind::Audit)
        {
            self.ids.swap_remove(pos);
            // Dropping the sender signals the forwarder to exit.
            self.audit_cancel_txs.remove(&id);
            true
        } else {
            false
        }
    }

    /// Open a chat subscription.
    ///
    /// Chat subscriptions use a monotonically-increasing id but are tracked
    /// in the registry so they are cleaned up on connection close (AC-5).
    /// Chat fan-out is Phase-2 work; this call just allocates an id.
    pub fn open_chat(&mut self) -> AdminSubscriptionId {
        let (id, _rx) = self.bus.subscribe();
        self.ids.push((id, SubscriptionKind::Chat));
        id
    }

    /// Close a chat subscription explicitly (e.g. on `chat.close`).
    ///
    /// Returns `true` when the id existed and was removed.
    pub fn close_chat(&mut self, id: AdminSubscriptionId) -> bool {
        if let Some(pos) = self
            .ids
            .iter()
            .position(|&(i, k)| i == id && k == SubscriptionKind::Chat)
        {
            self.ids.swap_remove(pos);
            self.bus.remove(id)
        } else {
            false
        }
    }

    /// Iterate over all open subscription ids and their kinds.
    pub fn ids(&self) -> impl Iterator<Item = (AdminSubscriptionId, SubscriptionKind)> + '_ {
        self.ids.iter().copied()
    }

    /// How many subscriptions are currently open.
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Returns `true` when no subscriptions are open.
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}

impl Drop for ConnectionRegistry {
    fn drop(&mut self) {
        // AC-5: clean up every remaining subscription.
        for (id, kind) in self.ids.drain(..) {
            match kind {
                SubscriptionKind::Audit => {
                    // Dropping the cancellation sender signals the forwarder task to exit.
                    // The monitoring actor removes the subscriber when its receiver is dropped.
                    self.audit_cancel_txs.remove(&id);
                }
                SubscriptionKind::Chat => {
                    self.bus.remove(id);
                }
            }
        }
        // Any remaining cancel senders are dropped here automatically.
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn make_bus() -> SubscriptionBus {
        SubscriptionBus::new(Duration::from_millis(100))
    }

    fn make_record(label: &str) -> AuditRecord {
        AuditRecord {
            payload: serde_json::json!({ "event": label }),
        }
    }

    // AC-1: subscribe returns a unique AdminSubscriptionId and a receiver.
    #[test]
    fn subscribe_returns_unique_ids() {
        let bus = make_bus();
        let (id1, _rx1) = bus.subscribe();
        let (id2, _rx2) = bus.subscribe();
        assert_ne!(id1, id2, "each subscribe must yield a distinct id");
    }

    // AC-1: bus registers the subscriber (subscriber_count increases).
    #[test]
    fn subscribe_increments_subscriber_count() {
        let bus = make_bus();
        assert_eq!(bus.subscriber_count(), 0);
        let (_id, _rx) = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 1);
        let (_id2, _rx2) = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 2);
    }

    // AC-2: publish delivers the record to all subscribers.
    #[tokio::test(flavor = "current_thread")]
    async fn publish_delivers_record_to_subscriber() {
        let bus = make_bus();
        let (_id, mut rx) = bus.subscribe();

        bus.publish(make_record("session.started"));

        let received = rx.recv().await.expect("should receive a record");
        assert_eq!(received.payload["event"], "session.started");
    }

    // AC-2: publish fans out to multiple subscribers simultaneously.
    #[tokio::test(flavor = "current_thread")]
    async fn publish_fans_out_to_multiple_subscribers() {
        let bus = make_bus();
        let (_id1, mut rx1) = bus.subscribe();
        let (_id2, mut rx2) = bus.subscribe();

        bus.publish(make_record("event.a"));

        let r1 = rx1.recv().await.expect("subscriber 1 must receive");
        let r2 = rx2.recv().await.expect("subscriber 2 must receive");
        assert_eq!(r1.payload["event"], "event.a");
        assert_eq!(r2.payload["event"], "event.a");
    }

    // AC-3: remove returns true for a known id and subscriber_count decreases.
    #[test]
    fn remove_known_id_returns_true_and_decrements_count() {
        let bus = make_bus();
        let (id, _rx) = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 1);

        let removed = bus.remove(id);

        assert!(removed, "remove of a known id must return true");
        assert_eq!(bus.subscriber_count(), 0);
    }

    // AC-3: remove returns false for an unknown id.
    #[test]
    fn remove_unknown_id_returns_false() {
        let bus = make_bus();
        let ghost_id = AdminSubscriptionId(9999);
        let removed = bus.remove(ghost_id);
        assert!(!removed, "remove of unknown id must return false");
    }

    // AC-4: publish drops a subscriber only after its queue remains full
    // beyond the configured deadline.
    #[tokio::test(flavor = "current_thread")]
    async fn publish_drops_subscriber_when_queue_stays_full_past_deadline() {
        let bus = SubscriptionBus::new(Duration::from_millis(20));
        let (_id, _rx) = bus.subscribe(); // _rx is held but not consumed

        // Fill the channel to capacity without reading.
        for i in 0..SUBSCRIBER_CAPACITY {
            bus.publish(make_record(&format!("fill-{i}")));
        }

        // First overflow marks the subscription as slow but must not drop it yet.
        bus.publish(make_record("overflow-before-deadline"));
        assert_eq!(
            bus.subscriber_count(),
            1,
            "subscriber should remain registered before the deadline elapses"
        );

        // Keep the queue full past the deadline and publish again.
        tokio::time::sleep(Duration::from_millis(30)).await;
        bus.publish(make_record("overflow-after-deadline"));

        assert_eq!(
            bus.subscriber_count(),
            0,
            "overflowed subscriber must be removed after exceeding the deadline"
        );
    }

    // AC-4: after dropping a subscriber from the bus, publish no longer sends to it.
    #[tokio::test(flavor = "current_thread")]
    async fn publish_does_not_deliver_to_dropped_subscriber() {
        let bus = make_bus();
        let (id, _rx) = bus.subscribe();

        bus.remove(id);
        bus.publish(make_record("should_not_arrive"));

        assert_eq!(bus.subscriber_count(), 0);
    }

    // AC-5: ConnectionRegistry drop cancels all audit subscriptions (cancel senders are dropped).
    #[test]
    fn connection_registry_drop_cancels_all_audit_subscriptions() {
        let bus = make_bus();
        let (cancel_rx1, cancel_rx2) = {
            let mut registry = ConnectionRegistry::new(bus.clone());
            let (_id1, cancel_rx1) = registry.register_audit_subscription();
            let (_id2, cancel_rx2) = registry.register_audit_subscription();
            assert_eq!(registry.len(), 2);
            (cancel_rx1, cancel_rx2)
            // registry drops here — cancel senders are dropped
        };
        // Both cancel receivers should now see the sender was dropped (i.e., cancelled).
        assert!(
            cancel_rx1.blocking_recv().is_err(),
            "cancel_rx1 should be cancelled when registry drops"
        );
        assert!(
            cancel_rx2.blocking_recv().is_err(),
            "cancel_rx2 should be cancelled when registry drops"
        );
        // Chat bus is unchanged — no audit subscriptions registered on the bus.
        assert_eq!(bus.subscriber_count(), 0);
    }

    // AC-5: ConnectionRegistry::unsubscribe removes a single audit subscription.
    #[test]
    fn connection_registry_unsubscribe_removes_single_subscription() {
        let bus = make_bus();
        let mut registry = ConnectionRegistry::new(bus.clone());
        let (id1, _cancel_rx1) = registry.register_audit_subscription();
        let (_id2, _cancel_rx2) = registry.register_audit_subscription();

        let removed = registry.unsubscribe(id1);

        assert!(removed, "unsubscribe of a known id must return true");
        assert_eq!(
            registry.len(),
            1,
            "only the unsubscribed subscription should be gone from the registry"
        );
        // Audit subscriptions are not on the bus.
        assert_eq!(bus.subscriber_count(), 0);
    }

    // AC-5: unsubscribe returns false for an id not in the registry.
    #[test]
    fn connection_registry_unsubscribe_unknown_id_returns_false() {
        let bus = make_bus();
        let mut registry = ConnectionRegistry::new(bus.clone());
        let ghost_id = AdminSubscriptionId(9999);

        let removed = registry.unsubscribe(ghost_id);

        assert!(!removed, "unsubscribing an unknown id must return false");
    }

    // AC-5 (T-063): unsubscribe drops the cancellation sender, signalling the forwarder.
    #[test]
    fn connection_registry_unsubscribe_signals_cancellation_to_forwarder() {
        let bus = make_bus();
        let mut registry = ConnectionRegistry::new(bus.clone());
        let (id, cancel_rx) = registry.register_audit_subscription();

        // Explicit unsubscribe should cancel the forwarder.
        registry.unsubscribe(id);

        assert!(
            cancel_rx.blocking_recv().is_err(),
            "cancel_rx must be signalled (sender dropped) after unsubscribe"
        );
    }

    // chat.open / chat.close round-trip removes the chat subscription.
    #[test]
    fn connection_registry_chat_open_close_round_trips() {
        let bus = make_bus();
        let mut registry = ConnectionRegistry::new(bus.clone());

        let id = registry.open_chat();
        assert_eq!(bus.subscriber_count(), 1);

        let closed = registry.close_chat(id);
        assert!(closed, "close_chat of a known id must return true");
        assert_eq!(bus.subscriber_count(), 0);
    }

    // chat.close returns false for an unknown id.
    #[test]
    fn connection_registry_chat_close_unknown_id_returns_false() {
        let bus = make_bus();
        let mut registry = ConnectionRegistry::new(bus.clone());
        let ghost_id = AdminSubscriptionId(9999);

        assert!(!registry.close_chat(ghost_id));
    }

    // registry len / is_empty reflect open subscriptions.
    #[test]
    fn connection_registry_len_and_is_empty_are_accurate() {
        let bus = make_bus();
        let mut registry = ConnectionRegistry::new(bus.clone());
        assert!(registry.is_empty());
        let (_id, _cancel_rx) = registry.register_audit_subscription();
        assert_eq!(registry.len(), 1);
        assert!(!registry.is_empty());
    }

    // AdminSubscriptionId can be displayed as a string.
    #[test]
    fn admin_subscription_id_display_is_the_inner_u64() {
        let id = AdminSubscriptionId(42);
        assert_eq!(id.to_string(), "42");
    }

    // AdminSubscriptionId::parse round-trips with Display.
    #[test]
    fn admin_subscription_id_parse_round_trips_with_display() {
        let id = AdminSubscriptionId(7);
        let parsed = AdminSubscriptionId::parse(&id.to_string());
        assert_eq!(parsed, Some(id));
    }

    // AdminSubscriptionId::parse returns None for non-numeric input.
    #[test]
    fn admin_subscription_id_parse_returns_none_for_non_numeric_string() {
        assert!(AdminSubscriptionId::parse("not-a-number").is_none());
    }

    // AC-2 (T-042): AdminSubscriptionId is the bus-local u64 counter type and
    // is distinct from the name SubscriptionId.
    #[test]
    fn admin_subscription_id_is_the_bus_local_u64_type() {
        let id = AdminSubscriptionId(1);
        assert_eq!(id.to_string(), "1");
        let parsed = AdminSubscriptionId::parse("42");
        assert_eq!(parsed, Some(AdminSubscriptionId(42)));
        assert!(AdminSubscriptionId::parse("not-a-number").is_none());
    }
}
