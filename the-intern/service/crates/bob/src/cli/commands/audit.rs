use bob_core::error::{ServiceError, ServiceResult};

pub(super) fn run(_json: bool) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}
