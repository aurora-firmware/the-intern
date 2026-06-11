use serde::{Deserialize, Serialize};

/// A validated schedule job entry sourced from the `[[schedule]]` TOML section.
///
/// `id` is the unique string identifier for the job, `cron` is a standard
/// 5-field cron expression (minute hour day-of-month month day-of-week), and
/// `prompt` is the non-empty text sent to the agent when the job fires.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleEntry {
    pub id: String,
    pub cron: String,
    pub prompt: String,
}
