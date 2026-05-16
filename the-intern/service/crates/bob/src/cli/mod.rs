use clap::{Parser, Subcommand};

pub mod commands;

#[derive(Debug, Parser)]
#[command(name = "bob", version, about = "Bob service CLI")]
pub struct Cli {
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
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
    Tail,
}

#[derive(Debug, Subcommand)]
pub enum PolicyCommand {
    Reload,
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};

    use super::{Cli, Command, SessionsCommand};

    #[test]
    fn help_lists_global_json_flag_and_all_subcommands() {
        let mut cmd = Cli::command();
        let mut output = Vec::new();
        cmd.write_long_help(&mut output).expect("help to render");

        let help = String::from_utf8(output).expect("valid utf8 help");

        assert!(help.contains("--json"), "help text was: {help}");
        for name in ["serve", "status", "sessions", "audit", "policy", "chat"] {
            assert!(help.contains(name), "missing {name} in help text: {help}");
        }
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
}
