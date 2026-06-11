use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use bob_core::{
    error::ServiceError,
    ports::{PersistenceStore, RequestsHandler},
    types::{ChannelId, DeliveryKind, InternalEvent, RequestContext, UserId},
};
use tokio::{
    sync::{oneshot, watch, Notify},
    time::timeout,
};

fn chat_event(index: usize) -> InternalEvent {
    InternalEvent {
        kind: DeliveryKind::Sync,
        payload: format!("queue-load-{index}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn overload_submissions_admit_exact_capacity_and_preserve_order() {
    let request_queue_capacity = 4;
    let total_submissions = request_queue_capacity * 10;

    let (persistence_handle, persistence_task) = persistence::start(persistence::Config {
        command_buffer: 64,
        persistence_inbound_capacity: total_submissions + 1,
    });

    let gate = Arc::new(Notify::new());
    let is_first_event = Arc::new(AtomicBool::new(true));
    let (blocked_tx, blocked_rx) = oneshot::channel();
    let blocked_tx = Arc::new(Mutex::new(Some(blocked_tx)));

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let persistence_for_downstream = persistence_handle.clone();
    let (requests_handle, requests_task) = requests_handler::start_with(
        requests_handler::Config {
            request_queue_capacity,
            request_submit_timeout: Duration::from_millis(10),
        },
        {
            let gate = Arc::clone(&gate);
            let is_first_event = Arc::clone(&is_first_event);
            let blocked_tx = Arc::clone(&blocked_tx);
            move |(event, _ctx)| {
                let persistence = persistence_for_downstream.clone();
                let gate = Arc::clone(&gate);
                let is_first_event = Arc::clone(&is_first_event);
                let blocked_tx = Arc::clone(&blocked_tx);
                async move {
                    if is_first_event.swap(false, Ordering::SeqCst) {
                        if let Some(tx) = blocked_tx.lock().expect("mutex poisoned").take() {
                            tx.send(())
                                .expect("blocking signal receiver should be present");
                        }
                        gate.notified().await;
                    }

                    persistence
                        .enqueue(event)
                        .await
                        .expect("downstream enqueue should succeed");
                }
            }
        },
        cancel_rx,
    );

    let make_ctx = || RequestContext {
        sender: UserId::new(),
        source: ChannelId::new(),
        context_id: None,
        reply_address: None,
    };

    requests_handle
        .submit(
            InternalEvent {
                kind: DeliveryKind::Sync,
                payload: "warmup".to_owned(),
            },
            make_ctx(),
        )
        .await
        .expect("warmup event should be admitted");
    blocked_rx
        .await
        .expect("requests handler should block on warmup event");

    let submitted: Vec<InternalEvent> = (0..total_submissions).map(chat_event).collect();
    let mut admitted = Vec::new();
    let mut timed_out = 0;

    for event in &submitted {
        match requests_handle.submit(event.clone(), make_ctx()).await {
            Ok(()) => admitted.push(event.clone()),
            Err(ServiceError::Timeout {
                operation: "requests-handler.submit",
            }) => {
                timed_out += 1;
            }
            Err(other) => panic!("unexpected submit result: {other:?}"),
        }
    }

    assert_eq!(admitted.len(), request_queue_capacity);
    assert_eq!(timed_out, total_submissions - request_queue_capacity);

    gate.notify_one();
    cancel_tx
        .send(true)
        .expect("sending cancellation should succeed");
    timeout(Duration::from_secs(2), requests_task)
        .await
        .expect("requests handler must stop within timeout")
        .expect("requests handler task should not panic");

    let warmup = persistence_handle
        .dequeue_next()
        .await
        .expect("warmup dequeue should succeed")
        .expect("warmup event should be persisted");
    assert_eq!(
        warmup,
        InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "warmup".to_owned(),
        }
    );

    let mut drained = Vec::new();
    for _ in 0..admitted.len() {
        let next = persistence_handle
            .dequeue_next()
            .await
            .expect("dequeue should succeed");
        drained.push(next.expect("expected admitted event in persistence queue"));
    }

    assert_eq!(drained, admitted);

    let remaining = persistence_handle
        .dequeue_next()
        .await
        .expect("final dequeue should succeed");
    assert!(remaining.is_none(), "no extra admitted events expected");

    drop(persistence_handle);
    persistence_task.abort();
}
