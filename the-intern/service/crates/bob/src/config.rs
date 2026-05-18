use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use bob_core::{
    error::{ServiceError, ServiceResult},
    types::UserId,
};
use figment::{
    providers::{Format, Serialized, Toml},
    Figment,
};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BobConfig {
    pub admin_sock_path: PathBuf,
    pub extension_sock_path: PathBuf,
    pub admin_allowed_uids: Vec<u32>,
    pub admin_allowed_gid: Option<u32>,
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
    pub allowed_user_ids: Vec<UserId>,
}

impl Default for BobConfig {
    fn default() -> Self {
        Self {
            admin_sock_path: PathBuf::new(),
            extension_sock_path: PathBuf::new(),
            admin_allowed_uids: Vec::new(),
            admin_allowed_gid: None,
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
            allowed_user_ids: Vec::new(),
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
        let defaults = defaults_with_runtime_root(runtime_root, sources.uid);

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

        let cfg = BobConfig {
            admin_sock_path: raw.admin_sock_path,
            extension_sock_path: raw.extension_sock_path,
            admin_allowed_uids: raw.admin_allowed_uids,
            admin_allowed_gid: raw.admin_allowed_gid,
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
            allowed_user_ids: raw.allowed_user_ids,
        };

        cfg.validate()
    }

    fn validate(self) -> ServiceResult<Self> {
        if self.request_queue_capacity == 0 {
            return Err(configuration_error(
                "request_queue_capacity must be positive",
            ));
        }

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
    #[serde(default, deserialize_with = "deserialize_u32_vec")]
    admin_allowed_uids: Vec<u32>,
    #[serde(default, deserialize_with = "deserialize_optional_u32")]
    admin_allowed_gid: Option<u32>,
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
    #[serde(default, deserialize_with = "deserialize_user_id_vec")]
    allowed_user_ids: Vec<UserId>,
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

fn deserialize_optional_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum U32Value {
        Number(u32),
        String(String),
    }

    match Option::<U32Value>::deserialize(deserializer)? {
        None => Ok(None),
        Some(U32Value::Number(value)) => Ok(Some(value)),
        Some(U32Value::String(value)) => value
            .trim()
            .parse::<u32>()
            .map(Some)
            .map_err(|err| D::Error::custom(format!("invalid u32 '{value}': {err}"))),
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

fn deserialize_u32_vec<'de, D>(deserializer: D) -> Result<Vec<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum U32Vec {
        Many(Vec<u32>),
        Csv(String),
    }

    match U32Vec::deserialize(deserializer)? {
        U32Vec::Many(values) => Ok(values),
        U32Vec::Csv(value) => parse_csv(&value)
            .into_iter()
            .map(|item| {
                item.parse::<u32>()
                    .map_err(|err| D::Error::custom(format!("invalid uid '{item}': {err}")))
            })
            .collect(),
    }
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

fn deserialize_user_id_vec<'de, D>(deserializer: D) -> Result<Vec<UserId>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum UserIdVec {
        Many(Vec<UserId>),
        Csv(String),
    }

    match UserIdVec::deserialize(deserializer)? {
        UserIdVec::Many(values) => Ok(values),
        UserIdVec::Csv(value) => parse_csv(&value)
            .into_iter()
            .map(|item| UserId::from_str(&item).map_err(|err| D::Error::custom(err.to_string())))
            .collect(),
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

fn defaults_with_runtime_root(runtime_root: PathBuf, uid: u32) -> RawBobConfig {
    RawBobConfig {
        admin_sock_path: runtime_root.join("admin.sock"),
        extension_sock_path: runtime_root.join("extension.sock"),
        admin_allowed_uids: vec![uid],
        admin_allowed_gid: None,
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
        allowed_user_ids: Vec::new(),
    }
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

    use tracing::subscriber::with_default;
    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

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
    fn default_sets_pi_agent_rpc_worker_and_positive_pool_limits() {
        let config = BobConfig::default();

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
        env.insert(
            "BOB_ADMIN_ALLOWED_UIDS".to_string(),
            "2000,2001".to_string(),
        );

        let config_file = write_temp_config(
            r#"
request_queue_capacity = 16
tracing_level = "warn"
admin_allowed_uids = [1000]
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
        assert_eq!(config.admin_allowed_uids, vec![2000, 2001]);

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
