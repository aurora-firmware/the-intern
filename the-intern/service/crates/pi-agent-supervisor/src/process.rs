use bob_core::{
    error::{ServiceError, ServiceResult},
    types::SessionId,
};
use serde_json::Value;
use std::os::unix::io::OwnedFd;
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
    /// Resolved path passed to pi as `--extension <path>`.
    pub extension_path: PathBuf,
    /// Working directory set on the child process via `current_dir`. `None`
    /// means the child inherits the launch cwd unchanged.
    pub worker_cwd: Option<PathBuf>,
    /// Absolute path to the installed skills package, set as
    /// `BOB_SKILL_INSTALL_PATH`. `None` or an empty path means the variable
    /// is not set on the child environment (ADR-014 §4 fail-open: missing
    /// path means no skills, not a spawn failure).
    pub skill_install_path: Option<PathBuf>,
}

#[derive(Debug)]
pub struct RpcWorkerProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    /// `None` once the reader has been detached via [`take_stdout`] so a caller
    /// can drain it in the background (see the periodic-dispatch path). After
    /// detaching, [`read_next_stdout_json`] errors because the worker no longer
    /// owns the stream.
    stdout: Option<BufReader<ChildStdout>>,
    _stderr: ChildStderr,
    child_termination_deadline: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminationOutcome {
    pub forced: bool,
}

