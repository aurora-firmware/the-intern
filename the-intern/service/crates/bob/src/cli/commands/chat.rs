use std::{
    future::Future,
    io::{self, BufRead, Write},
    pin::Pin,
};

use bob_core::error::ServiceResult;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::{client::Subscription, config::BobConfig};

use super::{
    call_admin, connect_admin, invalid_request_error, load_config, run_async, write_json_line,
};

trait ChatSubscription: Sized {
    fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>>;
    fn close(self) -> Pin<Box<dyn Future<Output = ServiceResult<()>>>>;
}

impl ChatSubscription for Subscription<Value> {
    fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>> {
        Box::pin(async move { self.recv().await })
    }

    fn close(self) -> Pin<Box<dyn Future<Output = ServiceResult<()>>>> {
        Box::pin(async move { self.close().await })
    }
}

trait ChatInputLines {
    fn next_line<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = ServiceResult<Option<String>>> + 'a>>;
}

struct StdinLines {
    receiver: mpsc::UnboundedReceiver<ServiceResult<Option<String>>>,
}

impl StdinLines {
    fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel::<ServiceResult<Option<String>>>();

        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let reader = stdin.lock();
            for line in reader.lines() {
                let send_result = match line {
                    Ok(line) => sender.send(Ok(Some(line))),
                    Err(error) => sender.send(Err(invalid_request_error(format!(
                        "failed to read stdin: {error}"
                    )))),
                };
                if send_result.is_err() {
                    return;
                }
            }

            let _ = sender.send(Ok(None));
        });

        Self { receiver }
    }
}

impl ChatInputLines for StdinLines {
    fn next_line<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = ServiceResult<Option<String>>> + 'a>> {
        Box::pin(async move { self.receiver.recv().await.unwrap_or_else(|| Ok(None)) })
    }
}

pub(super) fn run(json_output: bool, session: Option<&str>) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    let mut lines = StdinLines::new();
    run_with_parts(
        json_output,
        session,
        &cfg,
        &mut out,
        &mut lines,
        || async {
            tokio::signal::ctrl_c()
                .await
                .map_err(|e| invalid_request_error(format!("failed waiting for ctrl-c: {e}")))
        },
        |cfg, method, params| async move {
            let mut client = connect_admin(&cfg).await?;
            client.subscribe::<_, Value>(method, params).await
        },
        |cfg, method, params| async move { call_admin(&cfg, method, params).await.map(|_| ()) },
    )
}

