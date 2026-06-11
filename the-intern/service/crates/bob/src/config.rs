use std::{
    collections::BTreeMap,
    env,
    fs::OpenOptions,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::types::{AuditFilterKind, ScheduleEntry, UserId};
use croner::parser::{CronParser, Seconds};
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
    /// Channel configuration sourced from the `[channels]` TOML section.
    ///
    /// An absent `[channels]` section yields the default-enabled chat channel.
    pub channels: ChannelsConfig,
    /// Stable application-level identity asserted by `bob chat`.
    pub chat_application_identity: UserId,
    /// Resolved path to the TOML config file used to load this config.
    ///
    /// An empty path means no config file was loaded (defaults only).
    /// Used by the policy-control actor for hot-reload.
    pub config_path: PathBuf,
    /// Schedule configuration sourced from the `[[schedule]]` TOML section.
    ///
    /// An absent or empty section yields an empty entries vec (no jobs).
    pub schedule: ScheduleConfig,
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

/// Top-level channels configuration section from the `[channels]` TOML block.
///
/// Each field is a channel-specific sub-section. Adding a new channel is a
/// field addition here and in `RawChannelsConfig` — no reshape required.
#[derive(Debug, Clone)]
pub struct ChannelsConfig {
    pub chat: ChatChannelConfig,
}

/// Configuration for the interactive-chat channel.
#[derive(Debug, Clone)]
pub struct ChatChannelConfig {
    /// When `true` the chat adapter is started at `bob serve` startup.
    ///
    /// Defaults to `true`: chat is the primary interactive channel and rides
    /// the always-on `admin.sock`.
    pub enabled: bool,
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
            channels: ChannelsConfig {
                chat: ChatChannelConfig { enabled: true },
            },
            chat_application_identity: default_chat_application_identity(),
            config_path: PathBuf::new(),
            schedule: ScheduleConfig {
                entries: Vec::new(),
            },
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

        let schedule = validate_schedule_entries(raw.schedule)?;

        let cfg = BobConfig {
            admin_sock_path: raw.admin_sock_path,
            extension_sock_path: raw.extension_sock_path,
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
            channels: ChannelsConfig {
                chat: ChatChannelConfig {
                    enabled: raw.channels.chat.enabled,
                },
            },
            chat_application_identity: raw.chat_application_identity,
            // Carry the resolved config file path so the policy-control actor
            // can hot-reload from the same file on Handle::reload().
            config_path: config_path.clone(),
            schedule,
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
    #[serde(default)]
    channels: RawChannelsConfig,
    chat_application_identity: UserId,
    /// Raw schedule entries from `[[schedule]]` TOML; absent section → empty vec.
    #[serde(default)]
    schedule: Vec<RawScheduleEntry>,
}

/// Raw deserialization form of a single `[[schedule]]` TOML entry.
///
/// All fields are optional at the serde layer; missing or blank values are
/// caught during validation in `load_with_sources`.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct RawScheduleEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    cron: String,
    #[serde(default)]
    prompt: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct RawMonitoringConfig {
    #[serde(default)]
    audit_log_path: Option<PathBuf>,
    #[serde(default)]
    default_tail_filters: Option<Vec<AuditFilterKind>>,
}

/// Raw deserialization form of the `[channels]` TOML section.
///
/// Each sub-section is optional; absent means use channel-specific defaults.
/// Adding a new channel is a field addition here — no reshape required.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct RawChannelsConfig {
    #[serde(default)]
    chat: RawChatChannelConfig,
}

/// Raw deserialization form of the `[channels.chat]` TOML sub-section.
#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawChatChannelConfig {
    /// Whether the chat adapter is started at `bob serve` startup.
    ///
    /// Defaults to `true` — chat is the primary interactive channel.
    #[serde(default = "default_chat_enabled")]
    enabled: bool,
}

impl Default for RawChatChannelConfig {
    fn default() -> Self {
        Self {
            enabled: default_chat_enabled(),
        }
    }
}

fn default_chat_enabled() -> bool {
    true
}