impl RpcWorkerProcess {
    pub fn spawn(cfg: &WorkerProcessConfig) -> ServiceResult<Self> {
        if !cfg.extension_path.is_file() {
            return Err(ServiceError::ChildProcess {
                detail: format!(
                    "pi extension file does not exist at expected path '{}'",
                    cfg.extension_path.display()
                ),
            });
        }

        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .arg("--extension")
            .arg(&cfg.extension_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("BOB_SESSION_ID", cfg.session_id.to_string());

        if !cfg.extension_sock_path.as_os_str().is_empty() {
            cmd.env("BOB_EXTENSION_SOCK_PATH", &cfg.extension_sock_path);
        }

        if let Some(skill_install_path) = &cfg.skill_install_path {
            if !skill_install_path.as_os_str().is_empty() {
                cmd.env("BOB_SKILL_INSTALL_PATH", skill_install_path);
            }
        }

        if let Some(worker_cwd) = &cfg.worker_cwd {
            cmd.current_dir(worker_cwd);
        }

        let mut child = cmd.spawn().map_err(|error| ServiceError::ChildProcess {
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
            stdout: Some(BufReader::new(stdout)),
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
        let stdout = self
            .stdout
            .as_mut()
            .ok_or_else(|| ServiceError::ChildProcess {
                detail: "child stdout has been detached for background draining".to_string(),
            })?;
        let mut line = String::new();
        let read =
            stdout
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

    /// Detaches the child's stdout reader so the caller can drain it elsewhere.
    ///
    /// Returns `None` if the reader was already taken. After this returns, the
    /// worker no longer reads its own stdout, so [`read_next_stdout_json`] will
    /// error. This exists for the fire-and-forget periodic-dispatch path: once
    /// the prompt is accepted, the agent run streams to completion
    /// asynchronously and nothing would otherwise read stdout. An unread stdout
    /// pipe fills after a few kilobytes and blocks the child mid-run, so the
    /// caller must keep draining the returned reader until EOF.
    pub fn take_stdout(&mut self) -> Option<BufReader<ChildStdout>> {
        self.stdout.take()
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

/// Configuration for spawning an interactive pi session.
///
/// Interactive sessions differ from RPC workers in that they receive the
/// client's terminal file descriptors (via `SCM_RIGHTS`) as their stdio and
/// run pi in its default interactive (ink TUI) mode rather than `--mode rpc`.
#[derive(Debug)]
pub struct InteractiveProcessConfig {
    pub command: String,
    pub args: Vec<String>,
    pub child_termination_deadline: Duration,
    /// Session id set as `BOB_SESSION_ID` on the child environment.
    pub session_id: SessionId,
    /// Absolute path to the extension socket, set as `BOB_EXTENSION_SOCK_PATH`.
    /// If the path is empty, the variable is not set on the child environment.
    pub extension_sock_path: PathBuf,
    /// Resolved path passed to pi as `--extension <path>`.
    pub extension_path: PathBuf,
    /// Working directory set on the child process via `current_dir` (CR-005 /
    /// B-021: the directory `bob chat` was invoked from). `None` means the
    /// child inherits the launch cwd unchanged — mirrors
    /// `WorkerProcessConfig::worker_cwd`.
    pub cwd: Option<PathBuf>,
}

/// A supervised interactive pi child process.
///
/// The child is spawned on the three file descriptors supplied by the caller —
/// typically the client's controlling-terminal fds passed via `SCM_RIGHTS`
/// (ADR-011).  No piped stdio is used; the caller must not attempt to write to
/// or read from the child via this handle.
#[derive(Debug)]
pub struct InteractiveProcess {
    child: Child,
    child_termination_deadline: Duration,
}

impl InteractiveProcess {
    /// Spawns an interactive pi child on the supplied stdio file descriptors.
    ///
    /// The three `OwnedFd` arguments become the child's stdin, stdout, and
    /// stderr respectively; ownership is transferred to the child so the fds
    /// are closed in the parent after the child is started.
    ///
    /// Fails if the configured extension file does not exist, or if the OS
    /// rejects the `execve` call.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::ChildProcess` when the extension file is absent
    /// or when the OS rejects the spawn.
    pub fn spawn(
        cfg: InteractiveProcessConfig,
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: OwnedFd,
    ) -> ServiceResult<Self> {
        if !cfg.extension_path.is_file() {
            return Err(ServiceError::ChildProcess {
                detail: format!(
                    "pi extension file does not exist at expected path '{}'",
                    cfg.extension_path.display()
                ),
            });
        }

        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .arg("--extension")
            .arg(&cfg.extension_path)
            .stdin(Stdio::from(stdin))
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .env("BOB_SESSION_ID", cfg.session_id.to_string());

        if !cfg.extension_sock_path.as_os_str().is_empty() {
            cmd.env("BOB_EXTENSION_SOCK_PATH", &cfg.extension_sock_path);
        }

        if let Some(cwd) = &cfg.cwd {
            cmd.current_dir(cwd);
        }

        let child = cmd.spawn().map_err(|error| ServiceError::ChildProcess {
            detail: format!(
                "failed to spawn interactive process for command '{}' ({error})",
                cfg.command
            ),
        })?;

        Ok(Self {
            child,
            child_termination_deadline: cfg.child_termination_deadline,
        })
    }

    /// Waits for the interactive child to exit naturally.
    ///
    /// Does **not** send any signal — callers that want to kill the child should
    /// call [`terminate`](Self::terminate) instead.  Returns `()` once the
    /// child exits (or if the wait syscall fails), discarding the exit status.
    pub async fn wait_for_exit(mut self) {
        let _ = self.child.wait().await;
    }

    /// Non-blocking check: returns `true` if the child has already exited.
    ///
    /// Uses `try_wait()` to reap a zombie without blocking.  Returns `false`
    /// when the child is still running or when the status cannot be retrieved.
    ///
    /// Idempotent: calling this multiple times after the child exits continues
    /// to return `true` (the zombie was reaped on the first `true` return).
    pub fn try_poll_exit(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_status)) => true, // child exited
            Ok(None) => false,         // still running
            Err(_) => false,           // treat error as "still running" conservatively
        }
    }

    /// Terminates the interactive child process.
    ///
    /// Sends `SIGTERM` and waits up to `child_termination_deadline`; if the
    /// child does not exit within that window it is force-killed with `SIGKILL`.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::ChildProcess` if the OS rejects the signal or if
    /// waiting for the child fails.
    pub async fn terminate(mut self) -> ServiceResult<TerminationOutcome> {
        self.request_graceful_termination()?;

        let wait_result = time::timeout(self.child_termination_deadline, self.child.wait()).await;
        match wait_result {
            Ok(Ok(_status)) => Ok(TerminationOutcome { forced: false }),
            Ok(Err(error)) => Err(ServiceError::ChildProcess {
                detail: format!("failed while waiting for interactive child termination ({error})"),
            }),
            Err(_) => {
                if let Some(_status) =
                    self.child
                        .try_wait()
                        .map_err(|error| ServiceError::ChildProcess {
                            detail: format!(
                                "failed to inspect interactive child status during termination ({error})"
                            ),
                        })?
                {
                    return Ok(TerminationOutcome { forced: false });
                }

                self.child
                    .kill()
                    .await
                    .map_err(|error| ServiceError::ChildProcess {
                        detail: format!("failed to force-kill interactive child process ({error})"),
                    })?;

                self.child
                    .wait()
                    .await
                    .map_err(|error| ServiceError::ChildProcess {
                        detail: format!(
                            "failed while waiting for force-killed interactive child ({error})"
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
                            "failed to request graceful interactive child termination via SIGTERM ({error})"
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
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_passes_resolved_extension_path_on_command_line() {
        let extension_path = std::env::current_exe().expect("current executable should exist");
        let mut cfg = spawn_config("sh", &["-c", "printf '[\"%s\",\"%s\"]\\n' \"$0\" \"$1\""]);
        cfg.extension_path = extension_path.clone();

        let mut worker = RpcWorkerProcess::spawn(&cfg).expect("spawn should succeed");
        let value = worker
            .read_next_stdout_json()
            .await
            .expect("stdout read should succeed")
            .expect("argument record should be present");

        assert_eq!(
            value,
            json!(["--extension", extension_path.to_string_lossy()]),
            "spawn must append the resolved extension path to the worker command"
        );
    }

    #[test]
    fn spawn_refuses_missing_extension_file_and_names_expected_path() {
        let extension_path =
            std::env::temp_dir().join(format!("missing-bob-extension-{}.ts", SessionId::new()));
        let mut cfg = spawn_config("sh", &["-c", "exit 0"]);
        cfg.extension_path = extension_path.clone();

        let error = RpcWorkerProcess::spawn(&cfg).expect_err("spawn should fail closed");

        assert!(
            matches!(
                error,
                ServiceError::ChildProcess { ref detail }
                    if detail.contains(&extension_path.to_string_lossy().into_owned())
            ),
            "error must name the expected extension path, got: {error:?}"
        );
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
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: None,
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
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: None,
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
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: None,
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

    // AC-2 (T-158): BOB_SKILL_INSTALL_PATH is set when configured to a
    // non-empty path.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_sets_bob_skill_install_path_when_path_is_non_empty() {
        let session_id = SessionId::new();
        let skill_install_path = PathBuf::from("/opt/bob/skills");
        let cfg = WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                // Output the env var as a JSON string for read_next_stdout_json.
                "printf '\"%s\"\\n' \"$BOB_SKILL_INSTALL_PATH\"".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(50),
            session_id,
            extension_sock_path: PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: Some(skill_install_path.clone()),
        };

        let mut worker = RpcWorkerProcess::spawn(&cfg).expect("spawn should succeed");

        let value = worker
            .read_next_stdout_json()
            .await
            .expect("stdout read should succeed")
            .expect("value should be present");

        assert_eq!(
            value,
            Value::String(skill_install_path.to_string_lossy().into_owned()),
            "BOB_SKILL_INSTALL_PATH on child env should match the configured path"
        );
    }

    // AC-3 (T-158): when skill_install_path is unset (None), spawn proceeds
    // without that var.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_omits_bob_skill_install_path_when_unset() {
        let session_id = SessionId::new();
        let cfg = WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                // Print "unset" when the variable is absent, "set:<value>" when present.
                "if [ -z \"${BOB_SKILL_INSTALL_PATH+x}\" ]; then printf '\"unset\"\\n'; else printf '\"set:%s\"\\n' \"$BOB_SKILL_INSTALL_PATH\"; fi".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(50),
            session_id,
            extension_sock_path: PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: None,
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
            "BOB_SKILL_INSTALL_PATH should not be set on child env when skill_install_path is unset"
        );
    }

    // AC-3 (T-158): when skill_install_path is Some(empty path), spawn
    // proceeds without that var (empty must be treated like unset).
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_omits_bob_skill_install_path_when_path_is_empty() {
        let session_id = SessionId::new();
        let cfg = WorkerProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "if [ -z \"${BOB_SKILL_INSTALL_PATH+x}\" ]; then printf '\"unset\"\\n'; else printf '\"set:%s\"\\n' \"$BOB_SKILL_INSTALL_PATH\"; fi".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(50),
            session_id,
            extension_sock_path: PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: Some(PathBuf::new()),
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
            "BOB_SKILL_INSTALL_PATH should not be set on child env when skill_install_path is an empty path"
        );
    }

    // AC-2 (T-121): when worker_cwd is configured, the child's current
    // directory is set to it.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_sets_current_dir_on_child_when_worker_cwd_is_configured() {
        let worker_cwd = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-worker-cwd-{}",
            SessionId::new()
        ));
        std::fs::create_dir_all(&worker_cwd).expect("create worker cwd dir should succeed");

        let mut cfg = spawn_config("sh", &["-c", "printf '\"%s\"\\n' \"$(pwd)\""]);
        cfg.worker_cwd = Some(worker_cwd.clone());

        let mut worker = RpcWorkerProcess::spawn(&cfg).expect("spawn should succeed");
        let value = worker
            .read_next_stdout_json()
            .await
            .expect("stdout read should succeed")
            .expect("value should be present");

        let expected =
            std::fs::canonicalize(&worker_cwd).expect("canonicalize expected worker cwd");
        let actual_raw = value
            .as_str()
            .expect("child pwd output should be a JSON string");
        let actual =
            std::fs::canonicalize(actual_raw).expect("canonicalize child-reported current dir");

        assert_eq!(
            actual, expected,
            "child current dir should match configured worker_cwd"
        );

        std::fs::remove_dir_all(&worker_cwd).ok();
    }

    // AC-3 (T-121): when worker_cwd is unset, the child inherits the launch cwd.
    #[tokio::test(flavor = "current_thread")]
    async fn spawn_inherits_launch_cwd_when_worker_cwd_is_not_configured() {
        let cfg = spawn_config("sh", &["-c", "printf '\"%s\"\\n' \"$(pwd)\""]);
        assert_eq!(
            cfg.worker_cwd, None,
            "test setup expects worker_cwd to default to None"
        );

        let mut worker = RpcWorkerProcess::spawn(&cfg).expect("spawn should succeed");
        let value = worker
            .read_next_stdout_json()
            .await
            .expect("stdout read should succeed")
            .expect("value should be present");

        let expected = std::env::current_dir().expect("current dir should be available");
        let actual_raw = value
            .as_str()
            .expect("child pwd output should be a JSON string");

        assert_eq!(
            actual_raw,
            expected.to_string_lossy(),
            "child should inherit the launch cwd when worker_cwd is unset"
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
        let mut worker = RpcWorkerProcess::spawn(&spawn_config("sh", &["-c", "cat"]))
            .expect("spawn should succeed");
        let payload = json!({"command":"ping","seq":1});

        worker
            .send_json(&payload)
            .await
            .expect("send_json should succeed");

        let stdout = worker.stdout.as_mut().expect("stdout should be present");
        let mut line = Vec::new();
        stdout
            .read_until(b'\n', &mut line)
            .await
            .expect("stdout read should succeed");

        let mut expected = serde_json::to_vec(&payload).expect("payload serialization should work");
        expected.push(b'\n');
        assert_eq!(line, expected, "child stdin frame should be JSON + LF");

        let stdout = worker.stdout.as_mut().expect("stdout should be present");
        let mut extra = Vec::new();
        let no_extra_line = timeout(
            TokioDuration::from_millis(25),
            stdout.read_until(b'\n', &mut extra),
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
            extension_path: std::env::current_exe().expect("current executable should exist"),
            worker_cwd: None,
            skill_install_path: None,
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

    // AC-1: InteractiveProcess::spawn sets BOB_SESSION_ID and BOB_EXTENSION_SOCK_PATH
    // and passes --extension <path> on the command line.
    //
    // The child writes its env vars and all positional args to a temp file via its
    // stdout (which we redirect to that file via OwnedFd).
    #[tokio::test(flavor = "current_thread")]
    async fn interactive_spawn_sets_session_env_and_extension_arg() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let out_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-interactive-env-{}.txt",
            SessionId::new()
        ));
        let _ = std::fs::remove_file(&out_file);

        let session_id = SessionId::new();
        let sock_path = PathBuf::from("/run/bob/extension-interactive.sock");
        let extension_path = std::env::current_exe().expect("current executable should exist");

        // Script outputs env vars and all positional args ($@) to stdout.
        // spawn() appends `--extension <path>` after the user-supplied args,
        // so $@ will contain those extra args.
        let script = "printf 'session:%s\\next:%s\\n' \"$BOB_SESSION_ID\" \
                      \"$BOB_EXTENSION_SOCK_PATH\"; printf 'arg:%s\\n' \"$@\"";

        let stdin_fd: OwnedFd = File::open("/dev/null")
            .expect("open /dev/null for stdin")
            .into();
        let stdout_fd: OwnedFd = File::create(&out_file)
            .expect("create output file for stdout")
            .into();
        let stderr_fd: OwnedFd = File::open("/dev/null")
            .expect("open /dev/null for stderr")
            .into();

        // Pass `--` as $0 so the positional params to the script start at $1 (= --extension).
        let cfg = InteractiveProcessConfig {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), script.to_string(), "--".to_string()],
            child_termination_deadline: Duration::from_millis(2000),
            session_id,
            extension_sock_path: sock_path.clone(),
            extension_path: extension_path.clone(),
            cwd: None,
        };

        let process = InteractiveProcess::spawn(cfg, stdin_fd, stdout_fd, stderr_fd)
            .expect("interactive spawn should succeed");

        tokio::time::sleep(TokioDuration::from_millis(150)).await;
        drop(process);

        let written = std::fs::read_to_string(&out_file)
            .expect("output file should have been written by child");

        assert!(
            written.contains(&format!("session:{}", session_id)),
            "BOB_SESSION_ID should be set on interactive child; got: {written:?}"
        );
        assert!(
            written.contains(&format!("ext:{}", sock_path.display())),
            "BOB_EXTENSION_SOCK_PATH should be set on interactive child; got: {written:?}"
        );
        assert!(
            written.contains(&format!("arg:{}", extension_path.display())),
            "--extension path should appear in child positional args; got: {written:?}"
        );

        let _ = std::fs::remove_file(&out_file);
    }

