use std::{
    collections::BTreeMap,
    env,
    fs::OpenOptions,
    path::{Path, PathBuf},
    time::Duration,
};

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::types::{schedule::read_schedule_store, AuditFilterKind, ScheduleEntry};
use figment::{
    providers::{Format, Serialized, Toml},
    Figment,
};
use policy_control::PolicyConfig;
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone)]
pub struct BobConfig {
    pub admin_sock_path: PathBuf,
    pub extension_sock_path: PathBuf,
    pub extension_path: PathBuf,
    pub request_queue_capacity: usize,
    pub request_submit_timeout: Duration,
    pub shutdown_drain_deadline: Duration,
    pub shutdown_reap_deadline: Duration,
    pub pi_agent_command: String,
    pub pi_agent_args: Vec<String>,
    pub pi_agent_warm_pool_size: usize,
    pub pi_agent_max_processes: usize,
    pub pi_agent_idle_reap_timeout: Duration,
    pub tracing_level: String,
    pub tracing_format: String,
    /// Policy rules sourced from the `[policy]` TOML section.
    ///
    /// An absent `[policy]` section yields an empty (deny-all) config.
    pub policy: PolicyConfig,
    /// Monitoring configuration sourced from the `[monitoring]` TOML section.
    pub monitoring: MonitoringConfig,
    /// Resolved path to the TOML config file used to load this config.
    ///
    /// An empty path means no config file was loaded (defaults only).
    /// Used by the policy-control actor for hot-reload.
    pub config_path: PathBuf,
    /// Schedule configuration sourced from the `[[schedule]]` TOML section.
    ///
    /// An absent or empty section yields an empty entries vec (no jobs).
    pub schedule: ScheduleConfig,
    /// Resolved path to the JSON schedule store.
    ///
    /// The default on Linux is `$XDG_STATE_HOME/bob/schedules.json` with
    /// `~/.local/state/bob/schedules.json` as the XDG fallback.  Can be
    /// overridden via the `BOB_SCHEDULE_STORE_PATH` environment variable or a
    /// `schedule_store_path` key in `config.toml`.
    pub schedule_store_path: PathBuf,
}

/// Validated schedule configuration — the view the rest of the service uses.
#[derive(Debug, Clone)]
pub struct ScheduleConfig {
    pub entries: Vec<ScheduleEntry>,
}

#[derive(Debug, Clone)]
pub struct MonitoringConfig {
    pub audit_log_path: PathBuf,
    pub default_tail_filters: Vec<AuditFilterKind>,
}

// `Default` is intentionally not implemented for `BobConfig`.
//
// Both `admin_sock_path` and `extension_sock_path` must be non-empty for the
// service to bind its Unix domain sockets.  A derived or hand-written `Default`
// would produce empty `PathBuf` values that silently create a non-bootable
// runtime.  All construction must go through `BobConfig::load()` (which calls
// `validate()`) or through the test helper `BobConfig::test_base()` (which is
// intentionally visible only in `#[cfg(test)]` contexts).

#[cfg(test)]
impl BobConfig {
    /// Returns a `BobConfig` whose non-path fields carry production-like defaults
    /// and whose socket paths are intentionally empty.
    ///
    /// Use this only as a struct-update base (`..BobConfig::test_base()`) in
    /// unit tests that supply real socket paths before the config is used to
    /// bind sockets.  Do not use it in tests that exercise the `validate()`
    /// or `load_with_sources()` paths.
    pub(crate) fn test_base() -> Self {
        Self {
            admin_sock_path: PathBuf::new(),
            extension_sock_path: PathBuf::new(),
            extension_path: PathBuf::new(),
            request_queue_capacity: 1024,
            request_submit_timeout: Duration::from_secs(5),
            shutdown_drain_deadline: Duration::from_secs(30),
            shutdown_reap_deadline: Duration::from_secs(10),
            pi_agent_command: "pi".to_string(),
            pi_agent_args: vec!["--mode".to_string(), "rpc".to_string()],
            pi_agent_warm_pool_size: 1,
            pi_agent_max_processes: 8,
            pi_agent_idle_reap_timeout: Duration::from_secs(300),
            tracing_level: "info".to_string(),
            tracing_format: "pretty".to_string(),
            policy: PolicyConfig::default(),
            monitoring: MonitoringConfig {
                audit_log_path: PathBuf::new(),
                default_tail_filters: default_tail_filters(),
            },
            config_path: PathBuf::new(),
            schedule: ScheduleConfig {
                entries: Vec::new(),
            },
            schedule_store_path: PathBuf::new(),
        }
    }
}

impl BobConfig {
    pub fn load() -> ServiceResult<Self> {
        let sources = ConfigSources::from_process()?;
        Self::load_with_sources(sources)
    }

