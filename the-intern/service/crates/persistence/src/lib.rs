#![forbid(unsafe_code)]

mod inbound;
mod session_state;

use async_trait::async_trait;
use bob_core::error::{ServiceError, ServiceResult};
use bob_core::ports::{PersistenceStore, SessionState};
use bob_core::types::{InternalEvent, SessionId};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::inbound::InboundQueue;
use crate::session_state::SessionStateStore;

/// Configuration for the persistence actor.
#[derive(Debug, Clone)]
pub struct Config {
    /// Size of the internal command channel buffer.
    pub command_buffer: usize,
    /// Maximum number of inbound events the queue can hold.
    pub persistence_inbound_capacity: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            command_buffer: 64,
            persistence_inbound_capacity: 1024,
        }
    }
}

// ---------------------------------------------------------------------------
// Internal command protocol
// ---------------------------------------------------------------------------

type Reply<T> = oneshot::Sender<ServiceResult<T>>;

enum Command {
    Enqueue {
        event: InternalEvent,
        job_id: Option<String>,
        reply: Reply<()>,
    },
    DequeueNext {
        reply: Reply<Option<(InternalEvent, Option<String>)>>,
    },
    PutSessionState {
        id: SessionId,
        state: SessionState,
        reply: Reply<()>,
    },
    GetSessionState {
        id: SessionId,
        reply: Reply<Option<SessionState>>,
    },
}

// ---------------------------------------------------------------------------
// Public handle — implements PersistenceStore
// ---------------------------------------------------------------------------

/// A cheap-to-clone handle to the persistence actor.
#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Command>,
}

impl Handle {
    /// Sends a command to the actor and awaits the reply.
    ///
    /// Returns `ServiceError::Persistence` if the actor is no longer running.
    async fn send<T>(&self, make_cmd: impl FnOnce(Reply<T>) -> Command) -> ServiceResult<T> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let cmd = make_cmd(reply_tx);
        self.tx
            .send(cmd)
            .await
            .map_err(|_| ServiceError::Persistence {
                detail: "persistence actor is not running".to_owned(),
            })?;
        reply_rx.await.map_err(|_| ServiceError::Persistence {
            detail: "persistence actor dropped reply channel".to_owned(),
        })?
    }
}

#[async_trait]
impl PersistenceStore for Handle {
    /// Appends `event` to the inbound queue.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the queue is at capacity or the actor is down.
    async fn enqueue(&self, event: InternalEvent) -> ServiceResult<()> {
        self.send(|reply| Command::Enqueue {
            event,
            job_id: None,
            reply,
        })
        .await
    }

    /// Removes and returns the oldest inbound event.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the actor is down.
    async fn dequeue_next(&self) -> ServiceResult<Option<InternalEvent>> {
        let result = self.send(|reply| Command::DequeueNext { reply }).await?;
        Ok(result.map(|(event, _job_id)| event))
    }

    /// Appends `event` to the inbound queue together with its job-id
    /// correlator (ADR-013).
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the queue is at capacity or the actor is down.
    async fn enqueue_with_job_id(
        &self,
        event: InternalEvent,
        job_id: Option<String>,
    ) -> ServiceResult<()> {
        self.send(|reply| Command::Enqueue {
            event,
            job_id,
            reply,
        })
        .await
    }

    /// Removes and returns the oldest inbound event together with the
    /// job-id correlator it was enqueued with (ADR-013).
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the actor is down.
    async fn dequeue_next_with_job_id(
        &self,
    ) -> ServiceResult<Option<(InternalEvent, Option<String>)>> {
        self.send(|reply| Command::DequeueNext { reply }).await
    }

    /// Stores `state` for `id`, overwriting any existing entry.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the actor is down.
    async fn put_session_state(&self, id: SessionId, state: SessionState) -> ServiceResult<()> {
        self.send(|reply| Command::PutSessionState { id, state, reply })
            .await
    }

    /// Returns the stored state for `id`, or `None` when absent.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Persistence` when the actor is down.
    async fn get_session_state(&self, id: SessionId) -> ServiceResult<Option<SessionState>> {
        self.send(|reply| Command::GetSessionState { id, reply })
            .await
    }
}

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

