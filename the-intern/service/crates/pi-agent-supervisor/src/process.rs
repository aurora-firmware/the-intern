use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::time;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerProcessConfig {
    pub command: String,
    pub args: Vec<String>,
    pub child_termination_deadline: Duration,
    /// The session id to set as `BOB_SESSION_ID` on the child process environment.
    pub session_id: SessionId,
    /// Absolute path to the extension socket, set as `BOB_EXTENSION_SOCK_PATH`.
    /// If the path is empty, the variable is not set on the child environment.
    pub extension_sock_path: PathBuf,
}

#[derive(Debug)]
pub struct RpcWorkerProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    _stderr: ChildStderr,
    child_termination_deadline: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminationOutcome {
    pub forced: bool,
}

impl RpcWorkerProcess {
    pub fn spawn(cfg: &WorkerProcessConfig) -> ServiceResult<Self> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("BOB_SESSION_ID", cfg.session_id.to_string());

        if !cfg.extension_sock_path.as_os_str().is_empty() {
            cmd.env("BOB_EXTENSION_SOCK_PATH", &cfg.extension_sock_path);
        }

        let mut child = cmd
            .spawn()
            .map_err(|error| ServiceError::ChildProcess {
                detail: format!(
                    "failed to spawn worker process for command '{}' ({error})",
                    cfg.command
                ),
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ServiceError::ChildProcess {
                detail: "failed to create piped child stdin".to_string(),
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ServiceError::ChildProcess {
                detail: "failed to create piped child stdout".to_string(),
            })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ServiceError::ChildProcess {
                detail: "failed to create piped child stderr".to_string(),
            })?;

        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            _stderr: stderr,
            child_termination_deadline: cfg.child_termination_deadline,
        })
    }

    pub async fn send_json(&mut self, command: &Value) -> ServiceResult<()> {
        let mut payload =
            serde_json::to_vec(command).map_err(|error| ServiceError::ChildProcess {
                detail: format!("failed to serialize RPC command JSON ({error})"),
            })?;
        payload.push(b'\n');

        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| ServiceError::ChildProcess {
                detail: "cannot send RPC command because child stdin is closed".to_string(),
            })?;

        stdin
            .write_all(&payload)
            .await
            .map_err(|error| ServiceError::ChildProcess {
                detail: format!("failed to write RPC command to child stdin ({error})"),
            })?;
        stdin
            .flush()
            .await
            .map_err(|error| ServiceError::ChildProcess {
                detail: format!("failed to flush RPC command to child stdin ({error})"),
            })?;

        Ok(())
    }

    pub async fn read_next_stdout_json(&mut self) -> ServiceResult<Option<Value>> {
        let mut line = String::new();
        let read =
            self.stdout
                .read_line(&mut line)
                .await
                .map_err(|error| ServiceError::ChildProcess {
                    detail: format!("failed to read RPC output from child stdout ({error})"),
                })?;

        if read == 0 {
            return Ok(None);
        }

        if line.ends_with('\n') {
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
        }

        let value =
            serde_json::from_str::<Value>(&line).map_err(|error| ServiceError::ChildProcess {
                detail: format!("failed to parse JSON record from child stdout ({error})"),
            })?;

        Ok(Some(value))
    }

    pub async fn terminate(mut self) -> ServiceResult<TerminationOutcome> {
        self.request_graceful_termination()?;

        let wait_result = time::timeout(self.child_termination_deadline, self.child.wait()).await;
        match wait_result {
            Ok(Ok(_status)) => Ok(TerminationOutcome { forced: false }),
            Ok(Err(error)) => Err(ServiceError::ChildProcess {
                detail: format!("failed while waiting for child termination ({error})"),
            }),
            Err(_) => {
                if let Some(_status) =
                    self.child
                        .try_wait()
                        .map_err(|error| ServiceError::ChildProcess {
                            detail: format!(
                                "failed to inspect child status during termination ({error})"
                            ),
                        })?
                {
                    return Ok(TerminationOutcome { forced: false });
                }

                self.child
                    .kill()
                    .await
                    .map_err(|error| ServiceError::ChildProcess {
                        detail: format!("failed to force-kill child process ({error})"),
                    })?;

                self.child
                    .wait()
                    .await
                    .map_err(|error| ServiceError::ChildProcess {
                        detail: format!(
                            "failed while waiting for force-killed child process ({error})"
                        ),
                    })?;

                Ok(TerminationOutcome { forced: true })
            }
        }
    }

    fn request_graceful_termination(&mut self) -> ServiceResult<()> {
        #[cfg(unix)]
        {
            use nix::{
                sys::signal::{self, Signal},
                unistd::Pid,
            };

            if let Some(pid) = self.child.id() {
                signal::kill(Pid::from_raw(pid as i32), Signal::SIGTERM).map_err(|error| {
                    ServiceError::ChildProcess {
                        detail: format!(
                            "failed to request graceful child termination via SIGTERM ({error})"
                        ),
                    }
                })?;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;
    use tokio::time::{timeout, Duration as TokioDuration};

    fn spawn_config(command: &str, args: &[&str]) -> WorkerProcessConfig {
        WorkerProcessConfig {
            command: command.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            child_termination_deadline: Duration::from_millis(2000),
            session_id: SessionId::new(),
            extension_sock_path: PathBuf::new(),
        }
    }

    // AC-1: BOB_SESSION_ID is set on the spawned child environment.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_sets_bob_session_id_on_child_environment() {
        let session_id = SessionId::new();
        let cfg = WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                // Output the env var as a JSON string for read_next_stdout_json.
                "printf '\"%s\"\\n' \"$BOB_SESSION_ID\"".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(50),
            session_id,
            extension_sock_path: PathBuf::new(),
        };

        let mut worker = RpcWorkerProcess::spawn(&cfg).expect("spawn should succeed");

        let value = worker
            .read_next_stdout_json()
            .await
            .expect("stdout read should succeed")
            .expect("value should be present");

        assert_eq!(
            value,
            Value::String(session_id.to_string()),
            "BOB_SESSION_ID on child env should match the configured session_id"
        );
    }

    // AC-2: BOB_EXTENSION_SOCK_PATH is set when configured to a non-empty path.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_sets_bob_extension_sock_path_when_path_is_non_empty() {
        let session_id = SessionId::new();
        let sock_path = PathBuf::from("/run/bob/extension.sock");
        let cfg = WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                // Output the env var as a JSON string for read_next_stdout_json.
                "printf '\"%s\"\\n' \"$BOB_EXTENSION_SOCK_PATH\"".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(50),
            session_id,
            extension_sock_path: sock_path.clone(),
        };

        let mut worker = RpcWorkerProcess::spawn(&cfg).expect("spawn should succeed");

        let value = worker
            .read_next_stdout_json()
            .await
            .expect("stdout read should succeed")
            .expect("value should be present");

        assert_eq!(
            value,
            Value::String(sock_path.to_string_lossy().into_owned()),
            "BOB_EXTENSION_SOCK_PATH on child env should match the configured path"
        );
    }

    // AC-3: When extension_sock_path is empty, spawn proceeds without that var.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_omits_bob_extension_sock_path_when_path_is_empty() {
        let session_id = SessionId::new();
        let cfg = WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                // Print "unset" when the variable is absent, "set:<value>" when present.
                "if [ -z \"${BOB_EXTENSION_SOCK_PATH+x}\" ]; then printf '\"unset\"\\n'; else printf '\"set:%s\"\\n' \"$BOB_EXTENSION_SOCK_PATH\"; fi".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(50),
            session_id,
            extension_sock_path: PathBuf::new(),
        };

        let mut worker = RpcWorkerProcess::spawn(&cfg).expect("spawn should succeed");

        let value = worker
            .read_next_stdout_json()
            .await
            .expect("stdout read should succeed")
            .expect("value should be present");

        assert_eq!(
            value,
            Value::String("unset".to_string()),
            "BOB_EXTENSION_SOCK_PATH should not be set on child env when path is empty"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_starts_configured_command_with_piped_stdio() {
        let worker = RpcWorkerProcess::spawn(&spawn_config("sh", &["-c", "exit 0"]))
            .expect("spawn should succeed");

        assert!(
            worker.child.id().is_some(),
            "spawned process should have an OS process id"
        );
        let _ = &worker.stdin;
        let _ = &worker.stdout;
        let _ = &worker._stderr;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_failure_returns_child_process_error_with_safe_detail() {
        let config = spawn_config(
            "__definitely_missing_pi_binary__",
            &["--mode", "rpc", "--trace"],
        );

        let error = RpcWorkerProcess::spawn(&config).expect_err("spawn should fail");

        assert!(
            matches!(error, ServiceError::ChildProcess { ref detail } if detail.contains("failed to spawn worker process")),
            "expected ServiceError::ChildProcess with safe detail, got: {error:?}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_json_writes_single_json_object_followed_by_lf() {
        let mut worker =
            RpcWorkerProcess::spawn(&spawn_config("cat", &[])).expect("spawn should succeed");
        let payload = json!({"command":"ping","seq":1});

        worker
            .send_json(&payload)
            .await
            .expect("send_json should succeed");

        let mut line = Vec::new();
        worker
            .stdout
            .read_until(b'\n', &mut line)
            .await
            .expect("stdout read should succeed");

        let mut expected = serde_json::to_vec(&payload).expect("payload serialization should work");
        expected.push(b'\n');
        assert_eq!(line, expected, "child stdin frame should be JSON + LF");

        let mut extra = Vec::new();
        let no_extra_line = timeout(
            TokioDuration::from_millis(25),
            worker.stdout.read_until(b'\n', &mut extra),
        )
        .await;
        assert!(
            no_extra_line.is_err(),
            "unexpected extra line bytes from a single send_json call: {extra:?}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_next_stdout_json_parses_each_lf_delimited_record() {
        let mut worker = RpcWorkerProcess::spawn(&spawn_config(
            "sh",
            &["-c", "printf '%s\\n' '{\"id\":1}' '{\"id\":2}'"],
        ))
        .expect("spawn should succeed");

        let first = worker
            .read_next_stdout_json()
            .await
            .expect("first record should parse");
        let second = worker
            .read_next_stdout_json()
            .await
            .expect("second record should parse");

        assert_eq!(first, Some(json!({"id": 1})));
        assert_eq!(second, Some(json!({"id": 2})));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_next_stdout_json_does_not_split_on_unicode_line_separator() {
        let mut worker = RpcWorkerProcess::spawn(&spawn_config(
            "sh",
            &["-c", "printf '\"alpha\\342\\200\\250omega\"\\n'"],
        ))
        .expect("spawn should succeed");

        let value = worker
            .read_next_stdout_json()
            .await
            .expect("record should parse")
            .expect("record should be present");

        assert_eq!(value, Value::String("alpha\u{2028}omega".to_string()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminate_requests_graceful_shutdown_before_deadline() {
        let worker = RpcWorkerProcess::spawn(&spawn_config(
            "sh",
            &["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
        ))
        .expect("spawn should succeed");

        let outcome = worker.terminate().await.expect("terminate should succeed");

        assert!(
            !outcome.forced,
            "cooperative child should terminate without force-kill"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminate_force_kills_when_child_exceeds_deadline() {
        let worker = RpcWorkerProcess::spawn(&WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "trap '' TERM; while :; do :; done".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(25),
            session_id: SessionId::new(),
            extension_sock_path: PathBuf::new(),
        })
        .expect("spawn should succeed");

        tokio::time::sleep(TokioDuration::from_millis(10)).await;

        let started_at = Instant::now();
        let outcome = worker.terminate().await.expect("terminate should succeed");
        let elapsed = started_at.elapsed();

        assert!(outcome.forced, "stubborn child should require force-kill");
        assert!(
            elapsed >= Duration::from_millis(25),
            "terminate should wait at least until deadline before force-kill"
        );
    }
}
