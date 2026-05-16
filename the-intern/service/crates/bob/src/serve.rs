use bob_core::error::ServiceResult;

use crate::config::BobConfig;

pub async fn run(_cfg: BobConfig) -> ServiceResult<()> {
    Ok(())
}