    fn load_with_sources(sources: ConfigSources) -> ServiceResult<Self> {
        let runtime_root = resolve_runtime_root(&sources)?;
        let defaults = defaults_with_runtime_root(runtime_root, &sources.env, sources.uid);

        let config_path = if let Some(path) = sources.config_path.clone() {
            path
        } else {
            default_config_path(&sources)
        };

        let mut figment = Figment::from(Serialized::defaults(defaults));
        if config_path.exists() {
            figment = figment.merge(Toml::file(&config_path));
        }
        let env_overrides = env_overrides(&sources.env);
        let cli_override_count = sources.cli_overrides.len();

        figment = merge_key_value_overrides(figment, env_overrides.clone());
        figment = merge_key_value_overrides(figment, sources.cli_overrides.clone());

        let raw: RawBobConfig = figment.extract().map_err(to_configuration_error)?;

        tracing::debug!(
            has_config_file = config_path.exists(),
            env_override_count = env_overrides.len(),
            cli_override_count,
            "loaded bob configuration from layered sources"
        );

        // Load schedule entries from the JSON store.  A missing store is treated
        // as empty (no jobs); a malformed store fails startup with a
        // Configuration error so the operator can fix the file.
        let schedule_entries = read_schedule_store(&raw.schedule_store_path)?;
        let schedule = ScheduleConfig {
            entries: schedule_entries,
        };

        let cfg = BobConfig {
            admin_sock_path: raw.admin_sock_path,
            extension_sock_path: raw.extension_sock_path,
            extension_path: raw.extension_path,
            request_queue_capacity: raw.request_queue_capacity,
            request_submit_timeout: raw.request_submit_timeout,
            shutdown_drain_deadline: raw.shutdown_drain_deadline,
            shutdown_reap_deadline: raw.shutdown_reap_deadline,
            pi_agent_command: raw.pi_agent_command,
            pi_agent_args: raw.pi_agent_args,
            pi_agent_warm_pool_size: raw.pi_agent_warm_pool_size,
            pi_agent_max_processes: raw.pi_agent_max_processes,
            pi_agent_idle_reap_timeout: raw.pi_agent_idle_reap_timeout,
            tracing_level: raw.tracing_level,
            tracing_format: raw.tracing_format,
            policy: raw.policy,
            monitoring: MonitoringConfig {
                audit_log_path: raw
                    .monitoring
                    .audit_log_path
                    .unwrap_or_else(|| default_monitoring_audit_log_path(&sources)),
                default_tail_filters: raw
                    .monitoring
                    .default_tail_filters
                    .unwrap_or_else(default_tail_filters),
            },
            // Carry the resolved config file path so the policy-control actor
            // can hot-reload from the same file on Handle::reload().
            config_path: config_path.clone(),
            schedule,
            schedule_store_path: raw.schedule_store_path,
        };

        cfg.validate()
    }

    fn validate(self) -> ServiceResult<Self> {
        if self.admin_sock_path.as_os_str().is_empty() {
            return Err(configuration_error(
                "admin_sock_path must not be empty; provide a valid socket path",
            ));
        }

        if self.extension_sock_path.as_os_str().is_empty() {
            return Err(configuration_error(
                "extension_sock_path must not be empty; provide a valid socket path",
            ));
        }

        if self.request_queue_capacity == 0 {
            return Err(configuration_error(
                "request_queue_capacity must be positive",
            ));
        }

        if self.pi_agent_warm_pool_size == 0 {
            return Err(configuration_error(
                "pi_agent_warm_pool_size must be positive",
            ));
        }

        if self.pi_agent_max_processes == 0 {
            return Err(configuration_error(
                "pi_agent_max_processes must be positive",
            ));
        }

        if self.pi_agent_warm_pool_size > self.pi_agent_max_processes {
            return Err(configuration_error(
                "pi_agent_warm_pool_size cannot exceed pi_agent_max_processes",
            ));
        }

        ensure_monitoring_audit_log_path(&self.monitoring.audit_log_path)?;

        Ok(self)
    }
}

#[derive(Debug, Clone)]
struct ConfigSources {
    env: BTreeMap<String, String>,
    config_path: Option<PathBuf>,
    cli_overrides: BTreeMap<String, String>,
    uid: u32,
}

