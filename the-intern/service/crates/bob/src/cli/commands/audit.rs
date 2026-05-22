use std::{
    future::Future,
    io::{self, Write},
    pin::Pin,
};

use bob_core::error::ServiceResult;
use bob_core::types::AuditFilterKind;
use serde_json::{json, Value};

use crate::{client::Subscription, config::BobConfig};

use super::{connect_admin, invalid_request_error, load_config, run_async, write_json_line};

trait AuditTailSubscription: Sized {
    fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>>;
    fn close(self) -> Pin<Box<dyn Future<Output = ServiceResult<()>>>>;
}

impl AuditTailSubscription for Subscription<Value> {
    fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>> {
        Box::pin(async move { self.recv().await })
    }

    fn close(self) -> Pin<Box<dyn Future<Output = ServiceResult<()>>>> {
        Box::pin(async move { self.close().await })
    }
}

pub(super) fn run(json_output: bool, filters: Vec<AuditFilterKind>) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_with_config(json_output, filters, &cfg, &mut out)
}

fn run_with_config(
    json_output: bool,
    filters: Vec<AuditFilterKind>,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_with_connector(
        json_output,
        filters,
        cfg,
        out,
        || async {
            tokio::signal::ctrl_c()
                .await
                .map_err(|e| invalid_request_error(format!("failed waiting for ctrl-c: {e}")))
        },
        |cfg, method, params| async move {
            let mut client = connect_admin(&cfg).await?;
            client.subscribe::<_, Value>(method, params).await
        },
    )
}

