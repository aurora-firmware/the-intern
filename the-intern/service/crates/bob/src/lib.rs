#![forbid(unsafe_code)]

use async_trait::async_trait;
use bob_core::error::ServiceResult;

pub mod cli;
pub mod client;
pub mod config;
pub mod serve;
pub mod telemetry;

use cli::{AuditCommand, Cli, Command, PolicyCommand, SessionsCommand};
use config::BobConfig;

#[async_trait]
pub trait DispatchRuntime {
    fn load_config(&self) -> ServiceResult<BobConfig>;
    fn init_telemetry(&self, cfg: &BobConfig) -> ServiceResult<()>;
    async fn run_serve(&self, cfg: BobConfig) -> ServiceResult<()>;
    fn status(&self, json: bool) -> ServiceResult<()>;
    fn sessions_list(&self, json: bool) -> ServiceResult<()>;
    fn sessions_kill(&self, json: bool, id: &str) -> ServiceResult<()>;
    fn audit_tail(&self, json: bool) -> ServiceResult<()>;
    fn policy_reload(&self, json: bool) -> ServiceResult<()>;
    fn chat(&self, json: bool, session: Option<&str>) -> ServiceResult<()>;
}

pub struct ProductionRuntime;

#[async_trait]
impl DispatchRuntime for ProductionRuntime {
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

    fn audit_tail(&self, json: bool) -> ServiceResult<()> {
        cli::commands::audit_tail(json)
    }

    fn policy_reload(&self, json: bool) -> ServiceResult<()> {
        cli::commands::policy_reload(json)
    }

    fn chat(&self, json: bool, session: Option<&str>) -> ServiceResult<()> {
        cli::commands::chat(json, session)
    }
}

pub async fn run_cli(cli: Cli) -> ServiceResult<()> {
    run_cli_with_runtime(&ProductionRuntime, cli).await
}

pub async fn run_cli_with_runtime(runtime: &impl DispatchRuntime, cli: Cli) -> ServiceResult<()> {
    let cfg = runtime.load_config()?;
    runtime.init_telemetry(&cfg)?;

    match cli.command {
        Command::Serve => runtime.run_serve(cfg).await,
        Command::Status => runtime.status(cli.json),
        Command::Sessions { command } => match command {
            SessionsCommand::List => runtime.sessions_list(cli.json),
            SessionsCommand::Kill { id } => runtime.sessions_kill(cli.json, &id),
        },
        Command::Audit { command } => match command {
            AuditCommand::Tail => runtime.audit_tail(cli.json),
        },
        Command::Policy { command } => match command {
            PolicyCommand::Reload => runtime.policy_reload(cli.json),
        },
        Command::Chat { session } => runtime.chat(cli.json, session.as_deref()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use bob_core::error::{ServiceError, ServiceResult};

    use crate::{
        cli::{Cli, Command},
        config::BobConfig,
        run_cli_with_runtime, DispatchRuntime,
    };

    #[derive(Clone)]
    struct FakeRuntime {
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl FakeRuntime {
        fn new() -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    #[async_trait]
    impl DispatchRuntime for FakeRuntime {
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

        fn audit_tail(&self, _json: bool) -> ServiceResult<()> {
            Err(ServiceError::NotImplemented)
        }

        fn policy_reload(&self, _json: bool) -> ServiceResult<()> {
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
}
