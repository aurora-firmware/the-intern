use std::process::ExitCode;

use clap::Parser;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = bob::cli::Cli::parse_from(filtered_args());
    match bob::run_cli(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

fn filtered_args() -> Vec<String> {
    filter_config_override_args(std::env::args())
}

fn filter_config_override_args<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .filter(|arg| !arg.starts_with("--config-"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::filter_config_override_args;

    #[test]
    fn filtering_removes_config_override_flags_and_keeps_subcommand_args() {
        let filtered = filter_config_override_args(
            [
                "bob".to_string(),
                "--config-request-queue-capacity=9".to_string(),
                "serve".to_string(),
                "--json".to_string(),
            ]
            .into_iter(),
        );

        assert_eq!(
            filtered,
            vec!["bob".to_string(), "serve".to_string(), "--json".to_string()]
        );
    }
}
