// bob allows unsafe code only in the SCM_RIGHTS fd-passing helper in
// cli/commands/chat.rs (send_fds_via_scm_rights). All other code in this
// crate uses no unsafe code. The workspace lint is "deny", so any unsafe
// block outside the targeted #[allow(unsafe_code)] site still triggers an error.

use async_trait::async_trait;
use bob_core::error::ServiceResult;
use bob_core::types::AuditFilterKind;

pub mod cli;
pub mod client;
pub mod config;
pub mod init_assets;
pub mod init_materializer;
pub mod serve;
pub mod telemetry;

use cli::{AuditCommand, Cli, Command, PolicyCommand, ScheduleCommand, SessionsCommand};
use config::BobConfig;

#[async_trait]
pub trait DispatchRuntime {
    fn init(&self, path: &str, force: bool) -> ServiceResult<()>;
    fn load_config(&self) -> ServiceResult<BobConfig>;
    fn init_telemetry(&self, cfg: &BobConfig) -> ServiceResult<()>;
    async fn run_serve(&self, cfg: BobConfig) -> ServiceResult<()>;
    fn status(&self, json: bool) -> ServiceResult<()>;
    fn sessions_list(&self, json: bool) -> ServiceResult<()>;
    fn sessions_kill(&self, json: bool, id: &str) -> ServiceResult<()>;
    fn audit_tail(&self, json: bool, filters: Vec<AuditFilterKind>) -> ServiceResult<()>;
    fn policy_reload(&self, json: bool) -> ServiceResult<()>;
    fn schedule_add(
        &self,
        json: bool,
        id: &str,
        cron: &str,
        prompt: Option<&str>,
        file: Option<&str>,
        cwd: Option<&str>,
    ) -> ServiceResult<()>;
    fn schedule_remove(&self, json: bool, id: &str) -> ServiceResult<()>;
    fn schedule_list(&self, json: bool) -> ServiceResult<()>;
    fn schedule_reload(&self, json: bool) -> ServiceResult<()>;
    fn chat(&self, json: bool, session: Option<&str>) -> ServiceResult<()>;
}

pub struct ProductionRuntime;

#[async_trait]
impl DispatchRuntime for ProductionRuntime {
    fn init(&self, path: &str, force: bool) -> ServiceResult<()> {
        cli::commands::init(path, force)
    }

    fn load_config(&self) -> ServiceResult<BobConfig> {
        config::load()
    }

    fn init_telemetry(&self, cfg: &BobConfig) -> ServiceResult<()> {
        telemetry::init(cfg)
    }

    async fn run_serve(&self, cfg: BobConfig) -> ServiceResult<()> {
        serve::run(cfg).await
    }

    fn status(&self, json: bool) -> ServiceResult<()> {
        cli::commands::status(json)
    }

    fn sessions_list(&self, json: bool) -> ServiceResult<()> {
        cli::commands::sessions_list(json)
    }

    fn sessions_kill(&self, json: bool, id: &str) -> ServiceResult<()> {
        cli::commands::sessions_kill(json, id)
    }

    fn audit_tail(&self, json: bool, filters: Vec<AuditFilterKind>) -> ServiceResult<()> {
        cli::commands::audit_tail(json, filters)
    }

    fn policy_reload(&self, json: bool) -> ServiceResult<()> {
        cli::commands::policy_reload(json)
    }

    fn schedule_add(
        &self,
        json: bool,
        id: &str,
        cron: &str,
        prompt: Option<&str>,
        file: Option<&str>,
        cwd: Option<&str>,
    ) -> ServiceResult<()> {
        cli::commands::schedule_add(json, id, cron, prompt, file, cwd)
    }

    fn schedule_remove(&self, json: bool, id: &str) -> ServiceResult<()> {
        cli::commands::schedule_remove(json, id)
    }

    fn schedule_list(&self, json: bool) -> ServiceResult<()> {
        cli::commands::schedule_list(json)
    }

    fn schedule_reload(&self, json: bool) -> ServiceResult<()> {
        cli::commands::schedule_reload(json)
    }

    fn chat(&self, json: bool, session: Option<&str>) -> ServiceResult<()> {
        cli::commands::chat(json, session)
    }
}

pub async fn run_cli(cli: Cli) -> ServiceResult<()> {
    run_cli_with_runtime(&ProductionRuntime, cli).await
}

