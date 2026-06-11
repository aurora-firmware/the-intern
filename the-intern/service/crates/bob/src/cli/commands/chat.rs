use std::{
    future::Future,
    io::{self, BufRead, Write},
    pin::Pin,
};

use bob_core::error::ServiceResult;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::{client::Subscription, config::BobConfig};

use super::{connect_admin, invalid_request_error, load_config, run_async, write_json_line};

trait ChatSubscription: Sized {
    fn id(&self) -> &str;
    fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>>;
    fn send<'a>(
        &'a mut self,
        method: &'static str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = ServiceResult<()>> + 'a>>;
    fn close(self) -> Pin<Box<dyn Future<Output = ServiceResult<()>>>>;
}

impl ChatSubscription for Subscription<Value> {
    fn id(&self) -> &str {
        self.subscription_id()
    }

    fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>> {
        Box::pin(async move { self.recv().await })
    }

    fn send<'a>(
        &'a mut self,
        method: &'static str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = ServiceResult<()>> + 'a>> {
        Box::pin(async move {
            let _result: Value = self.call(method, params).await?;
            Ok(())
        })
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
        Box::pin(async move { self.receiver.recv().await.unwrap_or(Ok(None)) })
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
    )
}

// The trailing stop/open parameters are a dependency-injection seam that
// lets tests drive `chat` without real sockets or stdin.
fn run_with_parts<S, L, StopFactory, StopFuture, OpenFn, OpenFuture>(
    json_output: bool,
    session: Option<&str>,
    cfg: &BobConfig,
    out: &mut impl Write,
    lines: &mut L,
    stop_factory: StopFactory,
    open_chat: OpenFn,
) -> ServiceResult<()>
where
    S: ChatSubscription,
    L: ChatInputLines,
    StopFactory: FnOnce() -> StopFuture,
    StopFuture: Future<Output = ServiceResult<()>>,
    OpenFn: FnOnce(BobConfig, &'static str, Value) -> OpenFuture,
    OpenFuture: Future<Output = ServiceResult<S>>,
{
    run_async(run_with_parts_async(
        json_output,
        session,
        cfg,
        out,
        lines,
        stop_factory,
        open_chat,
    ))
}

async fn run_with_parts_async<S, L, StopFactory, StopFuture, OpenFn, OpenFuture>(
    json_output: bool,
    session: Option<&str>,
    cfg: &BobConfig,
    out: &mut impl Write,
    lines: &mut L,
    stop_factory: StopFactory,
    open_chat: OpenFn,
) -> ServiceResult<()>
where
    S: ChatSubscription,
    L: ChatInputLines,
    StopFactory: FnOnce() -> StopFuture,
    StopFuture: Future<Output = ServiceResult<()>>,
    OpenFn: FnOnce(BobConfig, &'static str, Value) -> OpenFuture,
    OpenFuture: Future<Output = ServiceResult<S>>,
{
    let mut subscription = open_chat(cfg.clone(), "chat.open", json!({})).await?;
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
                        let params = build_chat_send_params(cfg, subscription.id(), session, &line);
                        subscription.send("chat.send", params).await?;
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

fn build_chat_send_params(
    cfg: &BobConfig,
    subscription_id: &str,
    session: Option<&str>,
    line: &str,
) -> Value {
    let application_identity = cfg.chat_application_identity.to_string();
    match session {
        Some(context_id) => json!({
            "id": subscription_id,
            "context_id": context_id,
            "text": line,
            "application_identity": application_identity
        }),
        None => json!({
            "id": subscription_id,
            "text": line,
            "application_identity": application_identity
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
        path::PathBuf,
        pin::Pin,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            Arc,
        },
        time::Duration,
    };

    use bob_core::error::ServiceResult;
    use serde_json::{json, Value};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
        sync::{mpsc, oneshot, Mutex},
        task,
        time::timeout,
    };

    use super::{run_with_parts_async, ChatInputLines, ChatSubscription};
    use crate::{client::AdminClient, config::BobConfig};

    static NEXT_CHAT_SOCKET_ID: AtomicU64 = AtomicU64::new(1);

    fn unique_chat_socket_path(name: &str) -> PathBuf {
        let id = NEXT_CHAT_SOCKET_ID.fetch_add(1, Ordering::Relaxed);
        let dir = PathBuf::from("/tmp/bob-chat-tests");
        std::fs::create_dir_all(&dir).expect("create test-sockets dir");
        let path = dir.join(format!("{name}-{}-{id}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    struct FakeChatSubscription {
        subscription_id: String,
        notifications: mpsc::UnboundedReceiver<ServiceResult<Value>>,
        closed: Arc<AtomicBool>,
        sent_params: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl ChatSubscription for FakeChatSubscription {
        fn id(&self) -> &str {
            &self.subscription_id
        }

        fn recv<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ServiceResult<Value>> + 'a>> {
            Box::pin(async move {
                match self.notifications.recv().await {
                    Some(item) => item,
                    None => future::pending().await,
                }
            })
        }

        fn send<'a>(
            &'a mut self,
            method: &'static str,
            params: Value,
        ) -> Pin<Box<dyn Future<Output = ServiceResult<()>> + 'a>> {
            Box::pin(async move {
                self.sent_params
                    .lock()
                    .await
                    .push((method.to_string(), params));
                Ok(())
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

    // Regression test for B-008: chat.send params must include the subscription
    // id from chat.open so the server can validate it against the connection registry.
    #[tokio::test(flavor = "current_thread")]
    async fn chat_send_params_include_subscription_id_from_chat_open() {
        let identity = "00000000-0000-0000-0000-000000000456"
            .parse()
            .expect("identity should parse");
        let cfg = BobConfig {
            chat_application_identity: identity,
            ..BobConfig::test_base()
        };
        let closed = Arc::new(AtomicBool::new(false));
        let sent_params = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let (notif_tx, notif_rx) = mpsc::unbounded_channel();
        let mut lines = FakeLines::from([Some("hello"), None]);
        let mut out = Vec::new();

        let closed_for_open = Arc::clone(&closed);
        let sent_for_open = Arc::clone(&sent_params);
        // The notif_tx is moved into the closure to keep the channel open until
        // the subscription is dropped.
        let _notif_tx = notif_tx;
        run_with_parts_async(
            false,
            None,
            &cfg,
            &mut out,
            &mut lines,
            || async { future::pending().await },
            move |_cfg, method, _params| {
                let closed = Arc::clone(&closed_for_open);
                async move {
                    assert_eq!(method, "chat.open");
                    Ok(FakeChatSubscription {
                        subscription_id: "sub-from-server".to_string(),
                        notifications: notif_rx,
                        closed,
                        sent_params: sent_for_open,
                    })
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
        assert_eq!(sent.len(), 1, "exactly one send for one input line");
        let (method, params) = &sent[0];
        assert_eq!(method, "chat.send");
        assert_eq!(
            params["id"], "sub-from-server",
            "params.id must equal the subscription id returned by chat.open"
        );
        assert_eq!(params["text"], "hello");
        assert_eq!(
            params["application_identity"],
            "00000000-0000-0000-0000-000000000456"
        );
    }

    // AC-1: chat.send params use context_id (not session) when --session is supplied.
    // AC-3: chat.open is always sent without a session key.
    #[tokio::test(flavor = "current_thread")]
    async fn chat_opens_with_session_and_sends_each_input_line() {
        let identity = "00000000-0000-0000-0000-000000000123"
            .parse()
            .expect("identity should parse");
        let cfg = BobConfig {
            chat_application_identity: identity,
            ..BobConfig::test_base()
        };
        let closed = Arc::new(AtomicBool::new(false));
        let sent_params = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let (notif_tx, notif_rx) = mpsc::unbounded_channel();
        let mut lines = FakeLines::from([Some("hello"), Some("world"), None]);
        let mut out = Vec::new();

        let closed_for_open = Arc::clone(&closed);
        let sent_for_open = Arc::clone(&sent_params);
        let _notif_tx = notif_tx;
        run_with_parts_async(
            false,
            Some("session-7"),
            &cfg,
            &mut out,
            &mut lines,
            || async { future::pending().await },
            move |_cfg, method, params| {
                let closed = Arc::clone(&closed_for_open);
                async move {
                    assert_eq!(method, "chat.open");
                    // AC-3: chat.open must not carry a session key regardless of --session.
                    assert_eq!(params, json!({}));
                    Ok(FakeChatSubscription {
                        subscription_id: "sub-session-7".to_string(),
                        notifications: notif_rx,
                        closed,
                        sent_params: sent_for_open,
                    })
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
        let params_only: Vec<Value> = sent.into_iter().map(|(_, p)| p).collect();
        assert_eq!(
            params_only,
            vec![
                // AC-1: context_id carries the --session value; no session key present.
                json!({
                    "id": "sub-session-7",
                    "context_id": "session-7",
                    "text": "hello",
                    "application_identity": "00000000-0000-0000-0000-000000000123"
                }),
                json!({
                    "id": "sub-session-7",
                    "context_id": "session-7",
                    "text": "world",
                    "application_identity": "00000000-0000-0000-0000-000000000123"
                })
            ]
        );
    }

    // AC-2: when --session is absent, context_id is omitted from chat.send params.
    #[tokio::test(flavor = "current_thread")]
    async fn chat_send_params_omit_context_id_when_session_not_provided() {
        let identity = "00000000-0000-0000-0000-000000000789"
            .parse()
            .expect("identity should parse");
        let cfg = BobConfig {
            chat_application_identity: identity,
            ..BobConfig::test_base()
        };
        let closed = Arc::new(AtomicBool::new(false));
        let sent_params = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let (notif_tx, notif_rx) = mpsc::unbounded_channel();
        let mut lines = FakeLines::from([Some("hi"), None]);
        let mut out = Vec::new();

        let closed_for_open = Arc::clone(&closed);
        let sent_for_open = Arc::clone(&sent_params);
        let _notif_tx = notif_tx;
        run_with_parts_async(
            false,
            None,
            &cfg,
            &mut out,
            &mut lines,
            || async { future::pending().await },
            move |_cfg, method, params| {
                let closed = Arc::clone(&closed_for_open);
                async move {
                    assert_eq!(method, "chat.open");
                    assert_eq!(params, json!({}));
                    Ok(FakeChatSubscription {
                        subscription_id: "sub-no-session".to_string(),
                        notifications: notif_rx,
                        closed,
                        sent_params: sent_for_open,
                    })
                }
            },
        )
        .await
        .expect("chat succeeds");

        let sent = sent_params.lock().await.clone();
        assert_eq!(sent.len(), 1);
        let (_, params) = &sent[0];
        assert!(
            params.get("context_id").is_none(),
            "context_id must be absent when --session is not provided"
        );
        assert!(
            params.get("session").is_none(),
            "session key must not appear in chat.send params"
        );
        assert_eq!(params["id"], "sub-no-session");
        assert_eq!(params["text"], "hi");
        assert_eq!(
            params["application_identity"],
            "00000000-0000-0000-0000-000000000789"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_json_mode_prints_one_json_document_per_notification() {
        let cfg = BobConfig::test_base();
        let closed = Arc::new(AtomicBool::new(false));
        let sent_params = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
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
                        subscription_id: "sub-json".to_string(),
                        notifications: notif_rx,
                        closed,
                        sent_params,
                    })
                }
            },
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

    // AC-1 + AC-2 (chat loop integration): verify that notifications pushed
    // by the server while the loop is processing stdin are delivered exactly
    // once, in order, with no malformed-frame errors.
    //
    // Design: stdin provides one message then stays pending forever; a stop
    // signal fires after the server finishes sending three notifications.
    // This keeps stdin from racing with recv() so the recv() arm is guaranteed
    // to drain all notifications before the stop fires.
    #[tokio::test(flavor = "current_thread")]
    async fn chat_loop_delivers_all_notifications_when_stdin_and_notifications_race() {
        let sock_path = unique_chat_socket_path("chat-loop-race");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");
        let (stop_tx, stop_rx) = oneshot::channel::<()>();

        // Server: answer chat.open, answer one chat.send (with buffered
        // notification), then push two more notifications proactively, then
        // signal the stop channel so the loop exits cleanly.
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // chat.open
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read chat.open");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"chat-race\"},\"id\":1}\n")
                .await
                .expect("write chat.open response");

            // Answer the one chat.send, sending the notification BEFORE the
            // response so it gets buffered inside call().
            let mut req_line = String::new();
            reader
                .read_line(&mut req_line)
                .await
                .expect("read chat.send");
            let req: Value = serde_json::from_str(req_line.trim()).expect("parse chat.send");
            let req_id = req["id"].as_u64().expect("id");

            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.notification\",\"params\":{\"subscription\":\"chat-race\",\"data\":{\"text\":\"reply-0\"}}}\n")
                .await
                .expect("write notif-0");
            write_half
                .write_all(
                    format!("{{\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}},\"id\":{req_id}}}\n")
                        .as_bytes(),
                )
                .await
                .expect("write send response");

            // Push two more notifications proactively (not in response to a send),
            // delivered in two halves each to create a cancellation window.
            for i in 1u32..3 {
                let notif = format!(
                    "{{\"jsonrpc\":\"2.0\",\"method\":\"chat.notification\",\"params\":{{\"subscription\":\"chat-race\",\"data\":{{\"text\":\"reply-{i}\"}}}}}}\n"
                );
                let (first, second) = notif.as_bytes().split_at(notif.len() / 2);
                write_half
                    .write_all(first)
                    .await
                    .expect("write notif first half");
                // Brief pause to create a window where the loop may be polled.
                tokio::time::sleep(Duration::from_millis(5)).await;
                write_half
                    .write_all(second)
                    .await
                    .expect("write notif second half");
            }

            // Give the client time to drain the notifications, then stop it.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = stop_tx.send(());

            // Read and answer chat.close.
            let mut close_line = String::new();
            reader
                .read_line(&mut close_line)
                .await
                .expect("read chat.close");
            let close_req: Value =
                serde_json::from_str(close_line.trim()).expect("parse chat.close");
            let close_id = close_req["id"].as_u64().expect("close id");
            write_half
                .write_all(
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}},\"id\":{close_id}}}\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("write close response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path.clone(),
            ..BobConfig::test_base()
        };
        // One stdin line then permanently pending — stop signal drives termination.
        let mut lines = FakeLines::from([Some("msg-0")]);
        let mut out = Vec::new();

        timeout(
            Duration::from_secs(5),
            run_with_parts_async(
                true,
                None,
                &cfg,
                &mut out,
                &mut lines,
                || async {
                    stop_rx.await.ok();
                    Ok(())
                },
                |cfg, method, params| async move {
                    let mut client = AdminClient::connect(&cfg).await?;
                    client.subscribe::<_, Value>(method, params).await
                },
            ),
        )
        .await
        .expect("chat loop must complete within 5s")
        .expect("chat loop must succeed");

        let rendered = String::from_utf8(out).expect("utf8 output");
        assert!(
            rendered.contains("\"reply-0\""),
            "reply-0 must be rendered; got: {rendered}"
        );
        assert!(
            rendered.contains("\"reply-1\""),
            "reply-1 must be rendered; got: {rendered}"
        );
        assert!(
            rendered.contains("\"reply-2\""),
            "reply-2 must be rendered; got: {rendered}"
        );
        assert_eq!(
            rendered.matches("reply-").count(),
            3,
            "each reply must appear exactly once; got: {rendered}"
        );

        timeout(Duration::from_secs(2), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&sock_path);
    }

    // AC-3 (chat loop integration): close() skips notifications that arrive
    // after the close request is sent, so none of them appear in the output.
    // Uses a real Subscription<Value> so the FrameReaderTask path is exercised.
    #[tokio::test(flavor = "current_thread")]
    async fn chat_loop_close_skips_notifications_in_flight_after_close_request() {
        let sock_path = unique_chat_socket_path("chat-loop-close");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");
        let (stop_tx, stop_rx) = oneshot::channel::<()>();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // chat.open
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read chat.open");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"chat-close\"},\"id\":1}\n")
                .await
                .expect("write chat.open response");

            // Trigger the stop signal so the loop exits after open.
            let _ = stop_tx.send(());

            // Read and answer chat.close — send a notification before the
            // close response to verify AC-3 semantics.
            let mut close_line = String::new();
            reader
                .read_line(&mut close_line)
                .await
                .expect("read chat.close");
            let close_req: Value =
                serde_json::from_str(close_line.trim()).expect("parse chat.close");
            let close_id = close_req["id"].as_u64().expect("close id");

            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.notification\",\"params\":{\"subscription\":\"chat-close\",\"data\":{\"text\":\"skipped\"}}}\n")
                .await
                .expect("write notification before close");
            write_half
                .write_all(
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}},\"id\":{close_id}}}\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("write close response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path.clone(),
            ..BobConfig::test_base()
        };
        // No stdin lines — stop signal drives termination.
        let mut lines = FakeLines::from([]);
        let mut out = Vec::new();

        timeout(
            Duration::from_secs(5),
            run_with_parts_async(
                true,
                None,
                &cfg,
                &mut out,
                &mut lines,
                || async {
                    stop_rx.await.ok();
                    Ok(())
                },
                |cfg, method, params| async move {
                    let mut client = AdminClient::connect(&cfg).await?;
                    client.subscribe::<_, Value>(method, params).await
                },
            ),
        )
        .await
        .expect("chat loop must complete within 5s")
        .expect("chat loop must succeed without error");

        let rendered = String::from_utf8(out).expect("utf8 output");
        // The notification that arrived after close was issued must not appear.
        assert!(
            !rendered.contains("\"skipped\""),
            "notification after close must be skipped; got: {rendered}"
        );

        timeout(Duration::from_secs(2), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&sock_path);
    }
}