    // AC-1: InteractiveProcess::spawn returns ChildProcess error when extension file is missing.
    #[test]
    fn interactive_spawn_refuses_missing_extension_file() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let missing = std::env::temp_dir().join(format!(
            "missing-interactive-extension-{}.ts",
            SessionId::new()
        ));

        let stdin_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stdout_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stderr_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();

        let cfg = InteractiveProcessConfig {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            child_termination_deadline: Duration::from_millis(100),
            session_id: SessionId::new(),
            extension_sock_path: PathBuf::new(),
            extension_path: missing.clone(),
            cwd: None,
        };

        let error = InteractiveProcess::spawn(cfg, stdin_fd, stdout_fd, stderr_fd)
            .expect_err("interactive spawn should fail when extension file is missing");

        assert!(
            matches!(
                error,
                ServiceError::ChildProcess { ref detail }
                    if detail.contains(&missing.to_string_lossy().into_owned())
            ),
            "error must name the missing extension path; got: {error:?}"
        );
    }

    // AC-3: InteractiveProcess::terminate sends SIGTERM and waits for exit.
    #[tokio::test(flavor = "current_thread")]
    async fn interactive_terminate_requests_graceful_shutdown_before_deadline() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let stdin_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stdout_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();
        let stderr_fd: OwnedFd = File::open("/dev/null").expect("open /dev/null").into();

        let cfg = InteractiveProcessConfig {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "trap 'exit 0' TERM; while :; do sleep 1; done".to_string(),
            ],
            child_termination_deadline: Duration::from_millis(2000),
            session_id: SessionId::new(),
            extension_sock_path: PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
            cwd: None,
        };

        let process = InteractiveProcess::spawn(cfg, stdin_fd, stdout_fd, stderr_fd)
            .expect("interactive spawn should succeed");

        let outcome = process.terminate().await.expect("terminate should succeed");
        assert!(
            !outcome.forced,
            "cooperative interactive child should terminate without force-kill"
        );
    }

    // B-021 / CR-005: when cfg.cwd is configured, the interactive child's
    // current directory is set to it (mirrors
    // spawn_sets_current_dir_on_child_when_worker_cwd_is_configured for
    // RpcWorkerProcess).
    #[tokio::test(flavor = "current_thread")]
    async fn interactive_spawn_sets_current_dir_on_child_when_cwd_is_configured() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let interactive_cwd = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-interactive-cwd-{}",
            SessionId::new()
        ));
        std::fs::create_dir_all(&interactive_cwd).expect("create interactive cwd dir");

        let out_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-interactive-cwd-out-{}.txt",
            SessionId::new()
        ));
        let _ = std::fs::remove_file(&out_file);

        let stdin_fd: OwnedFd = File::open("/dev/null")
            .expect("open /dev/null for stdin")
            .into();
        let stdout_fd: OwnedFd = File::create(&out_file)
            .expect("create output file for stdout")
            .into();
        let stderr_fd: OwnedFd = File::open("/dev/null")
            .expect("open /dev/null for stderr")
            .into();

        let cfg = InteractiveProcessConfig {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), "printf '%s' \"$(pwd)\"".to_string()],
            child_termination_deadline: Duration::from_millis(2000),
            session_id: SessionId::new(),
            extension_sock_path: PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
            cwd: Some(interactive_cwd.clone()),
        };

        let process = InteractiveProcess::spawn(cfg, stdin_fd, stdout_fd, stderr_fd)
            .expect("interactive spawn should succeed");
        process.wait_for_exit().await;

        let written = std::fs::read_to_string(&out_file)
            .expect("output file should have been written by child");

        let expected =
            std::fs::canonicalize(&interactive_cwd).expect("canonicalize expected interactive cwd");
        let actual =
            std::fs::canonicalize(written.trim()).expect("canonicalize child-reported current dir");

        assert_eq!(
            actual, expected,
            "interactive child current dir should match configured cwd"
        );

        std::fs::remove_dir_all(&interactive_cwd).ok();
        let _ = std::fs::remove_file(&out_file);
    }

    // B-021 / CR-005: when cfg.cwd is unset, the interactive child inherits
    // the launch cwd (mirrors
    // spawn_inherits_launch_cwd_when_worker_cwd_is_not_configured for
    // RpcWorkerProcess).
    #[tokio::test(flavor = "current_thread")]
    async fn interactive_spawn_inherits_launch_cwd_when_cwd_is_not_configured() {
        use std::fs::File;
        use std::os::unix::io::OwnedFd;

        let out_file = std::env::temp_dir().join(format!(
            "pi-agent-supervisor-interactive-no-cwd-out-{}.txt",
            SessionId::new()
        ));
        let _ = std::fs::remove_file(&out_file);

        let stdin_fd: OwnedFd = File::open("/dev/null")
            .expect("open /dev/null for stdin")
            .into();
        let stdout_fd: OwnedFd = File::create(&out_file)
            .expect("create output file for stdout")
            .into();
        let stderr_fd: OwnedFd = File::open("/dev/null")
            .expect("open /dev/null for stderr")
            .into();

        let cfg = InteractiveProcessConfig {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), "printf '%s' \"$(pwd)\"".to_string()],
            child_termination_deadline: Duration::from_millis(2000),
            session_id: SessionId::new(),
            extension_sock_path: PathBuf::new(),
            extension_path: std::env::current_exe().expect("current executable should exist"),
            cwd: None,
        };
        assert_eq!(cfg.cwd, None, "test setup expects cwd to default to None");

        let process = InteractiveProcess::spawn(cfg, stdin_fd, stdout_fd, stderr_fd)
            .expect("interactive spawn should succeed");
        process.wait_for_exit().await;

        let written = std::fs::read_to_string(&out_file)
            .expect("output file should have been written by child");

        let expected = std::env::current_dir().expect("current dir should be available");

        assert_eq!(
            written.trim(),
            expected.to_string_lossy(),
            "interactive child should inherit the launch cwd when cwd is unset"
        );

        let _ = std::fs::remove_file(&out_file);
    }
}
