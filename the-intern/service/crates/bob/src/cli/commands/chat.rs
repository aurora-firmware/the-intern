use bob_core::error::{ServiceError, ServiceResult};

pub(super) fn run(_json: bool, _session: Option<&str>) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}
