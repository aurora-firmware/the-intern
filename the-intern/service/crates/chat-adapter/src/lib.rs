#![forbid(unsafe_code)]

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::types::{ChannelId, DeliveryKind, InternalEvent, RequestContext, UserId};
use requests_handler::Handle as IntakeHandle;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::info;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single chat input frame arriving from a peer.
///
/// The adapter normalises this into an `InternalEvent` and submits it to the
/// requests-handler intake path without applying any policy logic.
#[derive(Debug, Clone)]
pub struct ChatFrame {
    /// Text message sent by the peer.
    pub message: String,
    /// The identity of the peer who sent the message.
    pub peer_id: UserId,
    /// Conversational context identifier, if any.
    pub context_id: Option<String>,
    /// The string form of the originating chat subscription id.
    ///
    /// Carried so the reply producer can address replies without consulting
    /// any other component.
    pub subscription_id: String,
}

// ---------------------------------------------------------------------------
// Frame-delivery handle
// ---------------------------------------------------------------------------

/// Cloneable handle used to deliver chat frames to the adapter actor.
///
/// Obtaining a `FrameHandle` is the only way external code (e.g. the
/// admin-RPC actor) interacts with the chat adapter.  The adapter itself
/// normalises each frame and submits it to the requests-handler — no policy
/// decisions are made here.
#[derive(Clone)]
pub struct FrameHandle {
    tx: mpsc::Sender<ChatFrame>,
    /// Fixed channel id representing the chat channel.
    channel_id: ChannelId,
}

impl FrameHandle {
    /// Deliver a `ChatFrame` to the adapter.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::Shutdown` when the adapter actor has stopped.
    pub async fn deliver(&self, frame: ChatFrame) -> ServiceResult<()> {
        self.tx
            .send(frame)
            .await
            .map_err(|_| ServiceError::Shutdown)
    }

    /// The channel id this adapter is associated with.
    #[must_use]
    pub fn channel_id(&self) -> ChannelId {
        self.channel_id
    }
}

// ---------------------------------------------------------------------------
// Internal actor
// ---------------------------------------------------------------------------

struct Actor {
    rx: mpsc::Receiver<ChatFrame>,
    intake: IntakeHandle,
    channel_id: ChannelId,
}

impl Actor {
    async fn run(mut self) {
        info!("chat-adapter actor started");
        while let Some(frame) = self.rx.recv().await {
            // Normalise: kind is always Sync for interactive chat.
            let event = InternalEvent {
                kind: DeliveryKind::Sync,
                payload: frame.message,
            };
            let context = RequestContext {
                sender: frame.peer_id,
                source: self.channel_id,
                context_id: frame.context_id,
                reply_address: Some(frame.subscription_id),
            };
            if let Err(err) = self.intake.submit_event(event, context).await {
                tracing::warn!(error = %err, "chat-adapter: intake submit failed");
            }
        }
        info!("chat-adapter actor stopped");
    }
}

// ---------------------------------------------------------------------------
// Public constructor
// ---------------------------------------------------------------------------

