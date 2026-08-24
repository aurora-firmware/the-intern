use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use policy_control::{load_policy_config_from_file, PolicyEngine, RulesetSnapshot};
use serde_json::json;

const SOCKET_APPEAR_DEADLINE: Duration = Duration::from_secs(5);
const CHAT_CAPTURE_DEADLINE: &str = "20s";
const PROCESS_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

fn extension_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../pi-extension/bob.ts")
}

struct IsolatedInitWorkspace {
    _xdg_root: tempfile::TempDir,
    _runtime_root: tempfile::TempDir,
    home_dir: PathBuf,
    xdg_config_home: PathBuf,
    xdg_data_home: PathBuf,
    xdg_state_home: PathBuf,
    workspace_path: PathBuf,
    config_path: PathBuf,
    skill_install_path: PathBuf,
    admin_sock_path: PathBuf,
    extension_sock_path: PathBuf,
    serve_stderr_path: PathBuf,
    chat_typescript_path: PathBuf,
}

impl IsolatedInitWorkspace {
    fn new() -> Self {
        let xdg_root = tempfile::Builder::new()
            .prefix("bob-init-e2e-")
            .tempdir()
            .expect("create isolated XDG root");
        let runtime_root = tempfile::Builder::new()
            .prefix("bob-init-runtime-")
            .tempdir()
            .expect("create isolated runtime root");

        let home_dir = xdg_root.path().join("home");
        let xdg_config_home = xdg_root.path().join("xdg-config");
        let xdg_data_home = xdg_root.path().join("xdg-data");
        let xdg_state_home = xdg_root.path().join("xdg-state");
        let workspace_path = xdg_root.path().join("workspace");
        let config_path = xdg_config_home.join("bob").join("config.toml");
        let skill_install_path = xdg_data_home.join("bob").join("skills");
        let admin_sock_path = runtime_root.path().join("admin.sock");
        let extension_sock_path = runtime_root.path().join("extension.sock");
        let serve_stderr_path = xdg_root.path().join("serve.stderr.log");
        let chat_typescript_path = xdg_root.path().join("chat.typescript");

        for dir in [&home_dir, &xdg_config_home, &xdg_data_home, &xdg_state_home] {
            fs::create_dir_all(dir).expect("create isolated XDG directory");
        }

        Self {
            _xdg_root: xdg_root,
            _runtime_root: runtime_root,
            home_dir,
            xdg_config_home,
            xdg_data_home,
            xdg_state_home,
            workspace_path,
            config_path,
            skill_install_path,
            admin_sock_path,
            extension_sock_path,
            serve_stderr_path,
            chat_typescript_path,
        }
    }

    fn apply_xdg_env<'a>(&self, command: &'a mut Command) -> &'a mut Command {
        command
            .env("HOME", &self.home_dir)
            .env("XDG_CONFIG_HOME", &self.xdg_config_home)
            .env("XDG_DATA_HOME", &self.xdg_data_home)
            .env("XDG_STATE_HOME", &self.xdg_state_home)
    }

    fn apply_runtime_env<'a>(&self, command: &'a mut Command) -> &'a mut Command {
        self.apply_xdg_env(command)
            .env("BOB_ADMIN_SOCK_PATH", &self.admin_sock_path)
            .env("BOB_EXTENSION_SOCK_PATH", &self.extension_sock_path)
            .env("BOB_EXTENSION_PATH", extension_fixture_path())
    }
}

struct BobServeChild {
    child: Child,
    stderr_path: PathBuf,
}

