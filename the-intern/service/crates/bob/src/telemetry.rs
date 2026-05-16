use bob_core::error::ServiceResult;

use crate::config::BobConfig;

pub fn init(_cfg: &BobConfig) -> ServiceResult<()> {
    Ok(())
}
