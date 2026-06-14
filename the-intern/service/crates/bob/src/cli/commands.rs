use std::{future::Future, io::Write, path::Path};

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::types::AuditFilterKind;
use serde::Serialize;
use serde_json::Value;

use crate::{client::AdminClient, config::BobConfig};

mod audit;
mod chat;
mod policy;
mod schedule;
mod sessions;
mod status;

pub fn status(json: bool) -> ServiceResult<()> {
    status::run(json)
}

pub fn sessions_list(json: bool) -> ServiceResult<()> {
    sessions::run_list(json)
}

pub fn sessions_kill(json: bool, id: &str) -> ServiceResult<()> {
    sessions::run_kill(json, id)
}

pub fn audit_tail(json: bool, filters: Vec<AuditFilterKind>) -> ServiceResult<()> {
    audit::run(json, filters)
}

pub fn policy_reload(json: bool) -> ServiceResult<()> {
    policy::run(json)
}

pub fn schedule_add(json: bool, id: &str, cron: &str, prompt: &str) -> ServiceResult<()> {
    schedule::run_add(json, id, cron, prompt)
}

pub fn schedule_remove(json: bool, id: &str) -> ServiceResult<()> {
    schedule::run_remove(json, id)
}

pub fn schedule_list(json: bool) -> ServiceResult<()> {
    schedule::run_list(json)
}

pub fn schedule_reload(json: bool) -> ServiceResult<()> {
    schedule::run_reload(json)
}

pub fn chat(json: bool, session: Option<&str>) -> ServiceResult<()> {
    chat::run(json, session)
}

pub(crate) fn run_async<T>(future: impl Future<Output = ServiceResult<T>>) -> ServiceResult<T> {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        return tokio::task::block_in_place(|| handle.block_on(future));
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| invalid_request_error(format!("failed to build runtime: {e}")))?;
    runtime.block_on(future)
}

pub(crate) fn load_config() -> ServiceResult<BobConfig> {
    crate::config::load()
}

pub(crate) async fn connect_admin(cfg: &BobConfig) -> ServiceResult<AdminClient> {
    AdminClient::connect(cfg)
        .await
        .map_err(|e| map_service_down_to_missing_socket(e, &cfg.admin_sock_path))
}

pub(crate) async fn call_admin<P>(cfg: &BobConfig, method: &str, params: P) -> ServiceResult<Value>
where
    P: Serialize,
{
    let mut client = connect_admin(cfg).await?;
    client.call(method, params).await
}

pub(crate) fn write_json_line(out: &mut impl Write, value: &Value) -> ServiceResult<()> {
    let text = serde_json::to_string(value).map_err(|e| {
        invalid_request_error(format!("failed to serialize command output as json: {e}"))
    })?;
    writeln!(out, "{text}")
        .map_err(|e| invalid_request_error(format!("failed to write command output: {e}")))
}

pub(crate) fn invalid_request_error(detail: impl Into<String>) -> ServiceError {
    ServiceError::InvalidRequest {
        detail: detail.into(),
    }
}

fn map_service_down_to_missing_socket(error: ServiceError, path: &Path) -> ServiceError {
    if matches!(error, ServiceError::ServiceDown) {
        return invalid_request_error(format!("missing admin socket at {}", path.display()));
    }
    error
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use bob_core::error::ServiceError;

    use crate::cli::commands::map_service_down_to_missing_socket;

    #[test]
    fn missing_socket_error_names_path_for_service_down() {
        let error = map_service_down_to_missing_socket(
            ServiceError::ServiceDown,
            &PathBuf::from("/tmp/bob/admin.sock"),
        );

        assert!(matches!(
            error,
            ServiceError::InvalidRequest { ref detail }
                if detail == "missing admin socket at /tmp/bob/admin.sock"
        ));
    }

    #[test]
    fn non_service_down_errors_pass_through() {
        let original = ServiceError::NotImplemented;
        let mapped =
            map_service_down_to_missing_socket(original, &PathBuf::from("/tmp/bob/admin.sock"));
        assert!(matches!(mapped, ServiceError::NotImplemented));
    }
}