impl ConfigSources {
    fn from_process() -> ServiceResult<Self> {
        let mut env_map = BTreeMap::new();
        for (key, value) in env::vars() {
            env_map.insert(key, value);
        }

        Ok(Self {
            env: env_map,
            config_path: None,
            cli_overrides: parse_cli_overrides(env::args().skip(1))?,
            uid: current_uid(),
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawBobConfig {
    admin_sock_path: PathBuf,
    extension_sock_path: PathBuf,
    extension_path: PathBuf,
    #[serde(deserialize_with = "deserialize_usize")]
    request_queue_capacity: usize,
    #[serde(deserialize_with = "deserialize_duration")]
    request_submit_timeout: Duration,
    #[serde(deserialize_with = "deserialize_duration")]
    shutdown_drain_deadline: Duration,
    #[serde(deserialize_with = "deserialize_duration")]
    shutdown_reap_deadline: Duration,
    pi_agent_command: String,
    #[serde(default, deserialize_with = "deserialize_string_vec")]
    pi_agent_args: Vec<String>,
    #[serde(deserialize_with = "deserialize_usize")]
    pi_agent_warm_pool_size: usize,
    #[serde(deserialize_with = "deserialize_usize")]
    pi_agent_max_processes: usize,
    #[serde(deserialize_with = "deserialize_duration")]
    pi_agent_idle_reap_timeout: Duration,
    tracing_level: String,
    tracing_format: String,
    /// Policy rules from the `[policy]` TOML section; absent means deny-all.
    ///
    /// Serialization is skipped because `PolicyConfig` does not implement
    /// `Serialize`.  The figment defaults layer does not include this field;
    /// it arrives only from the TOML config file merge and falls back to
    /// `Default` when the `[policy]` section is absent.
    #[serde(default, skip_serializing)]
    policy: PolicyConfig,
    #[serde(default)]
    monitoring: RawMonitoringConfig,
    /// Resolved path to the JSON schedule store.  Set from the computed default
    /// in `defaults_with_runtime_root` and overrideable via `BOB_SCHEDULE_STORE_PATH`.
    schedule_store_path: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct RawMonitoringConfig {
    #[serde(default)]
    audit_log_path: Option<PathBuf>,
    #[serde(default)]
    default_tail_filters: Option<Vec<AuditFilterKind>>,
}

fn parse_cli_overrides<I>(args: I) -> ServiceResult<BTreeMap<String, String>>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let mut overrides = BTreeMap::new();

    for arg in args {
        let value = arg.as_ref();
        if !value.starts_with("--config-") {
            continue;
        }

        let Some((raw_key, raw_value)) = value[9..].split_once('=') else {
            return Err(configuration_error(format!(
                "invalid cli override '{value}'; expected --config-key=value"
            )));
        };

        if raw_key.is_empty() {
            return Err(configuration_error(format!(
                "invalid cli override '{value}'; key is empty"
            )));
        }

        let key = raw_key.replace('-', "_");
        overrides.insert(key, raw_value.to_string());
    }

    Ok(overrides)
}

fn to_configuration_error(error: figment::Error) -> ServiceError {
    configuration_error(error.to_string())
}

fn configuration_error(detail: impl AsRef<str>) -> ServiceError {
    ServiceError::Configuration {
        detail: format!("Configuration: {}", detail.as_ref()),
    }
}

fn env_overrides(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter_map(|(key, value)| {
            key.strip_prefix("BOB_")
                .map(|raw| (raw.to_ascii_lowercase(), value.clone()))
        })
        .collect()
}

fn merge_key_value_overrides(mut figment: Figment, overrides: BTreeMap<String, String>) -> Figment {
    for (key, value) in overrides {
        figment = figment.merge((key, value));
    }

    figment
}

fn deserialize_duration<'de, D>(deserializer: D) -> Result<Duration, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum DurationValue {
        Number(u64),
        String(String),
        Structured(Duration),
    }

    match DurationValue::deserialize(deserializer)? {
        DurationValue::Number(seconds) => Ok(Duration::from_secs(seconds)),
        DurationValue::String(value) => parse_duration(&value).map_err(D::Error::custom),
        DurationValue::Structured(duration) => Ok(duration),
    }
}

fn deserialize_usize<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum UsizeValue {
        Number(usize),
        String(String),
    }

    match UsizeValue::deserialize(deserializer)? {
        UsizeValue::Number(value) => Ok(value),
        UsizeValue::String(value) => value
            .trim()
            .parse::<usize>()
            .map_err(|err| D::Error::custom(format!("invalid usize '{value}': {err}"))),
    }
}

fn parse_duration(value: &str) -> Result<Duration, String> {
    let value = value.trim();
    if let Some(raw_ms) = value.strip_suffix("ms") {
        return raw_ms
            .parse::<u64>()
            .map(Duration::from_millis)
            .map_err(|err| format!("invalid duration '{value}': {err}"));
    }

    if let Some(raw_secs) = value.strip_suffix('s') {
        return raw_secs
            .parse::<u64>()
            .map(Duration::from_secs)
            .map_err(|err| format!("invalid duration '{value}': {err}"));
    }

    value
        .parse::<u64>()
        .map(Duration::from_secs)
        .map_err(|err| format!("invalid duration '{value}': {err}"))
}

fn deserialize_string_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringVec {
        Many(Vec<String>),
        Csv(String),
    }

    match StringVec::deserialize(deserializer)? {
        StringVec::Many(values) => Ok(values),
        StringVec::Csv(value) => Ok(parse_csv(&value)),
    }
}

fn parse_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn ensure_monitoring_audit_log_path(path: &Path) -> ServiceResult<()> {
    if path.as_os_str().is_empty() {
        return Err(configuration_error(
            "monitoring.audit_log_path must not be empty",
        ));
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            create_monitoring_parent_dirs(parent)?;
        }
    }

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            configuration_error(format!(
                "monitoring.audit_log_path at {} is not appendable ({error})",
                path.display()
            ))
        })?;

    Ok(())
}

fn create_monitoring_parent_dirs(parent: &Path) -> ServiceResult<()> {
    let parent_missing = !parent.exists();
    std::fs::create_dir_all(parent).map_err(|error| {
        configuration_error(format!(
            "failed to create monitoring audit parent directories at {} ({error})",
            parent.display()
        ))
    })?;

    if parent_missing {
        set_owner_only_permissions(parent)?;
    }

    Ok(())
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> ServiceResult<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        configuration_error(format!(
            "failed to set owner-only permissions on {} ({error})",
            path.display()
        ))
    })
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> ServiceResult<()> {
    Ok(())
}

fn resolve_runtime_root(sources: &ConfigSources) -> ServiceResult<PathBuf> {
    if cfg!(target_os = "macos") {
        let tmpdir = sources
            .env
            .get("TMPDIR")
            .cloned()
            .unwrap_or_else(|| env::temp_dir().to_string_lossy().into_owned());

        return Ok(Path::new(&tmpdir).join(format!("bob-{}", sources.uid)));
    }

    let runtime = sources
        .env
        .get("XDG_RUNTIME_DIR")
        .cloned()
        .unwrap_or_else(|| env::temp_dir().to_string_lossy().into_owned());

    Ok(Path::new(&runtime).join("bob"))
}

