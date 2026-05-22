#![forbid(unsafe_code)]

pub mod engine;
pub mod matcher;
pub mod ruleset;

pub use engine::PolicyEngine;
pub use ruleset::{ActionRule, ArgMatcher, PolicyConfig, RulesetError, RulesetSnapshot};

use std::path::PathBuf;
use std::sync::Arc;

use arc_swap::ArcSwap;
use bob_core::error::ServiceResult;
use tokio::{sync::mpsc, task::JoinHandle};

// ── SnapshotHandle ────────────────────────────────────────────────────────────

/// A cheaply cloneable handle to the active [`RulesetSnapshot`].
///
/// Backed by [`ArcSwap`] so readers never block writers: every call to
/// [`SnapshotHandle::load`] returns an `Arc` to the snapshot that was current
/// at the time of the call. Writes (via [`SnapshotHandle::store`]) are
/// atomic.
#[derive(Clone)]
pub struct SnapshotHandle {
    inner: Arc<ArcSwap<RulesetSnapshot>>,
}

impl SnapshotHandle {
    fn new(initial: RulesetSnapshot) -> Self {
        Self {
            inner: Arc::new(ArcSwap::from_pointee(initial)),
        }
    }

    /// Returns a reference-counted pointer to the current snapshot.
    ///
    /// The returned `Arc` is cheap to clone and never blocks.
    #[must_use]
    pub fn load(&self) -> Arc<RulesetSnapshot> {
        self.inner.load_full()
    }

    fn store(&self, snapshot: RulesetSnapshot) {
        self.inner.store(Arc::new(snapshot));
    }
}

// ── Config ────────────────────────────────────────────────────────────────────

/// Configuration for the policy-control actor.
///
/// Carries the initial [`RulesetSnapshot`] to serve immediately on start, and
/// the path to bob's TOML config file for subsequent [`Handle::reload`] calls.
///
/// The `Default` implementation yields a deny-all snapshot and an empty path
/// so that dependent crates (`bob`, `admin-rpc`) continue to compile before a
/// real config is wired in by T-053.
#[derive(Debug, Clone)]
pub struct Config {
    /// The snapshot to serve immediately on actor start.
    pub initial_snapshot: RulesetSnapshot,
    /// Path to bob's TOML config file; used by [`Handle::reload`].
    ///
    /// An empty path means reload is unsupported and will return an error.
    pub config_path: PathBuf,
    /// Capacity of the internal command channel.  Defaults to `16`.
    pub command_buffer: usize,
}

impl Default for Config {
    fn default() -> Self {
        // An empty PolicyConfig produces a deny-all snapshot and never errors.
        let deny_all = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![],
        })
        .expect("empty PolicyConfig must produce a valid deny-all snapshot");

        Self {
            initial_snapshot: deny_all,
            config_path: PathBuf::new(),
            command_buffer: 16,
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Commands sent from [`Handle`] to the actor.
enum Command {
    Reload {
        reply: tokio::sync::oneshot::Sender<ServiceResult<()>>,
    },
}

// ── Handle ────────────────────────────────────────────────────────────────────

/// A cheaply cloneable handle to the policy-control actor.
///
/// Keep the same type name so that `admin-rpc` and `bob` continue to compile
/// without changes.
#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Command>,
}

impl Handle {
    /// Reload the policy ruleset from the config file.
    ///
    /// Re-reads the config file, parses its `[policy]` table, builds a new
    /// [`RulesetSnapshot`], and on success atomically swaps it into the
    /// [`SnapshotHandle`].
    ///
    /// On parse or validation failure the error is returned and the previously
    /// active snapshot remains in force.
    ///
    /// # Errors
    ///
    /// Returns an error when:
    /// - The config path is empty or cannot be read.
    /// - The `[policy]` table cannot be parsed.
    /// - The parsed config fails [`RulesetSnapshot::from_config`] validation.
    pub async fn reload(&self) -> ServiceResult<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(Command::Reload { reply: tx }).await;
        rx.await
            .unwrap_or(Err(bob_core::error::ServiceError::ServiceDown))
    }
}

// ── Actor ─────────────────────────────────────────────────────────────────────

struct Actor {
    rx: mpsc::Receiver<Command>,
    snapshot: SnapshotHandle,
    config_path: PathBuf,
}