/// Validates raw schedule entries and converts them to typed `ScheduleEntry` values.
///
/// # Errors
///
/// Returns `ServiceError::Configuration` when any entry has a blank `id`,
/// blank `cron`, blank `prompt`, or an invalid 5-field cron expression.
fn validate_schedule_entries(raw_entries: Vec<RawScheduleEntry>) -> ServiceResult<ScheduleConfig> {
    let cron_parser = CronParser::builder().seconds(Seconds::Disallowed).build();

    let mut entries = Vec::with_capacity(raw_entries.len());

    for (index, raw) in raw_entries.into_iter().enumerate() {
        if raw.id.trim().is_empty() {
            return Err(configuration_error(format!(
                "schedule entry at index {index} has a blank id; id must be non-empty"
            )));
        }

        if raw.cron.trim().is_empty() {
            return Err(configuration_error(format!(
                "schedule entry '{}' has a blank cron; cron must be a non-empty 5-field expression",
                raw.id
            )));
        }

        if raw.prompt.trim().is_empty() {
            return Err(configuration_error(format!(
                "schedule entry '{}' has a blank prompt; prompt must be non-empty",
                raw.id
            )));
        }

        if let Err(err) = cron_parser.parse(&raw.cron) {
            return Err(configuration_error(format!(
                "schedule entry '{}' has an invalid cron expression '{}': {err}",
                raw.id, raw.cron
            )));
        }

        entries.push(ScheduleEntry {
            id: raw.id,
            cron: raw.cron,
            prompt: raw.prompt,
        });
    }

    Ok(ScheduleConfig { entries })
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

    RawBobConfig {
        admin_sock_path: runtime_root.join("admin.sock"),
        extension_sock_path: runtime_root.join("extension.sock"),
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
        monitoring: RawMonitoringConfig {
            audit_log_path: Some(monitoring_audit_log_path),
            default_tail_filters: Some(default_tail_filters()),
        },
        channels: RawChannelsConfig::default(),
        chat_application_identity: default_chat_application_identity(),
        schedule: Vec::new(),
    }
}

fn default_chat_application_identity() -> UserId {
    UserId::from_str("00000000-0000-0000-0000-000000000001")
        .expect("default chat application identity must be a valid UUID")
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
    fn loads_defaults_with_stable_chat_application_identity() {
        let config = load_with_env_overrides([]).expect("defaults should load");
        assert_eq!(
            config.chat_application_identity.to_string(),
            "00000000-0000-0000-0000-000000000001",
            "default chat application identity must be stable"
        );
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
    fn returns_configuration_error_when_chat_application_identity_is_empty() {
        let result = load_with_env_overrides([("BOB_CHAT_APPLICATION_IDENTITY", "")]);

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("chat_application_identity")),
            "expected configuration error, got {result:?}"
        );
    }

    #[test]
    fn returns_configuration_error_when_chat_application_identity_is_not_a_uuid() {
        let result = load_with_env_overrides([("BOB_CHAT_APPLICATION_IDENTITY", "not-a-uuid")]);

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("chat_application_identity")),
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

    // ── AC-1, AC-2 (T-069): channels config section, chat defaults to enabled ──

    #[test]
    fn bob_config_exposes_channels_field_with_chat_channel_config() {
        let config = BobConfig::test_base();
        // The channels field must be present and carry a chat sub-field.
        let _: &ChannelsConfig = &config.channels;
        let _: &ChatChannelConfig = &config.channels.chat;
    }

    #[test]
    fn chat_channel_is_enabled_by_default_when_no_channels_config_is_supplied() {
        let config = load_with_env_overrides([]).expect("config without [channels] should succeed");
        assert!(
            config.channels.chat.enabled,
            "chat channel must be enabled when no [channels] config is present"
        );
    }

    // ── AC-3 (T-069): [channels.chat] enabled = false disables the chat channel ─

    #[test]
    fn chat_channel_is_disabled_when_config_source_sets_enabled_to_false() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
