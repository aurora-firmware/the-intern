use bob_core::types::AuditFilterKind;
use clap::{Parser, Subcommand};

pub mod commands;

#[derive(Debug, Parser)]
#[command(name = "bob", version = env!("APP_VERSION"), about = "Bob service CLI")]
pub struct Cli {
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Init {
        path: String,
        #[arg(long)]
        force: bool,
    },
    Task {
        #[arg(long)]
        board: Option<String>,
        #[command(subcommand)]
        command: TaskCommand,
    },
    Serve,
    Status,
    Sessions {
        #[command(subcommand)]
        command: SessionsCommand,
    },
    Audit {
        #[command(subcommand)]
        command: AuditCommand,
    },
    Policy {
        #[command(subcommand)]
        command: PolicyCommand,
    },
    Schedule {
        #[command(subcommand)]
        command: ScheduleCommand,
    },
    Chat {
        #[arg(long)]
        session: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum SessionsCommand {
    List,
    Kill { id: String },
}

#[derive(Debug, Subcommand)]
pub enum AuditCommand {
    Tail {
        /// Filter audit notifications by kind. Accepted values: events, reports, verdicts.
        /// May be repeated to include multiple kinds. Omit to receive all kinds.
        #[arg(long = "filter", value_name = "KIND")]
        filters: Vec<AuditFilterKind>,
    },
}

#[derive(Debug, Subcommand)]
pub enum PolicyCommand {
    Reload,
}

#[derive(Debug, Subcommand)]
pub enum ScheduleCommand {
    Add {
        #[arg(long)]
        id: String,
        #[arg(long)]
        cron: String,
        /// Literal prompt text sent when the job fires. Mutually exclusive with
        /// `--file`.
        #[arg(long, conflicts_with = "file", required_unless_present = "file")]
        prompt: Option<String>,
        /// Path to a file whose contents are used as the prompt, read fresh at
        /// each run. Mutually exclusive with `--prompt`.
        #[arg(long)]
        file: Option<String>,
        /// Working directory the job runs in when it fires. Must be an
        /// absolute path; the directory is not required to exist yet, since
        /// existence is checked at fire time rather than at add time.
        #[arg(long)]
        cwd: Option<String>,
    },
    Remove {
        #[arg(long)]
        id: String,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Reload,
}

#[derive(Debug, Subcommand)]
pub enum TaskCommand {
    New {
        title: String,
        #[arg(long, default_value = "todo")]
        status: String,
        #[arg(long = "created")]
        created_date: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long = "done", value_name = "ITEM")]
        definition_of_done: Vec<String>,
    },
    Show {
        id: String,
        #[arg(long)]
        path: bool,
    },
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};

    use super::{AuditCommand, Cli, Command, ScheduleCommand, SessionsCommand, TaskCommand};
    use bob_core::types::AuditFilterKind;

    #[test]
    fn help_lists_global_json_flag_and_all_subcommands() {
        let mut cmd = Cli::command();
        let mut output = Vec::new();
        cmd.write_long_help(&mut output).expect("help to render");

        let help = String::from_utf8(output).expect("valid utf8 help");

        assert!(help.contains("--json"), "help text was: {help}");
        for name in [
            "init", "task", "serve", "status", "sessions", "audit", "policy", "schedule", "chat",
        ] {
            assert!(help.contains(name), "missing {name} in help text: {help}");
        }
    }

    #[test]
    fn parses_init_with_required_path_and_optional_force_flag() {
        let cli = Cli::parse_from(["bob", "init", "./workspace", "--force"]);

        assert!(matches!(
            cli.command,
            Command::Init {
                ref path,
                force: true
            } if path == "./workspace"
        ));
    }

    #[test]
    fn init_requires_a_path_argument() {
        let result = Cli::try_parse_from(["bob", "init"]);

        assert!(
            result.is_err(),
            "clap should reject bob init without a path"
        );
    }

    #[test]
    fn parses_nested_sessions_kill_and_global_json() {
        let cli = Cli::parse_from(["bob", "--json", "sessions", "kill", "session-1"]);

        assert!(cli.json);
        assert!(matches!(
            cli.command,
            Command::Sessions {
                command: SessionsCommand::Kill { ref id }
            } if id == "session-1"
        ));
    }

