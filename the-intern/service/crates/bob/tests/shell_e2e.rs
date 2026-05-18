use std::{
    path::Path,
    process::{Child, Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

const SOCKET_APPEAR_DEADLINE: Duration = Duration::from_secs(2);
const SHUTDOWN_DRAIN_DEADLINE: Duration = Duration::from_millis(800);
const COMMAND_DEADLINE: Duration = Duration::from_secs(1);
const PROCESS_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

struct BobServeChild {
    child: Child,
}

impl BobServeChild {
    fn spawn(admin_sock_path: &str, extension_sock_path: &str) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_bob"))
            .arg("serve")
            .env("BOB_ADMIN_SOCK_PATH", admin_sock_path)
            .env("BOB_EXTENSION_SOCK_PATH", extension_sock_path)
            .env(
                "BOB_SHUTDOWN_DRAIN_DEADLINE",
                format!("{}ms", SHUTDOWN_DRAIN_DEADLINE.as_millis()),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bob serve");

        Self { child }
    }

    fn pid(&self) -> i32 {
        i32::try_from(self.child.id()).expect("child pid fits i32")
    }

    fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child
            .try_wait()
            .expect("polling bob serve status should succeed")
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_wait() {
                return Some(status);
            }

            if Instant::now() >= deadline {
                return None;
            }

            thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
        }
    }
}

impl Drop for BobServeChild {
    fn drop(&mut self) {
        if self.try_wait().is_some() {
            return;
        }

        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn shell_commands_work_end_to_end_against_spawned_serve() {
    let temp_dir = tempfile::tempdir().expect("create temp dir");
    let admin_sock_path = temp_dir.path().join("admin.sock");
    let extension_sock_path = temp_dir.path().join("extension.sock");
    let admin_sock_str = admin_sock_path
        .to_str()
        .expect("admin socket path is valid utf-8");
    let extension_sock_str = extension_sock_path
        .to_str()
        .expect("extension socket path is valid utf-8");

    let mut serve = BobServeChild::spawn(admin_sock_str, extension_sock_str);

    let sockets_ready = wait_for_both_sockets(&admin_sock_path, &extension_sock_path);
    assert!(
        sockets_ready,
        "expected admin.sock and extension.sock within {:?}",
        SOCKET_APPEAR_DEADLINE
    );

    let mut status_cmd = Command::new(env!("CARGO_BIN_EXE_bob"));
    status_cmd
        .arg("status")
        .env("BOB_ADMIN_SOCK_PATH", admin_sock_str)
        .env("BOB_EXTENSION_SOCK_PATH", extension_sock_str);
    let status_output = run_command_with_timeout(&mut status_cmd, "bob status", COMMAND_DEADLINE);
    assert_eq!(
        status_output.status.code(),
        Some(0),
        "bob status failed: stderr={}",
        String::from_utf8_lossy(&status_output.stderr)
    );
    let status_stdout = String::from_utf8(status_output.stdout).expect("status stdout is utf-8");
    assert!(
        !status_stdout.trim().is_empty(),
        "bob status should print non-empty payload"
    );

    let mut sessions_cmd = Command::new(env!("CARGO_BIN_EXE_bob"));
    sessions_cmd
        .args(["sessions", "list", "--json"])
        .env("BOB_ADMIN_SOCK_PATH", admin_sock_str)
        .env("BOB_EXTENSION_SOCK_PATH", extension_sock_str);
    let sessions_output = run_command_with_timeout(
        &mut sessions_cmd,
        "bob sessions list --json",
        COMMAND_DEADLINE,
    );
    assert_eq!(
        sessions_output.status.code(),
        Some(0),
        "bob sessions list --json failed: stderr={}",
        String::from_utf8_lossy(&sessions_output.stderr)
    );
    let sessions_stdout =
        String::from_utf8(sessions_output.stdout).expect("sessions stdout is utf-8");
    let sessions_json: Value =
        serde_json::from_str(sessions_stdout.trim()).expect("sessions output is valid json");
    assert_eq!(
        sessions_json,
        Value::Array(vec![]),
        "expected empty sessions array"
    );

    let kill_status = Command::new("kill")
        .arg("-TERM")
        .arg(serve.pid().to_string())
        .status()
        .expect("invoke kill -TERM");
    assert!(kill_status.success(), "kill -TERM should succeed");

    let exit_status = serve
        .wait_for_exit(SHUTDOWN_DRAIN_DEADLINE)
        .expect("bob serve should exit before shutdown drain deadline");
    assert_eq!(
        exit_status.code(),
        Some(0),
        "bob serve should exit with code 0 after SIGTERM"
    );

    assert!(
        !admin_sock_path.exists(),
        "admin socket file should be removed after graceful shutdown"
    );
    assert!(
        !extension_sock_path.exists(),
        "extension socket file should be removed after graceful shutdown"
    );
}

fn run_command_with_timeout(command: &mut Command, label: &str, timeout: Duration) -> Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("spawn {label}: {e}"));

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .unwrap_or_else(|e| panic!("collect {label} output: {e}"));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let output = child
                        .wait_with_output()
                        .unwrap_or_else(|e| panic!("collect timed out {label} output: {e}"));
                    panic!(
                        "{label} timed out after {:?}; stderr={}",
                        timeout,
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
            }
            Err(e) => panic!("poll {label} completion: {e}"),
        }
    }
}

fn wait_for_both_sockets(admin_sock_path: &Path, extension_sock_path: &Path) -> bool {
    let deadline = Instant::now() + SOCKET_APPEAR_DEADLINE;
    while Instant::now() < deadline {
        if admin_sock_path.exists() && extension_sock_path.exists() {
            return true;
        }
        thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
    }

    admin_sock_path.exists() && extension_sock_path.exists()
}
