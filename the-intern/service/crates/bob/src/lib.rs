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
pub mod task_board;
pub mod telemetry;
pub mod worklog;

use cli::{
    AuditCommand, Cli, Command, PolicyCommand, ScheduleCommand, SessionsCommand, TaskCommand,
    WorklogCommand,
};
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
    fn task_new(
        &self,
        json: bool,
        board: Option<&str>,
        title: &str,
        status: &str,
        created_date: Option<&str>,
        description: Option<&str>,
        definition_of_done: &[String],
    ) -> ServiceResult<()>;
    fn task_show(
        &self,
        json: bool,
        board: Option<&str>,
        id: &str,
        path_only: bool,
    ) -> ServiceResult<()>;
    fn task_list(&self, json: bool, board: Option<&str>, statuses: &[String]) -> ServiceResult<()>;
    fn task_status(
        &self,
        json: bool,
        board: Option<&str>,
        id: &str,
        status: &str,
        reason: Option<&str>,
    ) -> ServiceResult<()>;
    fn task_note(&self, json: bool, board: Option<&str>, id: &str, text: &str)
        -> ServiceResult<()>;
    fn worklog_append(
        &self,
        json: bool,
        item: &str,
        done: &str,
        left: &str,
        next: &str,
    ) -> ServiceResult<()>;
    fn worklog_list(&self, json: bool, date: Option<&str>) -> ServiceResult<()>;
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

    fn task_new(
        &self,
        json: bool,
        board: Option<&str>,
        title: &str,
        status: &str,
        created_date: Option<&str>,
        description: Option<&str>,
        definition_of_done: &[String],
    ) -> ServiceResult<()> {
        cli::commands::task_new(
            json,
            board,
            title,
            status,
            created_date,
            description,
            definition_of_done,
        )
    }

    fn task_show(
        &self,
        json: bool,
        board: Option<&str>,
        id: &str,
        path_only: bool,
    ) -> ServiceResult<()> {
        cli::commands::task_show(json, board, id, path_only)
    }

    fn task_list(&self, json: bool, board: Option<&str>, statuses: &[String]) -> ServiceResult<()> {
        cli::commands::task_list(json, board, statuses)
    }

    fn task_status(
        &self,
        json: bool,
        board: Option<&str>,
        id: &str,
        status: &str,
        reason: Option<&str>,
    ) -> ServiceResult<()> {
        cli::commands::task_status(json, board, id, status, reason)
    }

    fn task_note(
        &self,
        json: bool,
        board: Option<&str>,
        id: &str,
        text: &str,
    ) -> ServiceResult<()> {
        cli::commands::task_note(json, board, id, text)
    }

    fn worklog_append(
        &self,
        json: bool,
        item: &str,
        done: &str,
        left: &str,
        next: &str,
    ) -> ServiceResult<()> {
        cli::commands::worklog_append(json, item, done, left, next)
    }

    fn worklog_list(&self, json: bool, date: Option<&str>) -> ServiceResult<()> {
        cli::commands::worklog_list(json, date)
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
    if let Command::Task { board, command } = command {
        return match command {
            TaskCommand::New {
                title,
                status,
                created_date,
                description,
                definition_of_done,
            } => runtime.task_new(
                json,
                board.as_deref(),
                &title,
                &status,
                created_date.as_deref(),
                description.as_deref(),
                &definition_of_done,
            ),
            TaskCommand::Show { id, path } => runtime.task_show(json, board.as_deref(), &id, path),
            TaskCommand::List { statuses } => runtime.task_list(json, board.as_deref(), &statuses),
            TaskCommand::Status { id, status, reason } => {
                runtime.task_status(json, board.as_deref(), &id, &status, reason.as_deref())
            }
            TaskCommand::Note { id, text } => runtime.task_note(json, board.as_deref(), &id, &text),
        };
    }
    if let Command::Worklog { command } = command {
        return match command {
            WorklogCommand::Append {
                item,
                done,
                left,
                next,
            } => runtime.worklog_append(json, &item, &done, &left, &next),
            WorklogCommand::List { date } => runtime.worklog_list(json, date.as_deref()),
        };
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
        Command::Init { .. } | Command::Task { .. } | Command::Worklog { .. } => {
            unreachable!("filesystem-only commands return before config loading")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use bob_core::error::{ServiceError, ServiceResult};
    use bob_core::types::AuditFilterKind;

    use crate::{
        cli::{Cli, Command, TaskCommand, WorklogCommand},
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

        fn task_new(
            &self,
            _json: bool,
            _board: Option<&str>,
            _title: &str,
            _status: &str,
            _created_date: Option<&str>,
            _description: Option<&str>,
            _definition_of_done: &[String],
        ) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("task_new");
            Ok(())
        }

        fn task_show(
            &self,
            _json: bool,
            _board: Option<&str>,
            _id: &str,
            _path_only: bool,
        ) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("task_show");
            Ok(())
        }

        fn task_list(
            &self,
            _json: bool,
            _board: Option<&str>,
            _statuses: &[String],
        ) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("task_list");
            Ok(())
        }

        fn task_status(
            &self,
            _json: bool,
            _board: Option<&str>,
            _id: &str,
            _status: &str,
            _reason: Option<&str>,
        ) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("task_status");
            Ok(())
        }

        fn task_note(
            &self,
            _json: bool,
            _board: Option<&str>,
            _id: &str,
            _text: &str,
        ) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("task_note");
            Ok(())
        }

        fn worklog_append(
            &self,
            _json: bool,
            _item: &str,
            _done: &str,
            _left: &str,
            _next: &str,
        ) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("worklog_append");
            Ok(())
        }

        fn worklog_list(&self, _json: bool, _date: Option<&str>) -> ServiceResult<()> {
            self.calls.lock().expect("lock").push("worklog_list");
            Ok(())
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

    #[tokio::test(flavor = "current_thread")]
    async fn worklog_append_dispatch_bypasses_config_and_telemetry_loading() {
        let runtime = FakeRuntime::new();
        let cli = Cli {
            json: false,
            command: Command::Worklog {
                command: WorklogCommand::Append {
                    item: "vendor-invoice".to_string(),
                    done: "Chased the vendor for the missing PDF.".to_string(),
                    left: "awaiting the corrected invoice".to_string(),
                    next: "closes when the corrected invoice arrives".to_string(),
                },
            },
        };

        run_cli_with_runtime(&runtime, cli)
            .await
            .expect("worklog dispatch succeeds");

        assert_eq!(
            runtime.calls.lock().expect("lock").as_slice(),
            ["worklog_append"]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn worklog_list_dispatch_bypasses_config_and_telemetry_loading() {
        let runtime = FakeRuntime::new();
        let cli = Cli {
            json: false,
            command: Command::Worklog {
                command: WorklogCommand::List { date: None },
            },
        };

        run_cli_with_runtime(&runtime, cli)
            .await
            .expect("worklog dispatch succeeds");

        assert_eq!(
            runtime.calls.lock().expect("lock").as_slice(),
            ["worklog_list"]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn worklog_list_with_date_dispatch_bypasses_config_and_telemetry_loading() {
        let runtime = FakeRuntime::new();
        let cli = Cli {
            json: false,
            command: Command::Worklog {
                command: WorklogCommand::List {
                    date: Some("2026-08-29".to_string()),
                },
            },
        };

        run_cli_with_runtime(&runtime, cli)
            .await
            .expect("worklog dispatch succeeds");

        assert_eq!(
            runtime.calls.lock().expect("lock").as_slice(),
            ["worklog_list"]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn task_dispatch_bypasses_config_and_telemetry_loading() {
        let runtime = FakeRuntime::new();
        let cli = Cli {
            json: false,
            command: Command::Task {
                board: Some("./workspace/tasks".to_string()),
                command: TaskCommand::Show {
                    id: "2026-08-24-fix-release-notes".to_string(),
                    path: true,
                },
            },
        };

        run_cli_with_runtime(&runtime, cli)
            .await
            .expect("task dispatch succeeds");

        assert_eq!(
            runtime.calls.lock().expect("lock").as_slice(),
            ["task_show"]
        );
    }
}
