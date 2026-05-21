#![forbid(unsafe_code)]

//! In-memory inbound event queue backed by a fixed-capacity ring buffer.
//!
//! Events are stored in FIFO order. When the buffer is at capacity, `enqueue`
//! returns `Err(ServiceError::Persistence { .. })` without dropping existing entries.

use std::collections::VecDeque;

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::types::{DeliveryKind, InternalEvent};

/// Fixed-capacity in-memory ring buffer for inbound events.
///
/// Ordering is FIFO: `enqueue` appends to the back; `dequeue_next` removes from the front.
pub(crate) struct InboundQueue {
    capacity: usize,
    queue: VecDeque<InternalEvent>,
}

impl InboundQueue {
    /// Creates a new queue with the given capacity.
    ///
    /// # Panics
    ///
    /// Panics if `capacity` is zero. A zero-capacity queue cannot store any
    /// events and is a configuration error.
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(
            capacity > 0,
            "inbound queue capacity must be greater than zero"
        );
        Self {
            capacity,
            queue: VecDeque::with_capacity(capacity),
        }
    }

    /// Appends `event` to the back of the queue.
    ///
    /// Returns `Ok(())` when there is space, or
    /// `Err(ServiceError::Persistence { detail })` when the queue is full.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the queue is at capacity.
    pub(crate) fn enqueue(&mut self, event: InternalEvent) -> ServiceResult<()> {
        if self.queue.len() >= self.capacity {
            return Err(ServiceError::Persistence {
                detail: "inbound queue at capacity".to_owned(),
            });
        }
        self.queue.push_back(event);
        Ok(())
    }

    /// Removes and returns the oldest event (FIFO front), or `None` when empty.
    pub(crate) fn dequeue_next(&mut self) -> Option<InternalEvent> {
        self.queue.pop_front()
    }

    /// Returns the current number of events held in the queue.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.queue.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(content: &str) -> InternalEvent {
        InternalEvent {
            kind: DeliveryKind::Sync,
            payload: content.to_owned(),
        }
    }

    // AC-1: enqueue with capacity stores the event and returns Ok(())
    #[test]
    fn enqueue_returns_ok_when_queue_has_capacity() {
        let mut q = InboundQueue::new(4);
        let result = q.enqueue(chat("hello"));
        assert!(result.is_ok());
    }

    #[test]
    fn enqueue_increments_queue_length() {
        let mut q = InboundQueue::new(4);
        q.enqueue(chat("a")).unwrap();
        q.enqueue(chat("b")).unwrap();
        assert_eq!(q.len(), 2);
    }

    // AC-2: dequeue_next returns oldest stored event in FIFO order
    #[test]
    fn dequeue_next_returns_oldest_event_first() {
        let mut q = InboundQueue::new(4);
        q.enqueue(chat("first")).unwrap();
        q.enqueue(chat("second")).unwrap();
        q.enqueue(chat("third")).unwrap();

        assert_eq!(q.dequeue_next(), Some(chat("first")));
        assert_eq!(q.dequeue_next(), Some(chat("second")));
        assert_eq!(q.dequeue_next(), Some(chat("third")));
    }

    #[test]
    fn dequeue_next_returns_none_when_queue_is_empty() {
        let mut q = InboundQueue::new(4);
        assert_eq!(q.dequeue_next(), None);
    }

    // AC-3: enqueue at capacity returns Err without dropping existing entries
    #[test]
    fn enqueue_at_capacity_returns_persistence_error() {
        let mut q = InboundQueue::new(2);
        q.enqueue(chat("a")).unwrap();
        q.enqueue(chat("b")).unwrap();

        let result = q.enqueue(chat("overflow"));
        assert!(matches!(result, Err(ServiceError::Persistence { .. })));
    }

    #[test]
    fn enqueue_at_capacity_does_not_drop_existing_entries() {
        let mut q = InboundQueue::new(2);
        q.enqueue(chat("a")).unwrap();
        q.enqueue(chat("b")).unwrap();

        // Overflow attempt — must not alter existing entries.
        let _ = q.enqueue(chat("overflow"));

        assert_eq!(q.len(), 2);
        assert_eq!(q.dequeue_next(), Some(chat("a")));
        assert_eq!(q.dequeue_next(), Some(chat("b")));
    }

    #[test]
    fn enqueue_after_dequeue_succeeds_when_space_freed() {
        let mut q = InboundQueue::new(1);
        q.enqueue(chat("first")).unwrap();
        q.dequeue_next();
        let result = q.enqueue(chat("second"));
        assert!(result.is_ok());
    }
}
