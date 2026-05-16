use std::process::ExitCode;

use clap::Parser;

#[tokio::main]
async fn main() -> ExitCode {
    let _ = bob::cli::Cli::parse();
    ExitCode::SUCCESS
}
