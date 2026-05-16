use bob_core::error::ServiceResult;

#[derive(Debug, Clone, Default)]
pub struct BobConfig;

pub fn load() -> ServiceResult<BobConfig> {
    Ok(BobConfig)
}
