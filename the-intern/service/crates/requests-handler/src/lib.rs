#![forbid(unsafe_code)]

pub mod handler;
pub mod queue;

pub use handler::{run_preflight, PreflightConfig};
pub use queue::{start_with, Config, Handle};