fn run_with_parts<S, L, StopFactory, StopFuture, OpenFn, OpenFuture, SendFn, SendFuture>(
    json_output: bool,
    session: Option<&str>,
    cfg: &BobConfig,
    out: &mut impl Write,
    lines: &mut L,
    stop_factory: StopFactory,
    open_chat: OpenFn,
    send_chat: SendFn,
) -> ServiceResult<()>
where
    S: ChatSubscription,
    L: ChatInputLines,
    StopFactory: FnOnce() -> StopFuture,
    StopFuture: Future<Output = ServiceResult<()>>,
    OpenFn: FnOnce(BobConfig, &'static str, Value) -> OpenFuture,
    OpenFuture: Future<Output = ServiceResult<S>>,
    SendFn: Fn(BobConfig, &'static str, Value) -> SendFuture,
    SendFuture: Future<Output = ServiceResult<()>>,
{
    run_async(run_with_parts_async(
        json_output,
        session,
        cfg,
        out,
        lines,
        stop_factory,
        open_chat,
        send_chat,
    ))
}

async fn run_with_parts_async<
    S,
    L,
    StopFactory,
    StopFuture,
    OpenFn,
    OpenFuture,
    SendFn,
    SendFuture,
>(
    json_output: bool,
    session: Option<&str>,
    cfg: &BobConfig,
    out: &mut impl Write,
    lines: &mut L,
    stop_factory: StopFactory,
    open_chat: OpenFn,
    send_chat: SendFn,
) -> ServiceResult<()>
where
    S: ChatSubscription,
    L: ChatInputLines,
    StopFactory: FnOnce() -> StopFuture,
    StopFuture: Future<Output = ServiceResult<()>>,
    OpenFn: FnOnce(BobConfig, &'static str, Value) -> OpenFuture,
    OpenFuture: Future<Output = ServiceResult<S>>,
    SendFn: Fn(BobConfig, &'static str, Value) -> SendFuture,
    SendFuture: Future<Output = ServiceResult<()>>,
{
    let open_params = match session {
        Some(id) => json!({ "session": id }),
        None => json!({}),
    };
    let mut subscription = open_chat(cfg.clone(), "chat.open", open_params).await?;
    let stop_signal = stop_factory();
    tokio::pin!(stop_signal);

    loop {
        tokio::select! {
            stop_result = &mut stop_signal => {
                stop_result?;
                break;
            }
            next_line = lines.next_line() => {
                match next_line? {
                    Some(line) => {
                        let params = build_chat_send_params(session, &line);
                        send_chat(cfg.clone(), "chat.send", params).await?;
                    }
                    None => {
                        break;
                    }
                }
            }
            notification = subscription.recv() => {
                let notification = notification?;
                write_chat_notification(out, json_output, &notification)?;
            }
        }
    }

    subscription.close().await
}

fn build_chat_send_params(session: Option<&str>, line: &str) -> Value {
    match session {
        Some(id) => json!({
            "session": id,
            "text": line
        }),
        None => json!({
            "text": line
        }),
    }
}

fn write_chat_notification(
    out: &mut impl Write,
    json_output: bool,
    notification: &Value,
) -> ServiceResult<()> {
    if json_output {
        return write_json_line(out, notification);
    }

    if let Some(text) = notification.get("text").and_then(Value::as_str) {
        return writeln!(out, "{text}")
            .map_err(|e| invalid_request_error(format!("failed to write chat output: {e}")));
    }

    let serialized = serde_json::to_string(notification).map_err(|e| {
        invalid_request_error(format!(
            "failed to serialize chat notification output as json: {e}"
        ))
    })?;
    writeln!(out, "{serialized}")
        .map_err(|e| invalid_request_error(format!("failed to write chat output: {e}")))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        future::{self, Future},
        pin::Pin,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };

    use bob_core::error::ServiceResult;
    use serde_json::{json, Value};
    use tokio::{
        sync::{mpsc, oneshot, Mutex},
        task,
    };

    use super::{run_with_parts_async, ChatInputLines, ChatSubscription};
    use crate::config::BobConfig;

    struct FakeChatSubscription {
        notifications: mpsc::UnboundedReceiver<ServiceResult<Value>>,
        closed: Arc<AtomicBool>,
    }

    impl ChatSubscription for FakeChatSubscription {
        fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>> {
            Box::pin(async move {
                match self.notifications.recv().await {
                    Some(item) => item,
                    None => future::pending().await,
                }
            })
        }

        fn close(self) -> Pin<Box<dyn Future<Output = ServiceResult<()>>>> {
            Box::pin(async move {
                self.closed.store(true, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    struct FakeLines {
        lines: VecDeque<Option<String>>,
    }

    impl FakeLines {
        fn from(items: impl IntoIterator<Item = Option<&'static str>>) -> Self {
            Self {
                lines: items
                    .into_iter()
                    .map(|item| item.map(ToString::to_string))
                    .collect(),
            }
        }
    }

    impl ChatInputLines for FakeLines {
        fn next_line<'a>(
            &'a mut self,
        ) -> Pin<Box<dyn Future<Output = ServiceResult<Option<String>>> + 'a>> {
            Box::pin(async move {
                match self.lines.pop_front() {
                    Some(next) => Ok(next),
                    None => future::pending().await,
                }
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_opens_with_session_and_sends_each_input_line() {
        let cfg = BobConfig::test_base();
        let closed = Arc::new(AtomicBool::new(false));
        let sent_params = Arc::new(Mutex::new(Vec::<Value>::new()));
        let (notif_tx, notif_rx) = mpsc::unbounded_channel();
        let mut lines = FakeLines::from([Some("hello"), Some("world"), None]);
        let mut out = Vec::new();

        let closed_for_open = Arc::clone(&closed);
        let sent_for_send = Arc::clone(&sent_params);
        run_with_parts_async(
            false,
            Some("session-7"),
            &cfg,
            &mut out,
            &mut lines,
            || async { future::pending().await },
            move |_cfg, method, params| {
                let closed = Arc::clone(&closed_for_open);
                let _notif_tx = notif_tx;
                async move {
                    assert_eq!(method, "chat.open");
                    assert_eq!(params, json!({"session":"session-7"}));
                    Ok(FakeChatSubscription {
                        notifications: notif_rx,
                        closed,
                    })
                }
            },
            move |_cfg, method, params| {
                let sent_for_send = Arc::clone(&sent_for_send);
                async move {
                    assert_eq!(method, "chat.send");
                    sent_for_send.lock().await.push(params);
                    Ok(())
                }
            },
        )
        .await
        .expect("chat succeeds");

        assert!(
            closed.load(Ordering::SeqCst),
            "chat should close subscription"
        );
        let sent = sent_params.lock().await.clone();
        assert_eq!(
            sent,
            vec![
                json!({"session":"session-7","text":"hello"}),
                json!({"session":"session-7","text":"world"})
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_json_mode_prints_one_json_document_per_notification() {
        let cfg = BobConfig::test_base();
        let closed = Arc::new(AtomicBool::new(false));
        let (notif_tx, notif_rx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = oneshot::channel();
        let mut lines = FakeLines::from([]);
        let mut out = Vec::new();

        notif_tx
            .send(Ok(json!({"text":"first"})))
            .expect("send first");
        notif_tx
            .send(Ok(json!({"text":"second"})))
            .expect("send second");

        let closed_for_open = Arc::clone(&closed);
        let runner = run_with_parts_async(
            true,
            None,
            &cfg,
            &mut out,
            &mut lines,
            || async {
                stop_rx.await.expect("stop signal");
                Ok(())
            },
            move |_cfg, method, params| {
                let closed = Arc::clone(&closed_for_open);
                async move {
                    assert_eq!(method, "chat.open");
                    assert_eq!(params, json!({}));
                    Ok(FakeChatSubscription {
                        notifications: notif_rx,
                        closed,
                    })
                }
            },
            |_cfg, _method, _params| async move { Ok(()) },
        );

        task::spawn(async move {
            task::yield_now().await;
            stop_tx.send(()).expect("stop send");
        });

        runner.await.expect("chat succeeds");

        assert!(
            closed.load(Ordering::SeqCst),
            "chat should close subscription"
        );
        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "{\"text\":\"first\"}\n{\"text\":\"second\"}\n"
        );
    }
}