impl Actor {
    async fn run(mut self) {
        tracing::info!("policy-control actor started");
        while let Some(command) = self.rx.recv().await {
            match command {
                Command::Reload { reply } => {
                    let result = reload_snapshot(&self.config_path, &self.snapshot);
                    let _ = reply.send(result);
                }
            }
        }
        tracing::info!("policy-control actor stopped");
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Reads the TOML file at `path`, extracts the `[policy]` table, builds a
/// [`RulesetSnapshot`], and on success atomically stores it in `handle`.
fn reload_snapshot(path: &PathBuf, handle: &SnapshotHandle) -> ServiceResult<()> {
    if path.as_os_str().is_empty() {
        return Err(bob_core::error::ServiceError::NotImplemented);
    }

    let raw = std::fs::read_to_string(path).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "failed to read config file");
        bob_core::error::ServiceError::ServiceDown
    })?;

    let policy_cfg = load_policy_config_from_toml_str(&raw)?;

    let snapshot = RulesetSnapshot::from_config(policy_cfg).map_err(|e| {
        tracing::error!(error = %e, "policy config validation failed");
        bob_core::error::ServiceError::ServiceDown
    })?;

    handle.store(snapshot);
    Ok(())
}

/// Parses a raw TOML string and extracts the `[policy]` section as a
/// [`PolicyConfig`].
///
/// If the `[policy]` section is absent an empty (deny-all) `PolicyConfig` is
/// returned; if the section is present but malformed an error is returned.
fn load_policy_config_from_toml_str(raw: &str) -> ServiceResult<PolicyConfig> {
    #[derive(serde::Deserialize)]
    struct Root {
        #[serde(default)]
        policy: PolicyConfig,
    }

    let root: Root = toml::from_str(raw).map_err(|e| {
        tracing::error!(error = %e, "failed to parse TOML config");
        bob_core::error::ServiceError::ServiceDown
    })?;

    Ok(root.policy)
}

/// Loads a [`PolicyConfig`] from the `[policy]` table in the TOML file at
/// `path`.
///
/// # Errors
///
/// Returns an error when the file cannot be read or the TOML is malformed.
pub fn load_policy_config_from_file(path: &PathBuf) -> ServiceResult<PolicyConfig> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "failed to read config file");
        bob_core::error::ServiceError::ServiceDown
    })?;
    load_policy_config_from_toml_str(&raw)
}

// ── start ─────────────────────────────────────────────────────────────────────