struct Actor {
    cfg: Config,
    rx: mpsc::Receiver<Command>,
    inbound: InboundQueue,
    session_state: SessionStateStore,
}

impl Actor {
    fn new(cfg: Config, rx: mpsc::Receiver<Command>) -> Self {
        let inbound = InboundQueue::new(cfg.persistence_inbound_capacity);
        Self {
            cfg,
            rx,
            inbound,
            session_state: SessionStateStore::new(),
        }
    }

    async fn run(mut self) {
        tracing::info!(
            command_buffer = self.cfg.command_buffer,
            inbound_capacity = self.cfg.persistence_inbound_capacity,
            "persistence actor started"
        );
        while let Some(command) = self.rx.recv().await {
            match command {
                Command::Enqueue {
                    event,
                    job_id,
                    reply,
                } => {
                    let result = self.inbound.enqueue(event, job_id);
                    let _ = reply.send(result);
                }
                Command::DequeueNext { reply } => {
                    let result = Ok(self.inbound.dequeue_next());
                    let _ = reply.send(result);
                }
                Command::PutSessionState { id, state, reply } => {
                    self.session_state.put(id, state);
                    let _ = reply.send(Ok(()));
                }
                Command::GetSessionState { id, reply } => {
                    let result = Ok(self.session_state.get(id));
                    let _ = reply.send(result);
                }
            }
        }
        tracing::info!("persistence actor stopped");
    }
}

// ---------------------------------------------------------------------------
// Public constructor
// ---------------------------------------------------------------------------