[channels.chat]
enabled = false
"#,
        );

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("config with [channels.chat] enabled = false should parse");

        assert!(
            !config.channels.chat.enabled,
            "chat channel must be disabled when [channels.chat] enabled = false is set"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-4 (T-069): channels section round-trips through the figment loader ───

    #[test]
    fn channels_section_loads_through_figment_layered_source_with_default_then_file_override() {
        // Verify the full figment loading path:
        //   1. Default layer: chat.enabled = true (no file).
        //   2. TOML file layer: chat.enabled = false (file overrides default).
        // This confirms the section is properly wired into the serialized-defaults
        // layer and can be overridden by a TOML config file, matching the same
        // layered-source pattern used by [policy] and [monitoring].
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        // Step 1: defaults only — chat must be enabled.
        let config_defaults = BobConfig::load_with_sources(ConfigSources {
            env: env.clone(),
            config_path: Some(PathBuf::from("/tmp/does-not-exist.toml")),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("defaults-only load should succeed");
        assert!(
            config_defaults.channels.chat.enabled,
            "default layer must produce chat.enabled = true"
        );

        // Step 2: TOML file overrides the default — chat must be disabled.
        let config_file = write_temp_config(
            r#"
[channels.chat]
enabled = false
"#,
        );
        let config_file_override = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("file-overridden load should succeed");
        assert!(
            !config_file_override.channels.chat.enabled,
            "TOML file layer must be able to override chat.enabled to false"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-1 (T-092): valid [[schedule]] entry deserialises into ScheduleEntry ─

    #[test]
    fn loads_valid_schedule_entry_from_config_file() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
[[schedule]]
id = "daily-digest"
cron = "0 9 * * *"
prompt = "Send the daily digest"
"#,
        );

        let config = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        })
        .expect("config with valid [[schedule]] entry should parse");

        assert_eq!(config.schedule.entries.len(), 1);
        assert_eq!(config.schedule.entries[0].id, "daily-digest");
        assert_eq!(config.schedule.entries[0].cron, "0 9 * * *");
        assert_eq!(config.schedule.entries[0].prompt, "Send the daily digest");

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-2 (T-092): invalid cron expression yields Configuration error ───────

    #[test]
    fn returns_configuration_error_when_schedule_entry_has_invalid_cron() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
[[schedule]]
id = "bad-cron"
cron = "not-a-cron"
prompt = "Something"
"#,
        );

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("cron")),
            "expected Configuration error mentioning cron, got {result:?}"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-3 (T-092): blank id/cron/prompt yields Configuration error ─────────

    #[test]
    fn returns_configuration_error_when_schedule_entry_id_is_blank() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
[[schedule]]
id = ""
cron = "0 9 * * *"
prompt = "Something"
"#,
        );

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("id")),
            "expected Configuration error mentioning id, got {result:?}"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    #[test]
    fn returns_configuration_error_when_schedule_entry_cron_is_blank() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
[[schedule]]
id = "job-one"
cron = ""
prompt = "Something"
"#,
        );

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("cron")),
            "expected Configuration error mentioning cron, got {result:?}"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    #[test]
    fn returns_configuration_error_when_schedule_entry_prompt_is_blank() {
        let mut env = BTreeMap::new();
        if cfg!(target_os = "macos") {
            env.insert("TMPDIR".to_string(), "/tmp/bob-tests".to_string());
        } else {
            env.insert("XDG_RUNTIME_DIR".to_string(), "/run/user/4242".to_string());
        }

        let config_file = write_temp_config(
            r#"
[[schedule]]
id = "job-one"
cron = "0 9 * * *"
prompt = ""
"#,
        );

        let result = BobConfig::load_with_sources(ConfigSources {
            env,
            config_path: Some(config_file.clone()),
            cli_overrides: BTreeMap::new(),
            uid: 4242,
        });

        assert!(
            matches!(result, Err(ServiceError::Configuration { ref detail }) if detail.contains("prompt")),
            "expected Configuration error mentioning prompt, got {result:?}"
        );

        fs::remove_file(config_file).expect("temp config file should be removable");
    }

    // ── AC-4 (T-092): absent [schedule] section yields empty entries vec ───────

    #[test]
    fn loads_config_with_empty_schedule_entries_when_schedule_section_is_absent() {
        let config = load_with_env_overrides([]).expect("config without [schedule] should succeed");

        assert!(
            config.schedule.entries.is_empty(),
            "absent [schedule] must yield empty entries vec"
        );
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
