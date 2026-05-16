use bob_core::error::{ServiceError, ServiceResult};

pub fn status(_json: bool) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}

pub fn sessions_list(_json: bool) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}

pub fn sessions_kill(_json: bool, _id: &str) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}

pub fn audit_tail(_json: bool) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}

pub fn policy_reload(_json: bool) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}

pub fn chat(_json: bool, _session: Option<&str>) -> ServiceResult<()> {
    Err(ServiceError::NotImplemented)
}