impl BobServeChild {
    fn spawn(env: &IsolatedInitWorkspace) -> Self {
        let stderr = File::create(&env.serve_stderr_path).expect("create serve stderr log");

        let mut command = Command::new(env!("CARGO_BIN_EXE_bob"));
        command
            .arg("serve")
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr));
        env.apply_runtime_env(&mut command);

        let child = command.spawn().expect("spawn bob serve");
        Self {
            child,
            stderr_path: env.serve_stderr_path.clone(),
        }
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

    fn stderr_contents(&self) -> String {
        fs::read_to_string(&self.stderr_path).unwrap_or_default()
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
fn init_materializes_shared_skills_and_bootstrap_policy_in_isolated_xdg_dirs() {
    ensure_real_pi_prerequisite();

    let env = IsolatedInitWorkspace::new();
    let init_output = run_bob_init(&env);
    assert_command_succeeded(&init_output, "bob init");

    assert!(
        env.skill_install_path.is_dir(),
        "shared skill install path should exist at {}",
        env.skill_install_path.display()
    );
    assert!(
        env.skill_install_path
            .join("email-triage")
            .join("SKILL.md")
            .is_file(),
        "email-triage skill should be installed under {}",
        env.skill_install_path.display()
    );
    assert!(
        env.skill_install_path
            .join("himalaya")
            .join("SKILL.md")
            .is_file(),
        "himalaya skill should be installed under {}",
        env.skill_install_path.display()
    );
    assert!(
        env.skill_install_path
            .join("worklog")
            .join("SKILL.md")
            .is_file(),
        "worklog skill should be installed under {}",
        env.skill_install_path.display()
    );
    assert!(
        env.skill_install_path
            .join("tasks")
            .join("SKILL.md")
            .is_file(),
        "tasks skill should be installed under {}",
        env.skill_install_path.display()
    );
    assert!(
        !env.workspace_path.join(".pi").join("skills").exists(),
        "initialized workspace must not contain a workspace-local .pi/skills tree"
    );

    let policy_cfg = load_policy_config_from_file(&env.config_path)
        .expect("generated config.toml should load its [policy] section");
    let snapshot =
        RulesetSnapshot::from_config(policy_cfg).expect("generated policy should validate");
    let configured_tools = snapshot
        .action_rules()
        .iter()
        .map(|rule| rule.tool.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        configured_tools,
        ["bash", "read", "write", "edit"],
        "generated config must admit exactly the four bootstrap tools"
    );
    assert!(
        snapshot
            .action_rules()
            .iter()
            .all(|rule| rule.arg_matchers.is_empty()),
        "bootstrap tool rules should not require argument matchers"
    );

    let unsupported = PolicyEngine::evaluate_action(&snapshot, "fetch", &json!({}));
    assert!(
        !unsupported.allow,
        "an unsupported tool must remain denied by the generated bootstrap policy"
    );
}

#[test]
fn init_creates_an_empty_board_directory_with_owner_only_permissions() {
    ensure_real_pi_prerequisite();

    let env = IsolatedInitWorkspace::new();
    let init_output = run_bob_init(&env);
    assert_command_succeeded(&init_output, "bob init");

    let board = env.workspace_path.join("tasks");
    assert!(
        board.is_dir(),
        "board directory should be created at {}",
        board.display()
    );
    assert_eq!(
        fs::read_dir(&board)
            .expect("board directory should be readable")
            .count(),
        0,
        "board directory should be created empty, with no task files written into it"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&board)
            .expect("board directory should be stat-able")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "board directory should be owner-only");
    }
}

#[test]
fn init_force_never_removes_or_replaces_existing_board_directory_contents() {
    ensure_real_pi_prerequisite();

    let env = IsolatedInitWorkspace::new();
    let first_init = run_bob_init(&env);
    assert_command_succeeded(&first_init, "bob init");

    let board = env.workspace_path.join("tasks");
    let existing_task = board.join("2026-08-24-example-task.md");
    fs::write(&existing_task, "keep me\n").expect("existing task file should be seeded");

    let forced_init = run_bob_init_forced(&env);
    assert_command_succeeded(&forced_init, "bob init --force");

    assert_eq!(
        fs::read_to_string(&existing_task).expect("existing task file should remain readable"),
        "keep me\n",
        "bob init --force must never remove or replace board content"
    );

    let stdout = String::from_utf8_lossy(&forced_init.stdout);
    assert!(
        stdout.contains(&board.display().to_string()),
        "bob init --force output should name the skipped board directory in its warnings; got: {stdout}"
    );
}