/// Starts the policy-control actor.
///
/// Returns:
/// - A [`Handle`] for sending commands.
/// - A [`JoinHandle`] for the actor task.
/// - A [`SnapshotHandle`] for reading the current ruleset snapshot from the
///   two gate crates (wired in T-053 / T-054 / T-056).
pub fn start(cfg: Config) -> (Handle, JoinHandle<()>, SnapshotHandle) {
    let snapshot = SnapshotHandle::new(cfg.initial_snapshot);
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);

    let actor = Actor {
        rx,
        snapshot: snapshot.clone(),
        config_path: cfg.config_path,
    };

    let join = tokio::spawn(async move {
        actor.run().await;
    });

    let handle = Handle { tx };

    (handle, join, snapshot)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    // ── AC-1: SnapshotHandle is cheaply cloneable and never blocks readers ────

    #[test]
    fn snapshot_handle_clone_shares_same_arc_swap_allocation() {
        let snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![],
        })
        .expect("valid config");

        let handle = SnapshotHandle::new(snapshot);
        let clone = handle.clone();

        // Both handles point to the same inner ArcSwap allocation.
        assert!(Arc::ptr_eq(&handle.inner, &clone.inner));
    }

    #[test]
    fn snapshot_handle_load_returns_current_snapshot() {
        let snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![],
        })
        .expect("valid config");

        let handle = SnapshotHandle::new(snapshot);
        let loaded = handle.load();

        assert!(loaded.admitted_users().is_empty());
    }

    #[test]
    fn snapshot_handle_store_makes_new_snapshot_visible_to_load() {
        let initial = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![],
        })
        .expect("valid config");

        let handle = SnapshotHandle::new(initial);

        let new_snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec!["00000000-0000-0000-0000-000000000001".to_string()],
            action_rules: vec![],
        })
        .expect("valid config");

        handle.store(new_snapshot);

        let loaded = handle.load();
        assert_eq!(loaded.admitted_users().len(), 1);
    }

    // ── AC-2: Config::default() yields a deny-all snapshot ───────────────────

    #[test]
    fn config_default_initial_snapshot_is_deny_all() {
        let cfg = Config::default();

        assert!(
            cfg.initial_snapshot.admitted_users().is_empty(),
            "default snapshot must admit no users"
        );
        assert!(
            cfg.initial_snapshot.action_rules().is_empty(),
            "default snapshot must allow no actions"
        );
    }

    #[test]
    fn config_default_config_path_is_empty() {
        let cfg = Config::default();
        assert!(cfg.config_path.as_os_str().is_empty());
    }

    // ── AC-5: start serves the initial snapshot through the SnapshotHandle ───

    #[tokio::test(flavor = "current_thread")]
    async fn start_snapshot_handle_serves_initial_snapshot_from_config() {
        let snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec!["00000000-0000-0000-0000-000000000002".to_string()],
            action_rules: vec![],
        })
        .expect("valid config");

        let cfg = Config {
            initial_snapshot: snapshot,
            config_path: PathBuf::new(),
            command_buffer: 8,
        };

        let (_, join, snapshot_handle) = start(cfg);

        let loaded = snapshot_handle.load();
        assert_eq!(loaded.admitted_users().len(), 1);

        join.abort();
    }

    // ── AC-3: Handle::reload() swaps in a new snapshot on success ────────────

    #[tokio::test(flavor = "current_thread")]
    async fn handle_reload_swaps_snapshot_when_config_file_parses_and_validates() {
        let mut tmp = tempfile::NamedTempFile::new().expect("temp file");
        let user_id = "00000000-0000-0000-0000-000000000003";
        writeln!(tmp, "[policy]\nadmitted_users = [\"{user_id}\"]",).expect("write");
        let path = tmp.path().to_path_buf();

        let cfg = Config {
            initial_snapshot: RulesetSnapshot::from_config(PolicyConfig {
                admitted_users: vec![],
                action_rules: vec![],
            })
            .expect("valid config"),
            config_path: path,
            command_buffer: 8,
        };

        let (handle, join, snapshot_handle) = start(cfg);

        // Before reload: deny-all.
        assert!(snapshot_handle.load().admitted_users().is_empty());

        // Reload from the temp file.
        let result = handle.reload().await;
        assert!(result.is_ok(), "reload must succeed: {result:?}");

        // After reload: new snapshot is in place.
        let loaded = snapshot_handle.load();
        assert_eq!(loaded.admitted_users().len(), 1);

        join.abort();
    }

    // ── AC-4: Handle::reload() returns error and keeps old snapshot on failure

    #[tokio::test(flavor = "current_thread")]
    async fn handle_reload_returns_error_and_preserves_snapshot_when_config_is_invalid_toml() {
        let mut tmp = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(tmp, "[policy]\nnot valid = {{ toml").expect("write");
        let path = tmp.path().to_path_buf();

        let user_id = "00000000-0000-0000-0000-000000000004";
        let initial_snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec![user_id.to_string()],
            action_rules: vec![],
        })
        .expect("valid config");

        let cfg = Config {
            initial_snapshot,
            config_path: path,
            command_buffer: 8,
        };

        let (handle, join, snapshot_handle) = start(cfg);

        // Before reload: initial snapshot with 1 user.
        assert_eq!(snapshot_handle.load().admitted_users().len(), 1);

        // Reload fails.
        let result = handle.reload().await;
        assert!(
            result.is_err(),
            "reload must return an error for invalid TOML"
        );

        // After failed reload: initial snapshot still in place.
        assert_eq!(
            snapshot_handle.load().admitted_users().len(),
            1,
            "failed reload must not change the active snapshot"
        );

        join.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handle_reload_returns_error_and_preserves_snapshot_when_path_is_empty() {
        let initial_snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec!["00000000-0000-0000-0000-000000000005".to_string()],
            action_rules: vec![],
        })
        .expect("valid config");

        let cfg = Config {
            initial_snapshot,
            config_path: PathBuf::new(), // empty — unsupported
            command_buffer: 8,
        };

        let (handle, join, snapshot_handle) = start(cfg);

        let result = handle.reload().await;
        assert!(
            result.is_err(),
            "reload with empty path must return an error"
        );

        // Snapshot unchanged.
        assert_eq!(snapshot_handle.load().admitted_users().len(), 1);

        join.abort();
    }

    // ── Handle is clonable (regression for existing test) ────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, join, _snapshot) = start(Config::default());

        let _clone = handle.clone();

        join.abort();
    }
}