fn defaults_with_runtime_root(
    runtime_root: PathBuf,
    env: &BTreeMap<String, String>,
    uid: u32,
) -> RawBobConfig {
    let monitoring_audit_log_path = default_monitoring_audit_log_path_for_env(env, uid);
    let extension_path = default_extension_path_for_env(env, uid);
    let schedule_store_path = default_schedule_store_path_for_env(env, uid);

    RawBobConfig {
        admin_sock_path: runtime_root.join("admin.sock"),
        extension_sock_path: runtime_root.join("extension.sock"),
        extension_path,
        request_queue_capacity: 1024,
        request_submit_timeout: Duration::from_secs(5),
        shutdown_drain_deadline: Duration::from_secs(30),
        shutdown_reap_deadline: Duration::from_secs(10),
        pi_agent_command: "pi".to_string(),
        pi_agent_args: vec!["--mode".to_string(), "rpc".to_string()],
        pi_agent_warm_pool_size: 1,
        pi_agent_max_processes: 8,
        pi_agent_idle_reap_timeout: Duration::from_secs(300),
        tracing_level: default_tracing_level().to_string(),
        tracing_format: "pretty".to_string(),
        policy: PolicyConfig::default(),
        monitoring: RawMonitoringConfig {
            audit_log_path: Some(monitoring_audit_log_path),
            default_tail_filters: Some(default_tail_filters()),
        },
        schedule_store_path,
    }
}

/// Default tracing level, chosen by build profile.
///
/// Release builds default to `"warn"` so production output is limited to
/// warnings and errors. Debug builds keep the more verbose `"info"` default.
/// In both cases `RUST_LOG` and the `tracing_level` config key still override
/// this value.
fn default_tracing_level() -> &'static str {
    if cfg!(debug_assertions) {
        "info"
    } else {
        "warn"
    }
}

fn default_tail_filters() -> Vec<AuditFilterKind> {
    vec![
        AuditFilterKind::Events,
        AuditFilterKind::Reports,
        AuditFilterKind::Verdicts,
    ]
}

fn default_monitoring_audit_log_path(sources: &ConfigSources) -> PathBuf {
    default_monitoring_audit_log_path_for_env(&sources.env, sources.uid)
}

fn default_monitoring_audit_log_path_for_env(env: &BTreeMap<String, String>, uid: u32) -> PathBuf {
    let state_root = if cfg!(target_os = "macos") {
        env.get("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env.get("HOME")
                    .map(|home| Path::new(home).join("Library").join("Application Support"))
            })
            .unwrap_or_else(|| std::env::temp_dir().join(format!("bob-state-{uid}")))
    } else {
        env.get("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env.get("HOME")
                    .map(|home| Path::new(home).join(".local").join("state"))
            })
            .unwrap_or_else(|| std::env::temp_dir().join(format!("bob-state-{uid}")))
    };

    state_root.join("bob").join("audit.jsonl")
}

fn default_extension_path_for_env(env: &BTreeMap<String, String>, uid: u32) -> PathBuf {
    let data_root = env
        .get("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                env.get("HOME")
                    .map(|home| Path::new(home).join("Library").join("Application Support"))
                    .unwrap_or_else(|| std::env::temp_dir().join(format!("bob-data-{uid}")))
            } else {
                env.get("HOME")
                    .map(|home| Path::new(home).join(".local").join("share"))
                    .unwrap_or_else(|| std::env::temp_dir().join(format!("bob-data-{uid}")))
            }
        });

    data_root.join("bob").join("extensions").join("bob.ts")
}

/// Resolves the default JSON schedule-store path from the environment.
///
/// On Linux, the path is `$XDG_STATE_HOME/bob/schedules.json`.  When
/// `XDG_STATE_HOME` is absent, the XDG fallback `$HOME/.local/state/bob/schedules.json`
/// is used.  On macOS, follows the same pattern as the audit log: prefers
/// `XDG_STATE_HOME` then `$HOME/Library/Application Support`.  When both
/// variables are absent, falls back to a temp-directory path to remain usable
/// in test environments without a home directory.
fn default_schedule_store_path_for_env(env: &BTreeMap<String, String>, uid: u32) -> PathBuf {
    let state_root = if cfg!(target_os = "macos") {
        env.get("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env.get("HOME")
                    .map(|home| Path::new(home).join("Library").join("Application Support"))
            })
            .unwrap_or_else(|| std::env::temp_dir().join(format!("bob-state-{uid}")))
    } else {
        env.get("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env.get("HOME")
                    .map(|home| Path::new(home).join(".local").join("state"))
            })
            .unwrap_or_else(|| std::env::temp_dir().join(format!("bob-state-{uid}")))
    };

    state_root.join("bob").join("schedules.json")
}

fn default_config_path(sources: &ConfigSources) -> PathBuf {
    if cfg!(target_os = "macos") {
        let home = sources
            .env
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "~".into());
        return Path::new(&home)
            .join("Library")
            .join("Application Support")
            .join("bob")
            .join("config.toml");
    }

    let root = sources
        .env
        .get("XDG_CONFIG_HOME")
        .cloned()
        .or_else(|| {
            sources
                .env
                .get("HOME")
                .map(|home| format!("{home}/.config"))
        })
        .unwrap_or_else(|| ".config".to_string());

    Path::new(&root).join("bob").join("config.toml")
}

#[cfg(target_os = "linux")]
fn current_uid() -> u32 {
    nix::unistd::Uid::current().as_raw()
}