/// Starts the chat-adapter actor.
///
/// Returns:
/// - A [`FrameHandle`] that callers use to deliver chat frames.  The handle is
///   cheaply cloneable; all clones share the same actor.
/// - A [`JoinHandle`] for the spawned actor task.  Await it after dropping (or
///   closing) the last `FrameHandle` to ensure a clean shutdown.
///
/// The `channel_id` argument identifies the chat channel in every
/// `RequestContext` built by this adapter.
#[must_use]
pub fn start(
    intake: IntakeHandle,
    channel_id: ChannelId,
    frame_buffer: usize,
) -> (FrameHandle, JoinHandle<()>) {
    let buffer = frame_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let handle = FrameHandle { tx, channel_id };
    let actor = Actor {
        rx,
        intake,
        channel_id,
    };
    let join = tokio::spawn(actor.run());
    (handle, join)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use bob_core::types::{ChannelId, DeliveryKind, InternalEvent, RequestContext, UserId};
    use requests_handler::{start_with, Config as QueueConfig};
    use tokio::sync::watch;

    use super::{start, ChatFrame};

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn make_intake(
        received: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>>,
    ) -> (
        requests_handler::Handle,
        tokio::task::JoinHandle<()>,
        watch::Sender<bool>,
    ) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (handle, task) = start_with(
            cfg,
            move |(ev, ctx)| {
                let r = received.clone();
                async move {
                    r.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );
        (handle, task, cancel_tx)
    }

    // -----------------------------------------------------------------------
    // AC-2: frame is normalised to InternalEvent{kind=Sync, payload=message}
    //        with a matching RequestContext and submitted to the intake handle
    // -----------------------------------------------------------------------

    // AC-2: a delivered chat frame is normalised and reaches the intake handle.
    #[tokio::test(flavor = "current_thread")]
    async fn delivered_frame_is_normalised_to_sync_event_and_submitted_to_intake() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, intake_task, cancel_tx) = make_intake(received.clone());

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = start(intake, channel_id, 16);

        let peer_id = UserId::new();
        let frame = ChatFrame {
            message: "hello world".to_owned(),
            peer_id,
            context_id: Some("conv-001".to_owned()),
            subscription_id: "sub-001".to_owned(),
        };
        frame_handle
            .deliver(frame)
            .await
            .expect("deliver must succeed");

        // Give the actor time to forward the event to the intake queue.
        tokio::task::yield_now().await;

        // Shut down the intake actor and collect.
        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1, "exactly one pair must be received");
        let (ev, ctx) = &got[0];
        assert_eq!(ev.kind, DeliveryKind::Sync, "delivery kind must be Sync");
        assert_eq!(
            ev.payload, "hello world",
            "payload must be the message text"
        );
        assert_eq!(ctx.sender, peer_id, "sender must be the peer UserId");
        assert_eq!(ctx.source, channel_id, "source must be the chat ChannelId");
        assert_eq!(
            ctx.context_id,
            Some("conv-001".to_owned()),
            "context_id must be forwarded from the frame"
        );
    }

    // AC-2: context_id None is forwarded correctly.
    #[tokio::test(flavor = "current_thread")]
    async fn delivered_frame_with_no_context_id_produces_request_context_with_none() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, intake_task, cancel_tx) = make_intake(received.clone());

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = start(intake, channel_id, 16);

        let peer_id = UserId::new();
        let frame = ChatFrame {
            message: "ping".to_owned(),
            peer_id,
            context_id: None,
            subscription_id: "sub-002".to_owned(),
        };
        frame_handle
            .deliver(frame)
            .await
            .expect("deliver must succeed");

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1);
        let (ev, ctx) = &got[0];
        assert_eq!(ev.kind, DeliveryKind::Sync);
        assert_eq!(ev.payload, "ping");
        assert!(ctx.context_id.is_none(), "context_id must be None");
    }

    // AC-2: multiple frames are all submitted in order.
    #[tokio::test(flavor = "current_thread")]
    async fn multiple_frames_are_all_normalised_and_submitted_to_intake() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, intake_task, cancel_tx) = make_intake(received.clone());

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = start(intake, channel_id, 16);

        let peer_a = UserId::new();
        let peer_b = UserId::new();

        frame_handle
            .deliver(ChatFrame {
                message: "msg-a".to_owned(),
                peer_id: peer_a,
                context_id: None,
                subscription_id: "sub-003a".to_owned(),
            })
            .await
            .unwrap();
        frame_handle
            .deliver(ChatFrame {
                message: "msg-b".to_owned(),
                peer_id: peer_b,
                context_id: Some("ctx-2".to_owned()),
                subscription_id: "sub-003b".to_owned(),
            })
            .await
            .unwrap();

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 2, "both frames must be submitted");
        assert_eq!(got[0].0.payload, "msg-a");
        assert_eq!(got[0].1.sender, peer_a);
        assert_eq!(got[1].0.payload, "msg-b");
        assert_eq!(got[1].1.sender, peer_b);
        assert_eq!(got[1].1.context_id, Some("ctx-2".to_owned()));
    }

    // -----------------------------------------------------------------------
    // AC-3: FrameHandle is cloneable; start returns (FrameHandle, JoinHandle)
    // -----------------------------------------------------------------------

    // AC-3: FrameHandle is Clone.
    #[tokio::test(flavor = "current_thread")]
    async fn frame_handle_is_cloneable() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, _intake_task, _cancel_tx) = make_intake(received);
        let channel_id = ChannelId::new();
        let (handle, actor_task) = start(intake, channel_id, 8);
        let _cloned = handle.clone();
        actor_task.abort();
    }

    // AC-3: two clones of FrameHandle deliver frames to the same actor.
    #[tokio::test(flavor = "current_thread")]
    async fn two_clones_of_frame_handle_both_reach_the_same_actor() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, intake_task, cancel_tx) = make_intake(received.clone());

        let channel_id = ChannelId::new();
        let (handle1, _actor_task) = start(intake, channel_id, 16);
        let handle2 = handle1.clone();

        handle1
            .deliver(ChatFrame {
                message: "from-clone-1".to_owned(),
                peer_id: UserId::new(),
                context_id: None,
                subscription_id: "sub-004a".to_owned(),
            })
            .await
            .unwrap();
        handle2
            .deliver(ChatFrame {
                message: "from-clone-2".to_owned(),
                peer_id: UserId::new(),
                context_id: None,
                subscription_id: "sub-004b".to_owned(),
            })
            .await
            .unwrap();

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 2, "both frames from cloned handles must arrive");
    }

    // AC-3: channel_id on the handle matches the one passed to start.
    #[tokio::test(flavor = "current_thread")]
    async fn frame_handle_channel_id_matches_start_argument() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, _intake_task, _cancel_tx) = make_intake(received);
        let channel_id = ChannelId::new();
        let (handle, actor_task) = start(intake, channel_id, 8);
        assert_eq!(handle.channel_id(), channel_id);
        actor_task.abort();
    }

    // -----------------------------------------------------------------------
    // AC-4: no policy logic — the adapter submits every frame without filtering
    // -----------------------------------------------------------------------

    // AC-4: every frame, regardless of peer identity, is forwarded to intake.
    //       (If the adapter contained policy logic it would selectively drop frames.)
    #[tokio::test(flavor = "current_thread")]
    async fn every_delivered_frame_is_forwarded_regardless_of_peer_identity() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, intake_task, cancel_tx) = make_intake(received.clone());

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = start(intake, channel_id, 64);

        // Deliver frames from 10 different peer identities.
        for i in 0..10_u8 {
            frame_handle
                .deliver(ChatFrame {
                    message: format!("msg-{i}"),
                    peer_id: UserId::new(),
                    context_id: None,
                    subscription_id: format!("sub-005-{i}"),
                })
                .await
                .unwrap();
        }

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(
            got.len(),
            10,
            "all 10 frames must be forwarded without filtering"
        );
    }

    // -----------------------------------------------------------------------
    // AC-1 (T-087): subscription_id on ChatFrame is preserved on RequestContext.reply_address
    // -----------------------------------------------------------------------

    // AC-1 (T-087): a chat frame with a subscription_id produces a RequestContext
    // whose reply_address equals that subscription_id string.
    #[tokio::test(flavor = "current_thread")]
    async fn chat_frame_subscription_id_is_preserved_as_reply_address_on_request_context() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, intake_task, cancel_tx) = make_intake(received.clone());

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = start(intake, channel_id, 16);

        let peer_id = UserId::new();
        let sub_id = "sub-abc-def-123".to_owned();
        let frame = ChatFrame {
            message: "hello".to_owned(),
            peer_id,
            context_id: None,
            subscription_id: sub_id.clone(),
        };
        frame_handle
            .deliver(frame)
            .await
            .expect("deliver must succeed");

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1);
        let (_, ctx) = &got[0];
        assert_eq!(
            ctx.reply_address,
            Some(sub_id),
            "reply_address must equal the subscription_id from the frame"
        );
    }

    // -----------------------------------------------------------------------
    // AC-3: deliver returns Err(Shutdown) after the actor task is dropped
    // -----------------------------------------------------------------------

    // AC-3: deliver returns Err after actor shuts down.
    #[tokio::test(flavor = "current_thread")]
    async fn deliver_returns_error_after_actor_is_stopped() {
        let received = Arc::new(Mutex::new(vec![]));
        let (intake, _intake_task, _cancel_tx) = make_intake(received);
        let channel_id = ChannelId::new();
        let (frame_handle, actor_task) = start(intake, channel_id, 8);

        // Drop the actor (abort ends the task).
        actor_task.abort();
        // Let the abort propagate.
        tokio::task::yield_now().await;

        // The channel should now be broken; deliver must return an error.
        let result = frame_handle
            .deliver(ChatFrame {
                message: "too late".to_owned(),
                peer_id: UserId::new(),
                context_id: None,
                subscription_id: "sub-006".to_owned(),
            })
            .await;
        assert!(result.is_err(), "deliver must fail after actor stops");
    }
}