    #[test]
    fn parses_chat_with_optional_session() {
        let cli = Cli::parse_from(["bob", "chat", "--session", "abc"]);

        assert!(matches!(
            cli.command,
            Command::Chat {
                session: Some(ref session)
            } if session == "abc"
        ));
    }

    #[test]
    fn task_new_parses_board_override_and_optional_fields() {
        let cli = Cli::parse_from([
            "bob",
            "task",
            "--board",
            "./workspace/tasks",
            "new",
            "Fix release notes",
            "--status",
            "doing",
            "--created",
            "2026-08-24",
            "--description",
            "Update the shipping section.",
            "--done",
            "Docs updated",
            "--done",
            "Release notes reviewed",
        ]);

        match cli.command {
            Command::Task {
                board,
                command:
                    TaskCommand::New {
                        title,
                        status,
                        created_date,
                        description,
                        definition_of_done,
                    },
            } => {
                assert_eq!(board.as_deref(), Some("./workspace/tasks"));
                assert_eq!(title, "Fix release notes");
                assert_eq!(status, "doing");
                assert_eq!(created_date.as_deref(), Some("2026-08-24"));
                assert_eq!(description.as_deref(), Some("Update the shipping section."));
                assert_eq!(
                    definition_of_done,
                    vec!["Docs updated", "Release notes reviewed"]
                );
            }
            other => panic!("expected task new, got {other:?}"),
        }
    }

    #[test]
    fn task_show_parses_path_flag() {
        let cli = Cli::parse_from(["bob", "task", "show", "2026-08-24-fix-release", "--path"]);

        assert!(matches!(
            cli.command,
            Command::Task {
                board: None,
                command: TaskCommand::Show {
                    ref id,
                    path: true,
                },
            } if id == "2026-08-24-fix-release"
        ));
    }

    #[test]
    fn schedule_add_parses_optional_cwd_flag() {
        let cli = Cli::parse_from([
            "bob",
            "schedule",
            "add",
            "--id",
            "job-1",
            "--cron",
            "* * * * *",
            "--prompt",
            "hi",
            "--cwd",
            "/abs/workspace",
        ]);

        let cwd = match cli.command {
            Command::Schedule {
                command: ScheduleCommand::Add { cwd, .. },
            } => cwd,
            other => panic!("expected schedule add, got {other:?}"),
        };

        assert_eq!(cwd.as_deref(), Some("/abs/workspace"));
    }

    #[test]
    fn schedule_add_without_cwd_flag_defaults_to_none() {
        let cli = Cli::parse_from([
            "bob",
            "schedule",
            "add",
            "--id",
            "job-1",
            "--cron",
            "* * * * *",
            "--prompt",
            "hi",
        ]);

        let cwd = match cli.command {
            Command::Schedule {
                command: ScheduleCommand::Add { cwd, .. },
            } => cwd,
            other => panic!("expected schedule add, got {other:?}"),
        };

        assert!(cwd.is_none());
    }

    #[test]
    fn audit_tail_without_filter_parses_with_empty_filters() {
        let cli = Cli::parse_from(["bob", "audit", "tail"]);

        assert!(matches!(
            cli.command,
            Command::Audit {
                command: AuditCommand::Tail { ref filters }
            } if filters.is_empty()
        ));
    }

    #[test]
    fn audit_tail_with_multiple_filters_parses_all_values() {
        let cli = Cli::parse_from([
            "bob", "audit", "tail", "--filter", "events", "--filter", "verdicts",
        ]);

        let filters = match cli.command {
            Command::Audit {
                command: AuditCommand::Tail { filters },
            } => filters,
            other => panic!("expected audit tail, got {other:?}"),
        };

        assert_eq!(
            filters,
            vec![AuditFilterKind::Events, AuditFilterKind::Verdicts]
        );
    }

    #[test]
    fn audit_tail_with_misspelled_filter_veredicts_is_rejected_by_clap() {
        let result = Cli::try_parse_from(["bob", "audit", "tail", "--filter", "veredicts"]);
        assert!(
            result.is_err(),
            "clap should reject the misspelled filter 'veredicts'"
        );
    }
}
