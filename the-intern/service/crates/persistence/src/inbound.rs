#![forbid(unsafe_code)]

//! In-memory inbound event queue backed by a fixed-capacity ring buffer.
//!
//! Events are stored in FIFO order alongside an optional job-id correlator
//! (ADR-013). When the buffer is at capacity, `enqueue` returns
//! `Err(ServiceError::Persistence { .. })` without dropping existing entries.

use std::collections::VecDeque;

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::types::InternalEvent;

/// Fixed-capacity in-memory ring buffer for inbound events.
///
/// Ordering is FIFO: `enqueue` appends to the back; `dequeue_next` removes from the front.
/// Each entry carries an optional job-id correlator (ADR-013) alongside its event.
pub(crate) struct InboundQueue {
    capacity: usize,
    queue: VecDeque<(InternalEvent, Option<String>)>,
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

    /// Appends `event` and its optional job-id correlator to the back of the queue.
    ///
    /// Returns `Ok(())` when there is space, or
    /// `Err(ServiceError::Persistence { detail })` when the queue is full.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the queue is at capacity.
    pub(crate) fn enqueue(
        &mut self,
        event: InternalEvent,
        job_id: Option<String>,
    ) -> ServiceResult<()> {
        if self.queue.len() >= self.capacity {
            return Err(ServiceError::Persistence {
                detail: "inbound queue at capacity".to_owned(),
            });
        }
        self.queue.push_back((event, job_id));
        Ok(())
    }

    /// Removes and returns the oldest event (FIFO front) together with the
    /// job-id correlator it was enqueued with, or `None` when empty.
    pub(crate) fn dequeue_next(&mut self) -> Option<(InternalEvent, Option<String>)> {
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
    use bob_core::types::DeliveryKind;

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
        let result = q.enqueue(chat("hello"), None);
        assert!(result.is_ok());
    }

    #[test]
    fn enqueue_increments_queue_length() {
        let mut q = InboundQueue::new(4);
        q.enqueue(chat("a"), None).unwrap();
        q.enqueue(chat("b"), None).unwrap();
        assert_eq!(q.len(), 2);
    }

    // AC-2: dequeue_next returns oldest stored event in FIFO order
    #[test]
    fn dequeue_next_returns_oldest_event_first() {
        let mut q = InboundQueue::new(4);
        q.enqueue(chat("first"), None).unwrap();
        q.enqueue(chat("second"), None).unwrap();
        q.enqueue(chat("third"), None).unwrap();

        assert_eq!(q.dequeue_next(), Some((chat("first"), None)));
        assert_eq!(q.dequeue_next(), Some((chat("second"), None)));
        assert_eq!(q.dequeue_next(), Some((chat("third"), None)));
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
        q.enqueue(chat("a"), None).unwrap();
        q.enqueue(chat("b"), None).unwrap();

        let result = q.enqueue(chat("overflow"), None);
        assert!(matches!(result, Err(ServiceError::Persistence { .. })));
    }

    #[test]
    fn enqueue_at_capacity_does_not_drop_existing_entries() {
        let mut q = InboundQueue::new(2);
        q.enqueue(chat("a"), None).unwrap();
        q.enqueue(chat("b"), None).unwrap();

        // Overflow attempt — must not alter existing entries.
        let _ = q.enqueue(chat("overflow"), None);

        assert_eq!(q.len(), 2);
        assert_eq!(q.dequeue_next(), Some((chat("a"), None)));
        assert_eq!(q.dequeue_next(), Some((chat("b"), None)));
    }

    #[test]
    fn enqueue_after_dequeue_succeeds_when_space_freed() {
        let mut q = InboundQueue::new(1);
        q.enqueue(chat("first"), None).unwrap();
        q.dequeue_next();
        let result = q.enqueue(chat("second"), None);
        assert!(result.is_ok());
    }

    // AC-1 / AC-2: enqueuing with a job-id correlator yields the same
    // correlator on dequeue.
    #[test]
    fn dequeue_next_returns_the_job_id_correlator_it_was_enqueued_with() {
        let mut q = InboundQueue::new(4);
        q.enqueue(chat("tick"), Some("job-1".to_owned())).unwrap();

        let result = q.dequeue_next();

        assert_eq!(result, Some((chat("tick"), Some("job-1".to_owned()))));
    }

    // AC-3: enqueuing without a correlator dequeues with an absent correlator.
    #[test]
    fn dequeue_next_returns_absent_correlator_when_enqueued_without_one() {
        let mut q = InboundQueue::new(4);
        q.enqueue(chat("tick"), None).unwrap();

        let result = q.dequeue_next();

        assert_eq!(result, Some((chat("tick"), None)));
    }

    // AC-4: FIFO ordering is preserved when correlators are carried alongside events.
    #[test]
    fn dequeue_next_returns_job_id_correlators_in_fifo_order() {
        let mut q = InboundQueue::new(4);
        q.enqueue(chat("first"), Some("job-1".to_owned())).unwrap();
        q.enqueue(chat("second"), None).unwrap();
        q.enqueue(chat("third"), Some("job-3".to_owned())).unwrap();

        assert_eq!(
            q.dequeue_next(),
            Some((chat("first"), Some("job-1".to_owned())))
        );
        assert_eq!(q.dequeue_next(), Some((chat("second"), None)));
        assert_eq!(
            q.dequeue_next(),
            Some((chat("third"), Some("job-3".to_owned())))
        );
    }

    // AC-4: the capacity limit is preserved when a correlator is carried.
    #[test]
    fn enqueue_with_job_id_at_capacity_returns_persistence_error() {
        let mut q = InboundQueue::new(2);
        q.enqueue(chat("a"), Some("job-1".to_owned())).unwrap();
        q.enqueue(chat("b"), None).unwrap();

        let result = q.enqueue(chat("overflow"), Some("job-3".to_owned()));

        assert!(matches!(result, Err(ServiceError::Persistence { .. })));
        assert_eq!(q.len(), 2);
    }
}