#[cfg(target_os = "macos")]
fn current_uid() -> u32 {
    nix::unistd::Uid::current().as_raw()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn current_uid() -> u32 {
    0
}

pub fn load() -> ServiceResult<BobConfig> {
    BobConfig::load()
}

/// Re-export of the canonical, atomic, mode-preserving schedule writer.
///
/// The implementation lives in [`bob_core::types::schedule`] so that this
/// config layer and the admin-RPC `schedule.*` handlers share a single writer
/// and cannot drift apart.
pub use bob_core::types::schedule::write_schedule_entries;

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{self, Write},
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    use bob_core::types::AuditFilterKind;
    use tracing::subscriber::with_default;
    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

    #[test]
    fn returns_configuration_error_when_admin_sock_path_is_empty() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        // Override admin_sock_path to empty via CLI override.
        let mut cli_overrides = BTreeMap::new();
        cli_overrides.insert("admin_sock_path".to_string(), "".to_string());

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides,
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("admin_sock_path")),
            "expected Configuration error mentioning admin_sock_path, got {result:?}"
        );
    }

    #[test]
    fn returns_configuration_error_when_extension_sock_path_is_empty() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        // Override extension_sock_path to empty via CLI override.
        let mut cli_overrides = BTreeMap::new();
        cli_overrides.insert("extension_sock_path".to_string(), "".to_string());

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides,
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("extension_sock_path")),
            "expected Configuration error mentioning extension_sock_path, got {result:?}"
        );
    }

    #[test]
    fn loads_defaults_with_platform_socket_roots_when_no_sources_present() {
        let runtime_dir = if cfg!(target_os = "macos") {
            ("TMPDIR", "/tmp/bob-tests")
        } else {
            ("XDG_RUNTIME_DIR", "/run/user/4242")
        };

        let mut env = BTreeMap::new();
        env.insert(runtime_dir.0.to_string(), runtime_dir.1.to_string());

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("defaults should load");

        if cfg!(target_os = "macos") {
            assert_eq!(
                config.admin_sock_path,
                PathBuf::from("/tmp/bob-tests")
                    .join("bob-4242")
                    .join("admin.sock")
            );
            assert_eq!(
                config.extension_sock_path,
                PathBuf::from("/tmp/bob-tests")
                    .join("bob-4242")
                    .join("extension.sock")
            );
        } else {
            assert_eq!(
                config.admin_sock_path,
                PathBuf::from("/run/user/4242")
                    .join("bob")
                    .join("admin.sock")
            );
            assert_eq!(
                config.extension_sock_path,
                PathBuf::from("/run/user/4242")
                    .join("bob")
                    .join("extension.sock")
            );
        }
    }

    #[test]
    fn resolves_default_extension_path_from_xdg_data_home_when_not_configured() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let data_home = temp.path().join("xdg-data-home");

        let config = load_with_env_overrides([(
            "XDG_DATA_HOME",
            data_home
                .to_str()
                .expect("temporary data-home path should be valid UTF-8"),
        )])
        .expect("config should load");

        assert_eq!(
            config.extension_path,
            data_home.join("bob").join("extensions").join("bob.ts")
        );
    }

    #[test]
    fn resolves_default_extension_path_from_home_when_xdg_data_home_is_unset() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let home = temp.path().join("home");

        let config = load_with_env_overrides([(
            "HOME",
            home.to_str()
                .expect("temporary home path should be valid UTF-8"),
        )])
        .expect("config should load");

        let expected = if cfg!(target_os = "macos") {
            home.join("Library")
                .join("Application Support")
                .join("bob")
                .join("extensions")
                .join("bob.ts")
        } else {
            home.join(".local")
                .join("share")
                .join("bob")
                .join("extensions")
                .join("bob.ts")
        };

        assert_eq!(config.extension_path, expected);
    }

    #[test]
    fn loads_extension_path_override_from_config_file() {
        let config_file = write_temp_config(r#"extension_path = "/opt/bob/custom-extension.ts""#);

        let config = BobConfig::load_with_sources(ConfigSources {
            env: BTreeMap::new(),
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("extension_path override should load");

        assert_eq!(
            config.extension_path,
            PathBuf::from("/opt/bob/custom-extension.ts")
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    #[test]
    fn test_base_has_pi_agent_rpc_worker_and_positive_pool_limits() {
        let config = BobConfig::test_base();

        assert_eq!(config.pi_agent_command, "pi");
        assert_eq!(
            config.pi_agent_args,
            vec!["--mode".to_string(), "rpc".to_string()]
        );
        assert!(config.pi_agent_warm_pool_size > 0);
        assert!(config.pi_agent_max_processes > 0);
        assert!(config.pi_agent_idle_reap_timeout > Duration::from_secs(0));
    }

    #[test]
    fn loads_pi_agent_supervisor_settings_from_config_file() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
pi_agent_command = "pi-custom"
pi_agent_args = ["--mode", "rpc", "--trace"]
pi_agent_warm_pool_size = 2
pi_agent_max_processes = 6
pi_agent_idle_reap_timeout = "45s"
"#,
        );

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("phase 2 settings should parse");

        assert_eq!(config.pi_agent_command, "pi-custom");
        assert_eq!(
            config.pi_agent_args,
            vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--trace".to_string()
            ]
        );
        assert_eq!(config.pi_agent_warm_pool_size, 2);
        assert_eq!(config.pi_agent_max_processes, 6);
        assert_eq!(config.pi_agent_idle_reap_timeout, Duration::from_secs(45));

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    #[test]
    fn applies_layered_precedence_defaults_then_file_then_env_then_cli() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        env.insert("BOB_REQUEST_QUEUE_CAPACITY".to_string(), "32".to_string());
        env.insert("BOB_TRACING_LEVEL".to_string(), "debug".to_string());

        let config_file = write_temp_config(
            r#"
request_queue_capacity = 16
tracing_level = "warn"
"#,
        );

        let mut cli_overrides = BTreeMap::new();
        cli_overrides.insert("request_queue_capacity".to_string(), "64".to_string());
        cli_overrides.insert("tracing_level".to_string(), "error".to_string());

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides,
            uid: 4242,
        })
        .expect("layered sources should parse");

        assert_eq!(config.request_queue_capacity, 64);
        assert_eq!(config.tracing_level, "error");

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    #[test]
    fn returns_configuration_error_for_non_positive_queue_capacity() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        env.insert("BOB_REQUEST_QUEUE_CAPACITY".to_string(), "0".to_string());

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { .. })),
            "expected configuration error, got {result:?}"
        );
    }

    #[test]
    fn returns_configuration_error_when_pi_agent_warm_pool_size_is_zero() {
        let result = load_with_env_overrides([("BOB_PI_AGENT_WARM_POOL_SIZE", "0")]);

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("pi_agent_warm_pool_size must be positive")),
            "expected configuration error, got {result:?}"
        );
    }

    #[test]
    fn returns_configuration_error_when_pi_agent_max_processes_is_zero() {
        let result = load_with_env_overrides([("BOB_PI_AGENT_MAX_PROCESSES", "0")]);

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("pi_agent_max_processes must be positive")),
            "expected configuration error, got {result:?}"
        );
    }

    #[test]
    fn returns_configuration_error_when_warm_pool_size_exceeds_max_processes() {
        let result = load_with_env_overrides([
            ("BOB_PI_AGENT_WARM_POOL_SIZE", "5"),
            ("BOB_PI_AGENT_MAX_PROCESSES", "4"),
        ]);

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("pi_agent_warm_pool_size cannot exceed pi_agent_max_processes")),
            "expected configuration error, got {result:?}"
        );
    }

    #[test]
    fn loader_tracing_does_not_emit_secret_bearing_values() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        env.insert(
            "BOB_TRACING_LEVEL".to_string(),
            "super-secret-level".to_string(),
        );

        let writer = SharedBuffer::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .without_time()
            .with_writer(writer.clone())
            .finish();

        let load_result = with_default(subscriber, || {
            BobConfig::load_with_sources(ConfigSources {
                env,
                config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
                cli_overrides: BTreeMap::new(),
                uid: 4242,
            })
        });

        load_result.expect("config should load");
        let logs = writer.contents();
        assert!(!logs.contains("super-secret-level"));
    }

    fn write_temp_config(contents: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!("bob-config-{unique}.toml"));
        fs::write(&path, contents).expect("temp config write should succeed");
        path
    }

    fn load_with_env_overrides<const N: usize>(
        overrides: [(&str, &str); N],
    ) -> ServiceResult<BobConfig> {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        for (key, value) in overrides {
            env.insert(key.to_string(), value.to_string());
        }

        BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
    }

    // ── AC-1 (T-053): [policy] section parses into PolicyConfig ──────────────

    #[test]
    fn loads_policy_section_with_admitted_users_and_action_rules_from_config_file() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let user_id = "00000000-0000-0000-0000-000000000001";
        let config_file = write_temp_config(&format!(
            r#"
[policy]
admitted_users = ["{user_id}"]

[[policy.action_rules]]
tool = "bash"
"#
        ));

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("config with [policy] section should parse");

        assert_eq!(config.policy.admitted_users.len(), 1);
        assert_eq!(config.policy.admitted_users[0], user_id);
        assert_eq!(config.policy.action_rules.len(), 1);
        assert_eq!(config.policy.action_rules[0].tool, "bash");

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-2 (T-053): absent [policy] section yields deny-all, not an error ──

    #[test]
    fn loads_config_successfully_when_policy_section_is_absent_yielding_deny_all() {
        let config = load_with_env_overrides([]).expect("config without [policy] should succeed");

        assert!(
            config.policy.admitted_users.is_empty(),
            "absent [policy] must yield empty admitted_users"
        );
        assert!(
            config.policy.action_rules.is_empty(),
            "absent [policy] must yield empty action_rules"
        );
    }

    #[test]
    fn loads_monitoring_section_with_audit_path_and_default_tail_filters() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let temp = tempfile::tempdir().expect("tempdir should be created");
        let audit_log_path = temp.path().join("monitoring").join("audit.jsonl");
        let config_file = write_temp_config(&format!(
            r#"
[monitoring]
audit_log_path = "{}"
default_tail_filters = ["events", "verdicts"]
"#,
            audit_log_path.display()
        ));

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("config with [monitoring] section should parse");

        assert_eq!(config.monitoring.audit_log_path, audit_log_path);
        assert_eq!(
            config.monitoring.default_tail_filters,
            vec![AuditFilterKind::Events, AuditFilterKind::Verdicts]
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    #[test]
    fn resolves_default_monitoring_audit_path_from_xdg_state_home_when_not_configured() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let state_home = temp.path().join("xdg-state-home");
        let home = temp.path().join("home");

        fs::create_dir_all(&state_home).expect("state home should be created");
        fs::create_dir_all(&home).expect("home should be created");

        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        env.insert(
            "XDG_STATE_HOME".to_string(),
            state_home.display().to_string(),
        );
        env.insert("HOME".to_string(), home.display().to_string());

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("config should load");

        assert_eq!(
            config.monitoring.audit_log_path,
            state_home.join("bob").join("audit.jsonl"),
            "default monitoring audit path should be resolved from XDG_STATE_HOME"
        );
    }

    #[test]
    fn resolves_default_monitoring_audit_path_from_home_fallback_when_xdg_state_home_missing() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let home = temp.path().join("home");

        fs::create_dir_all(&home).expect("home should be created");

        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }
        env.insert("HOME".to_string(), home.display().to_string());

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("config should load");

        let expected = if cfg!(target_os = "macos") {
            home.join("Library")
                .join("Application Support")
                .join("bob")
                .join("audit.jsonl")
        } else {
            home.join(".local")
                .join("state")
                .join("bob")
                .join("audit.jsonl")
        };

        assert_eq!(
            config.monitoring.audit_log_path, expected,
            "default monitoring audit path should fall back to HOME when XDG_STATE_HOME is absent"
        );
    }

    #[test]
    fn returns_configuration_error_when_monitoring_audit_path_is_not_appendable() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let temp = tempfile::tempdir().expect("tempdir should be created");
        let config_file = write_temp_config(&format!(
            r#"
[monitoring]
audit_log_path = "{}"
"#,
            temp.path().display()
        ));

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("monitoring.audit_log_path")),
            "expected configuration error for non-appendable monitoring path, got {result:?}"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    #[test]
    fn creates_missing_monitoring_parent_directories_with_owner_only_permissions() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let temp = tempfile::tempdir().expect("tempdir should be created");
        let state_home = temp.path().join("state-home");
        fs::create_dir_all(&state_home).expect("state home should be created");
        env.insert(
            "XDG_STATE_HOME".to_string(),
            state_home.display().to_string(),
        );
        env.insert("HOME".to_string(), temp.path().display().to_string());

        let audit_log_path = state_home.join("bob").join("private").join("audit.jsonl");
        let parent = audit_log_path
            .parent()
            .expect("audit path should have a parent")
            .to_path_buf();
        let config_file = write_temp_config(&format!(
            r#"
[monitoring]
audit_log_path = "{}"
"#,
            audit_log_path.display()
        ));

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("monitoring path with missing parents should be created");

        assert_eq!(config.monitoring.audit_log_path, audit_log_path);
        assert!(
            parent.exists(),
            "parent directories for monitoring audit path must be created"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(&parent)
                .expect("parent metadata should be available")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(
                mode, 0o700,
                "created monitoring parent directory must be owner-only on unix"
            );
        }

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-1 (T-114): schedule_store_path resolved from XDG_STATE_HOME ──────────

    #[test]
    fn resolves_schedule_store_path_from_xdg_state_home_when_env_var_is_set() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let state_home = temp.path().join("xdg-state");

        let config = load_with_env_overrides([(
            "XDG_STATE_HOME",
            state_home
                .to_str()
                .expect("temporary state-home path should be valid UTF-8"),
        )])
        .expect("config should load");

        assert_eq!(
            config.schedule_store_path,
            state_home.join("bob").join("schedules.json"),
            "schedule store path must resolve to XDG_STATE_HOME/bob/schedules.json"
        );
    }

    #[test]
    fn resolves_schedule_store_path_from_home_fallback_when_xdg_state_home_is_absent() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let home = temp.path().join("home");

        let config = load_with_env_overrides([(
            "HOME",
            home.to_str()
                .expect("temporary home path should be valid UTF-8"),
        )])
        .expect("config should load");

        let expected = if cfg!(target_os = "macos") {
            home.join("Library")
                .join("Application Support")
                .join("bob")
                .join("schedules.json")
        } else {
            home.join(".local")
                .join("state")
                .join("bob")
                .join("schedules.json")
        };

        assert_eq!(
            config.schedule_store_path, expected,
            "schedule store path must fall back to HOME/.local/state/bob/schedules.json on Linux"
        );
    }

    // ── AC-2/3/4 (T-114): schedule entries loaded from JSON store at startup ─────

    #[test]
    fn loads_schedule_entries_from_json_store_when_store_exists() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let store_path = temp.path().join("schedules.json");

        // Write two entries to the JSON store before loading config.
        let entries = vec![
            bob_core::types::ScheduleEntry {
                id: "morning-digest".to_owned(),
                cron: "0 9 * * 1-5".to_owned(),
                prompt: "send morning digest".to_owned(),
            },
            bob_core::types::ScheduleEntry {
                id: "weekly-report".to_owned(),
                cron: "0 17 * * 5".to_owned(),
                prompt: "compile weekly report".to_owned(),
            },
        ];
        bob_core::types::schedule::write_schedule_store(&store_path, &entries)
            .expect("write schedule store must succeed");

        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let mut cli_overrides = BTreeMap::new();
        cli_overrides.insert(
            "schedule_store_path".to_string(),
            store_path.to_str().expect("valid path").to_string(),
        );

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides,
            uid: 4242,
        })
        .expect("config should load");

        assert_eq!(
            config.schedule.entries.len(),
            2,
            "both JSON store entries must be loaded"
        );
        assert_eq!(config.schedule.entries[0].id, "morning-digest");
        assert_eq!(config.schedule.entries[1].id, "weekly-report");
    }

    #[test]
    fn starts_with_empty_schedule_entries_when_json_store_is_missing() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let nonexistent_store = temp.path().join("does-not-exist.json");

        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let mut cli_overrides = BTreeMap::new();
        cli_overrides.insert(
            "schedule_store_path".to_string(),
            nonexistent_store.to_str().expect("valid path").to_string(),
        );

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides,
            uid: 4242,
        })
        .expect("config should load when schedule store is missing");

        assert!(
            config.schedule.entries.is_empty(),
            "missing schedule store must yield empty entries"
        );
    }

    #[test]
    fn returns_configuration_error_when_schedule_store_is_malformed() {
        let temp = tempfile::tempdir().expect("tempdir should be created");
        let store_path = temp.path().join("schedules.json");

        // Write malformed JSON to the store.
        fs::write(&store_path, "not valid json at all").expect("write malformed store");

        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let mut cli_overrides = BTreeMap::new();
        cli_overrides.insert(
            "schedule_store_path".to_string(),
            store_path.to_str().expect("valid path").to_string(),
        );

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides,
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { .. })),
            "malformed schedule store must yield a Configuration error, got {result:?}"
        );
    }

    // ── AC-5 (T-114): [[schedule]] in config.toml is silently ignored ────────────

    #[test]
    fn schedule_section_in_config_toml_is_silently_ignored() {
        // A config.toml with [[schedule]] entries must be accepted without error;
        // the entries are not loaded into cfg.schedule (they are silently discarded
        // because the JSON schedule store is now the authoritative source).
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
[[schedule]]
id = "toml-job"
cron = "0 9 * * *"
prompt = "from toml"
"#,
        );

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("config with [[schedule]] in TOML must load without error");

        // The [[schedule]] TOML entries must be silently ignored; the JSON store
        // (which is missing here) is the authoritative source.
        assert!(
            config.schedule.entries.is_empty(),
            "[[schedule]] in TOML must be silently ignored; entries must come from the JSON store"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-3 (T-053): legacy top-level allowed_user_ids field is removed ──────

    #[test]
    fn bob_config_does_not_have_top_level_allowed_user_ids_field() {
        // Structural test: BobConfig::test_base() must not compile if
        // allowed_user_ids still exists as a direct field.
        // We verify this by checking the policy field is present and
        // the admitted_users come from policy, not from a top-level field.
        let cfg = BobConfig::test_base();
        // If `allowed_user_ids` still existed as a field this line would need it;
        // the fact that it compiles without it proves the legacy field is gone.
        let _: &policy_control::PolicyConfig = &cfg.policy;
    }

    // ── AC-1 (T-097): write_schedule_entries persists entries to the TOML file ─

    #[test]
    fn write_schedule_entries_persists_entries_and_can_be_read_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");

        // Write one entry to a new file.
        let entries = vec![ScheduleEntry {
            id: "job-1".to_owned(),
            cron: "0 9 * * *".to_owned(),
            prompt: "Daily digest".to_owned(),
        }];
        write_schedule_entries(&path, &entries).expect("write must succeed");

        assert!(path.exists(), "config file must exist after write");

        // Read back using figment to confirm the round-trip.
        let content = std::fs::read_to_string(&path).expect("read file");
        assert!(content.contains("job-1"), "id must be in file content");
        assert!(
            content.contains("Daily digest"),
            "prompt must be in file content"
        );
    }

    // ── AC-1 (T-097): write_schedule_entries preserves non-schedule config keys ─

    #[test]
    fn write_schedule_entries_preserves_other_config_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");

        // Write a file with an existing config key.
        std::fs::write(&path, "tracing_level = \"debug\"\n\n[[schedule]]\nid = \"old-job\"\ncron = \"* * * * *\"\nprompt = \"old\"\n")
            .expect("write initial config");

        // Replace schedule entries; tracing_level must be preserved.
        let new_entries = vec![ScheduleEntry {
            id: "new-job".to_owned(),
            cron: "0 8 * * *".to_owned(),
            prompt: "New prompt".to_owned(),
        }];
        write_schedule_entries(&path, &new_entries).expect("write must succeed");

        let content = std::fs::read_to_string(&path).expect("read file");
        assert!(
            content.contains("tracing_level"),
            "tracing_level key must be preserved"
        );
        assert!(content.contains("new-job"), "new entry id must be present");
        assert!(!content.contains("old-job"), "old entry must be removed");
    }

    // ── AC-2 (T-097): write_schedule_entries with empty entries removes the section ─

    #[test]
    fn write_schedule_entries_with_empty_entries_removes_schedule_section() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");

        std::fs::write(
            &path,
            "tracing_level = \"info\"\n\n[[schedule]]\nid = \"to-remove\"\ncron = \"* * * * *\"\nprompt = \"p\"\n",
        )
        .expect("write initial config");

        write_schedule_entries(&path, &[]).expect("write must succeed");

        let content = std::fs::read_to_string(&path).expect("read file");
        assert!(
            !content.contains("to-remove"),
            "removed entry must not be in file"
        );
        assert!(
            content.contains("tracing_level"),
            "other keys must be preserved"
        );
    }

    #[derive(Clone, Default)]
    struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

    impl SharedBuffer {
        fn contents(&self) -> String {
            String::from_utf8(self.0.lock().expect("lock").clone()).expect("valid utf8 logs")
        }
    }

    impl<'a> MakeWriter<'a> for SharedBuffer {
        type Writer = SharedBufferWriter;

        fn make_writer(&'a self) -> Self::Writer {
            SharedBufferWriter(self.0.clone())
        }
    }

    struct SharedBufferWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedBufferWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("lock").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