#[test]
fn initialized_workspace_chat_banner_lists_the_shared_skill_names() {
    ensure_real_pi_prerequisite();

    let env = IsolatedInitWorkspace::new();
    let init_output = run_bob_init(&env);
    assert_command_succeeded(&init_output, "bob init");

    let mut serve = BobServeChild::spawn(&env);
    wait_for_both_sockets(&env, &mut serve);

    let chat_output = run_chat_through_pty(&env);
    let transcript = fs::read_to_string(&env.chat_typescript_path)
        .expect("chat transcript should be written by script");

    assert!(
        transcript.contains("[Skills]"),
        "chat banner must include a [Skills] section; status={:?}\nstdout={}\nstderr={}\ntranscript={}",
        chat_output.status.code(),
        String::from_utf8_lossy(&chat_output.stdout),
        String::from_utf8_lossy(&chat_output.stderr),
        transcript
    );

    for skill in ["email-triage", "himalaya", "worklog", "tasks"] {
        assert!(
            transcript.contains(skill),
            "chat banner should advertise {skill} in [Skills]; status={:?}\nstdout={}\nstderr={}\ntranscript={}",
            chat_output.status.code(),
            String::from_utf8_lossy(&chat_output.stdout),
            String::from_utf8_lossy(&chat_output.stderr),
            transcript
        );
    }

    assert!(
        !env.workspace_path.join(".pi").join("skills").exists(),
        "shared-skill discovery must not rely on a workspace-local .pi/skills tree"
    );

    send_sigterm(serve.pid());
    let exit_status = serve
        .wait_for_exit(Duration::from_secs(5))
        .expect("bob serve should exit after SIGTERM");
    assert_eq!(
        exit_status.code(),
        Some(0),
        "bob serve should exit cleanly after the PTY chat capture; stderr={}",
        serve.stderr_contents()
    );
}

fn ensure_real_pi_prerequisite() {
    let output = Command::new("pi")
        .arg("--version")
        .output()
        .unwrap_or_else(|err| {
            panic!("real pi prerequisite unavailable: failed to execute `pi --version`: {err}")
        });
    assert!(
        output.status.success(),
        "real pi prerequisite unavailable: `pi --version` exited {:?}; stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_bob_init(env: &IsolatedInitWorkspace) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bob"));
    command.arg("init").arg(&env.workspace_path);
    env.apply_xdg_env(&mut command);
    command.output().expect("run bob init")
}

fn run_bob_init_forced(env: &IsolatedInitWorkspace) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bob"));
    command.arg("init").arg(&env.workspace_path).arg("--force");
    env.apply_xdg_env(&mut command);
    command.output().expect("run bob init --force")
}

fn run_chat_through_pty(env: &IsolatedInitWorkspace) -> Output {
    let chat_command = format!("{} chat", env!("CARGO_BIN_EXE_bob"));
    let mut command = Command::new("timeout");
    command.args([CHAT_CAPTURE_DEADLINE, "script", "-qefc", &chat_command]);
    command.arg(&env.chat_typescript_path);
    command.current_dir(&env.workspace_path);
    env.apply_runtime_env(&mut command);

    command.output().expect("run PTY chat capture")
}

fn wait_for_both_sockets(env: &IsolatedInitWorkspace, serve: &mut BobServeChild) {
    let deadline = Instant::now() + SOCKET_APPEAR_DEADLINE;
    while Instant::now() < deadline {
        if env.admin_sock_path.exists() && env.extension_sock_path.exists() {
            return;
        }

        if let Some(status) = serve.try_wait() {
            panic!(
                "bob serve exited before sockets appeared with status {:?}; stderr={}",
                status.code(),
                serve.stderr_contents()
            );
        }

        thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
    }

    panic!(
        "expected admin.sock and extension.sock within {:?}; stderr={}",
        SOCKET_APPEAR_DEADLINE,
        serve.stderr_contents()
    );
}

fn assert_command_succeeded(output: &Output, label: &str) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{label} failed: stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn send_sigterm(pid: i32) {
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .expect("invoke kill -TERM");
    assert!(status.success(), "kill -TERM must succeed for pid {pid}");
}