fn run_with_connector<S, StopFactory, StopFuture, Connect, ConnectFuture>(
    json_output: bool,
    filters: Vec<AuditFilterKind>,
    cfg: &BobConfig,
    out: &mut impl Write,
    stop_factory: StopFactory,
    connector: Connect,
) -> ServiceResult<()>
where
    S: AuditTailSubscription,
    StopFactory: FnOnce() -> StopFuture,
    StopFuture: Future<Output = ServiceResult<()>>,
    Connect: FnOnce(BobConfig, &'static str, Value) -> ConnectFuture,
    ConnectFuture: Future<Output = ServiceResult<S>>,
{
    run_async(run_with_connector_async(
        json_output,
        filters,
        cfg,
        out,
        stop_factory,
        connector,
    ))
}

/// Build subscribe params from optional filters.
///
/// Returns `{}` when no filters are provided (server receives all audit kinds).
/// Returns `{"filters": [...]}` when one or more filter kinds are specified.
fn build_subscribe_params(filters: &[AuditFilterKind]) -> Value {
    if filters.is_empty() {
        json!({})
    } else {
        // AuditFilterKind serializes as lowercase strings: "events", "reports", "verdicts".
        let filter_values: Vec<Value> = filters
            .iter()
            .map(|f| serde_json::to_value(f).expect("AuditFilterKind serializes infallibly"))
            .collect();
        json!({ "filters": filter_values })
    }
}

async fn run_with_connector_async<S, StopFactory, StopFuture, Connect, ConnectFuture>(
    json_output: bool,
    filters: Vec<AuditFilterKind>,
    cfg: &BobConfig,
    out: &mut impl Write,
    stop_factory: StopFactory,
    connector: Connect,
) -> ServiceResult<()>
where
    S: AuditTailSubscription,
    StopFactory: FnOnce() -> StopFuture,
    StopFuture: Future<Output = ServiceResult<()>>,
    Connect: FnOnce(BobConfig, &'static str, Value) -> ConnectFuture,
    ConnectFuture: Future<Output = ServiceResult<S>>,
{
    let params = build_subscribe_params(&filters);
    let mut subscription = connector(cfg.clone(), "audit.tail.subscribe", params).await?;
    let stop_signal = stop_factory();
    tokio::pin!(stop_signal);

    loop {
        tokio::select! {
            stop_result = &mut stop_signal => {
                stop_result?;
                break;
            }
            notification = subscription.recv() => {
                let notification = notification?;
                write_notification(out, json_output, &notification)?;
            }
        }
    }

    subscription.close().await
}

fn write_notification(
    out: &mut impl Write,
    json_output: bool,
    notification: &Value,
) -> ServiceResult<()> {
    if json_output {
        return write_json_line(out, notification);
    }

    let serialized = serde_json::to_string(notification).map_err(|e| {
        invalid_request_error(format!(
            "failed to serialize audit notification output as json: {e}"
        ))
    })?;
    writeln!(out, "{serialized}")
        .map_err(|e| invalid_request_error(format!("failed to write audit output: {e}")))
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };

    use bob_core::error::{ServiceError, ServiceResult};
    use bob_core::types::AuditFilterKind;
    use serde_json::{json, Value};
    use tokio::sync::{mpsc, oneshot};

    use super::{build_subscribe_params, run_with_connector_async, AuditTailSubscription};
    use crate::config::BobConfig;

    struct FakeAuditSubscription {
        notifications: mpsc::UnboundedReceiver<ServiceResult<Value>>,
        closed: Arc<AtomicBool>,
    }

    impl AuditTailSubscription for FakeAuditSubscription {
        fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>> {
            Box::pin(async move {
                self.notifications.recv().await.unwrap_or_else(|| {
                    Err(ServiceError::InvalidRequest {
                        detail: "notification stream ended".to_string(),
                    })
                })
            })
        }

        fn close(self) -> Pin<Box<dyn Future<Output = ServiceResult<()>>>> {
            Box::pin(async move {
                self.closed.store(true, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_subscribes_prints_json_notifications_and_closes() {
        let mut out = Vec::new();
        let cfg = BobConfig::test_base();
        let (tx, rx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let closed = Arc::new(AtomicBool::new(false));

        tx.send(Ok(json!({"event":"one"}))).expect("send one");
        tx.send(Ok(json!({"event":"two"}))).expect("send two");

        let closed_for_connect = Arc::clone(&closed);
        let task = run_with_connector_async(
            true,
            vec![],
            &cfg,
            &mut out,
            || async {
                stop_rx.await.expect("stop signal");
                Ok(())
            },
            move |_cfg, method, params| {
                let closed = Arc::clone(&closed_for_connect);
                async move {
                    assert_eq!(method, "audit.tail.subscribe");
                    assert_eq!(params, json!({}));
                    Ok(FakeAuditSubscription {
                        notifications: rx,
                        closed,
                    })
                }
            },
        );

        let stop_sender = tokio::spawn(async move {
            tokio::task::yield_now().await;
            stop_tx.send(()).expect("send stop");
        });

        task.await.expect("tail succeeds");
        stop_sender.await.expect("stop sender join");

        assert!(
            closed.load(Ordering::SeqCst),
            "tail should close subscription"
        );
        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "{\"event\":\"one\"}\n{\"event\":\"two\"}\n"
        );
    }

    // AC-1: no filters → subscribe params are {}
    #[test]
    fn build_subscribe_params_with_no_filters_returns_empty_object() {
        let params = build_subscribe_params(&[]);
        assert_eq!(params, json!({}));
    }

    // AC-2: specified filters → subscribe params include the filter array
    #[test]
    fn build_subscribe_params_with_filters_returns_filters_array() {
        let params = build_subscribe_params(&[AuditFilterKind::Events, AuditFilterKind::Verdicts]);
        assert_eq!(params, json!({ "filters": ["events", "verdicts"] }));
    }

    #[test]
    fn build_subscribe_params_with_single_reports_filter_serializes_correctly() {
        let params = build_subscribe_params(&[AuditFilterKind::Reports]);
        assert_eq!(params, json!({ "filters": ["reports"] }));
    }

    // AC-2: filters flow through run_with_connector_async to the connector
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_with_filters_sends_filter_array_in_subscribe_params() {
        // Use a channel to record the params the connector received.
        let (params_tx, mut params_rx) = mpsc::unbounded_channel::<Value>();

        let mut out = Vec::new();
        let cfg = BobConfig::test_base();
        let (tx, rx) = mpsc::unbounded_channel::<ServiceResult<Value>>();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let closed = Arc::new(AtomicBool::new(false));

        let closed_for_connect = Arc::clone(&closed);
        let task = run_with_connector_async(
            false,
            vec![AuditFilterKind::Events, AuditFilterKind::Verdicts],
            &cfg,
            &mut out,
            || async {
                stop_rx.await.ok();
                Ok(())
            },
            move |_cfg, method, params| {
                let closed = Arc::clone(&closed_for_connect);
                params_tx.send(params.clone()).ok();
                async move {
                    assert_eq!(method, "audit.tail.subscribe");
                    Ok(FakeAuditSubscription {
                        notifications: rx,
                        closed,
                    })
                }
            },
        );

        let stop_sender = tokio::spawn(async move {
            tokio::task::yield_now().await;
            // Drop tx to end the notification stream, then send stop.
            drop(tx);
            let _ = stop_tx.send(());
        });

        let _ = task.await;
        stop_sender.await.expect("stop sender join");

        let received_params = params_rx.try_recv().expect("params must have been sent");
        assert_eq!(
            received_params,
            json!({ "filters": ["events", "verdicts"] }),
            "filter array must be forwarded in subscribe params"
        );
    }

    // AC-4: --json mode prints one JSON document per notification
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_json_mode_prints_one_json_document_per_notification() {
        let mut out = Vec::new();
        let cfg = BobConfig::test_base();
        let (tx, rx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let closed = Arc::new(AtomicBool::new(false));

        tx.send(Ok(json!({"kind":"event","id":"a1"})))
            .expect("send notification");

        let closed_for_connect = Arc::clone(&closed);
        let task = run_with_connector_async(
            true,
            vec![],
            &cfg,
            &mut out,
            || async {
                stop_rx.await.expect("stop signal");
                Ok(())
            },
            move |_cfg, _method, _params| {
                let closed = Arc::clone(&closed_for_connect);
                async move {
                    Ok(FakeAuditSubscription {
                        notifications: rx,
                        closed,
                    })
                }
            },
        );

        let stop_sender = tokio::spawn(async move {
            tokio::task::yield_now().await;
            stop_tx.send(()).expect("send stop");
        });

        task.await.expect("tail succeeds");
        stop_sender.await.expect("stop sender join");

        let output = String::from_utf8(out).expect("valid utf8");
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(
            lines.len(),
            1,
            "expected exactly one JSON line, got: {output:?}"
        );
        let parsed: Value = serde_json::from_str(lines[0]).expect("output must be valid JSON");
        assert_eq!(parsed["kind"], "event");
        assert_eq!(parsed["id"], "a1");
    }
}