pub async fn run_cli_with_runtime(runtime: &impl DispatchRuntime, cli: Cli) -> ServiceResult<()> {
    let Cli { json, command } = cli;
    if let Command::Init { path, force } = command {
        return runtime.init(&path, force);
    }

    let cfg = runtime.load_config()?;
    runtime.init_telemetry(&cfg)?;

    match command {
        Command::Serve => runtime.run_serve(cfg).await,
        Command::Status => runtime.status(json),
        Command::Sessions { command } => match command {
            SessionsCommand::List => runtime.sessions_list(json),
            SessionsCommand::Kill { id } => runtime.sessions_kill(json, &id),
        },
        Command::Audit { command } => match command {
            AuditCommand::Tail { filters } => runtime.audit_tail(json, filters),
        },
        Command::Policy { command } => match command {
            PolicyCommand::Reload => runtime.policy_reload(json),
        },
        Command::Schedule { command } => match command {
            ScheduleCommand::Add {
                id,
                cron,
                prompt,
                file,
                cwd,
            } => runtime.schedule_add(
                json,
                &id,
                &cron,
                prompt.as_deref(),
                file.as_deref(),
                cwd.as_deref(),
            ),
            ScheduleCommand::Remove { id } => runtime.schedule_remove(json, &id),
            ScheduleCommand::List { json } => runtime.schedule_list(json),
            ScheduleCommand::Reload => runtime.schedule_reload(json),
        },
        Command::Chat { session } => runtime.chat(json, session.as_deref()),
        Command::Init { .. } => unreachable!("init returns before config loading"),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use bob_core::error::{ServiceError, ServiceResult};
    use bob_core::types::AuditFilterKind;

    use crate::{
        cli::{Cli, Command},
        config::BobConfig,
        run_cli_with_runtime, DispatchRuntime,
    };

    #[derive(Clone)]
    struct FakeRuntime {
        calls: Arc<Mutex<Vec<&'static str>>>,
        init_calls: Arc<Mutex<Vec<(String, bool)>>>,
    }

    impl FakeRuntime {
        fn new() -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                init_calls: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    #[async_trait]
    impl DispatchRuntime for FakeRuntime {
        fn init(&self, path: &str, force: bool) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("init");
            self.init_calls
                .lock()
                .expect("lock")
                .push((path.to_string(), force));
            Ok(())
        }

        fn load_config(&self) -> ServiceResult<BobConfig> {
            self.calls.lock().expect("lock").push("load");
            Ok(BobConfig::test_base())
        }

        fn init_telemetry(&self, _cfg: &BobConfig) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("telemetry");
            Ok(())
        }

        async fn run_serve(&self, _cfg: BobConfig) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("serve");
            Ok(())
        }

        fn status(&self, _json: bool) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn sessions_list(&self, _json: bool) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn sessions_kill(&self, _json: bool, _id: &str) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn audit_tail(&self, _json: bool, _filters: Vec<AuditFilterKind>) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn policy_reload(&self, _json: bool) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn schedule_add(
            &self,
            _json: bool,
            _id: &str,
            _cron: &str,
            _prompt: Option<&str>,
            _file: Option<&str>,
            _cwd: Option<&str>,
        ) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn schedule_remove(&self, _json: bool, _id: &str) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn schedule_list(&self, _json: bool) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn schedule_reload(&self, _json: bool) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn chat(&self, _json: bool, _session: Option<&str>) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn serve_dispatch_calls_load_then_telemetry_then_serve() {
        let runtime = FakeRuntime::new();
        let cli = Cli {
            json: false,
            command: Command::Serve,
        };

        run_cli_with_runtime(&runtime, cli)
            .await
            .expect("serve dispatch succeeds");

        assert_eq!(
            runtime.calls.lock().expect("lock").as_slice(),
            ["load", "telemetry", "serve"]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn init_dispatch_bypasses_config_and_telemetry_loading() {
        let runtime = FakeRuntime::new();
        let cli = Cli {
            json: false,
            command: Command::Init {
                path: "./workspace".to_string(),
                force: true,
            },
        };

        run_cli_with_runtime(&runtime, cli)
            .await
            .expect("init dispatch succeeds");

        assert_eq!(runtime.calls.lock().expect("lock").as_slice(), ["init"]);
        assert_eq!(
            runtime.init_calls.lock().expect("lock").as_slice(),
            [("./workspace".to_string(), true)]
        );
    }
}
