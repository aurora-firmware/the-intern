use std::{
    future::Future,
    io::{self, Write},
    pin::Pin,
};

use bob_core::error::ServiceResult;
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

pub(super) fn run(json_output: bool) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_with_config(json_output, &cfg, &mut out)
}

fn run_with_config(json_output: bool, cfg: &BobConfig, out: &mut impl Write) -> ServiceResult<()> {
    run_with_connector(
        json_output,
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
        cfg,
        out,
        stop_factory,
        connector,
    ))
}

async fn run_with_connector_async<S, StopFactory, StopFuture, Connect, ConnectFuture>(
    json_output: bool,
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
    let mut subscription = connector(cfg.clone(), "audit.tail.subscribe", json!({})).await?;
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
    use serde_json::{json, Value};
    use tokio::sync::{mpsc, oneshot};

    use super::{run_with_connector_async, AuditTailSubscription};
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
}