/// Starts the persistence actor and returns a handle to it.
pub fn start(cfg: Config) -> (Handle, JoinHandle<()>) {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let actor = Actor::new(cfg, rx);
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    (Handle { tx }, join)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bob_core::error::ServiceError;
    use bob_core::ports::PersistenceStore;
    use bob_core::types::DeliveryKind;

    fn small_cfg() -> Config {
        Config {
            command_buffer: 8,
            persistence_inbound_capacity: 3,
        }
    }

    // AC-1: enqueue with capacity stores event, returns Ok(())
    #[tokio::test(flavor = "current_thread")]
    async fn enqueue_returns_ok_when_queue_has_capacity() {
        let (handle, task) = start(small_cfg());
        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "hello".to_owned(),
        };

        let result = handle.enqueue(event).await;

        assert!(result.is_ok());
        task.abort();
    }

    // AC-2: dequeue_next returns oldest stored event in FIFO order
    #[tokio::test(flavor = "current_thread")]
    async fn dequeue_next_returns_events_in_fifo_order() {
        let (handle, task) = start(small_cfg());
        let first = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "first".to_owned(),
        };
        let second = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "second".to_owned(),
        };
        handle.enqueue(first.clone()).await.unwrap();
        handle.enqueue(second.clone()).await.unwrap();

        assert_eq!(handle.dequeue_next().await.unwrap(), Some(first));
        assert_eq!(handle.dequeue_next().await.unwrap(), Some(second));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dequeue_next_returns_none_when_queue_is_empty() {
        let (handle, task) = start(small_cfg());

        let result = handle.dequeue_next().await.unwrap();

        assert!(result.is_none());
        task.abort();
    }

    // AC-3: enqueue at capacity returns Err without dropping existing entries
    #[tokio::test(flavor = "current_thread")]
    async fn enqueue_at_capacity_returns_persistence_error() {
        let (handle, task) = start(small_cfg()); // capacity = 3
        let event = || InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };
        handle.enqueue(event()).await.unwrap();
        handle.enqueue(event()).await.unwrap();
        handle.enqueue(event()).await.unwrap();

        let result = handle.enqueue(event()).await;

        assert!(matches!(result, Err(ServiceError::Persistence { .. })));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn enqueue_at_capacity_does_not_drop_existing_entries() {
        let (handle, task) = start(small_cfg()); // capacity = 3
        let first = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "keep_me".to_owned(),
        };
        let filler = || InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };
        handle.enqueue(first.clone()).await.unwrap();
        handle.enqueue(filler()).await.unwrap();
        handle.enqueue(filler()).await.unwrap();
        // Overflow — must not evict existing entries.
        let _ = handle.enqueue(filler()).await;

        // First entry is still present and dequeues correctly.
        let got = handle.dequeue_next().await.unwrap();
        assert_eq!(got, Some(first));
        task.abort();
    }

    // AC-1 / AC-2: enqueuing with a job-id correlator yields the same
    // correlator on dequeue (ADR-013).
    #[tokio::test(flavor = "current_thread")]
    async fn dequeue_next_with_job_id_returns_the_correlator_it_was_enqueued_with() {
        let (handle, task) = start(small_cfg());
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };

        handle
            .enqueue_with_job_id(event.clone(), Some("job-1".to_owned()))
            .await
            .unwrap();
        let got = handle.dequeue_next_with_job_id().await.unwrap();

        assert_eq!(got, Some((event, Some("job-1".to_owned()))));
        task.abort();
    }

    // AC-3: enqueuing without a correlator dequeues with an absent correlator.
    #[tokio::test(flavor = "current_thread")]
    async fn dequeue_next_with_job_id_returns_absent_correlator_when_enqueued_without_one() {
        let (handle, task) = start(small_cfg());
        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "hello".to_owned(),
        };

        handle.enqueue(event.clone()).await.unwrap();
        let got = handle.dequeue_next_with_job_id().await.unwrap();

        assert_eq!(got, Some((event, None)));
        task.abort();
    }

    // AC-4: FIFO ordering is preserved when correlators are carried alongside events.
    #[tokio::test(flavor = "current_thread")]
    async fn dequeue_next_with_job_id_returns_entries_in_fifo_order() {
        let (handle, task) = start(small_cfg());
        let first = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "first".to_owned(),
        };
        let second = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "second".to_owned(),
        };

        handle
            .enqueue_with_job_id(first.clone(), Some("job-1".to_owned()))
            .await
            .unwrap();
        handle
            .enqueue_with_job_id(second.clone(), Some("job-2".to_owned()))
            .await
            .unwrap();

        assert_eq!(
            handle.dequeue_next_with_job_id().await.unwrap(),
            Some((first, Some("job-1".to_owned())))
        );
        assert_eq!(
            handle.dequeue_next_with_job_id().await.unwrap(),
            Some((second, Some("job-2".to_owned())))
        );
        task.abort();
    }

    // AC-4: the capacity limit is preserved when a correlator is carried.
    #[tokio::test(flavor = "current_thread")]
    async fn enqueue_with_job_id_at_capacity_returns_persistence_error() {
        let (handle, task) = start(small_cfg()); // capacity = 3
        let event = || InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };
        handle
            .enqueue_with_job_id(event(), Some("job-1".to_owned()))
            .await
            .unwrap();
        handle
            .enqueue_with_job_id(event(), Some("job-2".to_owned()))
            .await
            .unwrap();
        handle
            .enqueue_with_job_id(event(), Some("job-3".to_owned()))
            .await
            .unwrap();

        let result = handle
            .enqueue_with_job_id(event(), Some("job-4".to_owned()))
            .await;

        assert!(matches!(result, Err(ServiceError::Persistence { .. })));
        task.abort();
    }

    // AC-4: put_session_state then get_session_state returns equal value
    #[tokio::test(flavor = "current_thread")]
    async fn get_session_state_returns_stored_value() {
        let (handle, task) = start(small_cfg());
        let id = SessionId::new();
        let state = SessionState {
            data: r#"{"key":"value"}"#.to_owned(),
        };

        handle.put_session_state(id, state.clone()).await.unwrap();
        let got = handle.get_session_state(id).await.unwrap();

        assert_eq!(got, Some(state));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_session_state_returns_none_when_not_stored() {
        let (handle, task) = start(small_cfg());
        let id = SessionId::new();

        let result = handle.get_session_state(id).await.unwrap();

        assert!(result.is_none());
        task.abort();
    }

    // AC-5: Handle implements PersistenceStore (verified by the trait bound
    // used in the helper functions above — if it did not compile,
    // AC-5 would fail at compile time)
    #[tokio::test(flavor = "current_thread")]
    async fn handle_implements_persistence_store_trait() {
        fn accepts_store<S: PersistenceStore>(_store: &S) {}
        let (handle, task) = start(small_cfg());
        accepts_store(&handle);
        task.abort();
    }

    // Misc
    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, task) = start(Config::default());
        let _clone = handle.clone();
        task.abort();
    }
}
