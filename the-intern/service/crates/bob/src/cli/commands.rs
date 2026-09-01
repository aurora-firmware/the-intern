use std::{future::Future, io::Write, path::Path};

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::types::AuditFilterKind;
use serde::Serialize;
use serde_json::Value;

use crate::{client::AdminClient, config::BobConfig};

mod audit;
mod chat;
mod init;
mod policy;
mod schedule;
mod sessions;
mod status;
mod task;
mod worklog;

pub fn init(path: &str, force: bool) -> ServiceResult<()> {
    init::run(path, force)
}

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

pub fn schedule_add(
    json: bool,
    id: &str,
    cron: &str,
    prompt: Option<&str>,
    file: Option<&str>,
    cwd: Option<&str>,
) -> ServiceResult<()> {
    schedule::run_add(json, id, cron, prompt, file, cwd)
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

pub fn task_new(
    json: bool,
    board: Option<&str>,
    title: &str,
    status: &str,
    created_date: Option<&str>,
    description: Option<&str>,
    definition_of_done: &[String],
) -> ServiceResult<()> {
    task::run_new(
        json,
        board,
        title,
        status,
        created_date,
        description,
        definition_of_done,
    )
}

pub fn task_show(json: bool, board: Option<&str>, id: &str, path_only: bool) -> ServiceResult<()> {
    task::run_show(json, board, id, path_only)
}

pub fn task_list(json: bool, board: Option<&str>, statuses: &[String]) -> ServiceResult<()> {
    task::run_list(json, board, statuses)
}

pub fn task_status(
    json: bool,
    board: Option<&str>,
    id: &str,
    status: &str,
    reason: Option<&str>,
) -> ServiceResult<()> {
    task::run_status(json, board, id, status, reason)
}

pub fn task_note(json: bool, board: Option<&str>, id: &str, text: &str) -> ServiceResult<()> {
    task::run_note(json, board, id, text)
}

pub fn worklog_append(
    json: bool,
    item: &str,
    done: &str,
    left: &str,
    next: &str,
) -> ServiceResult<()> {
    worklog::run_append(json, item, done, left, next)
}

pub fn worklog_list(json: bool, date: Option<&str>) -> ServiceResult<()> {
    worklog::run_list(json, date)
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
    AdminClient::connect(cfg).await.map_err(|e| {
        map_service_down_to_missing_socket(e, &cfg.admin_sock_path, cfg.admin_sock_is_tmp_fallback)
    })
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

/// `(env var, user-session socket dir)` for the current platform: the
/// environment variable that resolves bob's runtime (socket) directory, and the
/// directory a service started from a user session resolves it to. Used to
/// explain a "missing admin socket" failure that is really the `env::temp_dir()`
/// fallback kicking in because that variable is unset (issue #60).
#[cfg(target_os = "macos")]
const RUNTIME_DIR_HINT: (&str, &str) = ("TMPDIR", "$TMPDIR/bob-<uid>");
#[cfg(not(target_os = "macos"))]
const RUNTIME_DIR_HINT: (&str, &str) = ("XDG_RUNTIME_DIR", "/run/user/<uid>/bob");

fn map_service_down_to_missing_socket(
    error: ServiceError,
    path: &Path,
    admin_sock_is_tmp_fallback: bool,
) -> ServiceError {
    if matches!(error, ServiceError::ServiceDown) {
        let mut detail = format!("missing admin socket at {}", path.display());
        if admin_sock_is_tmp_fallback {
            let (var, session_dir) = RUNTIME_DIR_HINT;
            detail.push_str(&format!(
                " ({var} is unset, so this is a fallback path; a service running \
                 under a user session listens at {session_dir} instead — set \
                 {var} and retry)"
            ));
        }
        return invalid_request_error(detail);
    }
    error
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use bob_core::error::ServiceError;

    use crate::cli::commands::{map_service_down_to_missing_socket, RUNTIME_DIR_HINT};

    #[test]
    fn missing_socket_error_names_path_for_service_down() {
        let error = map_service_down_to_missing_socket(
            ServiceError::ServiceDown,
            &PathBuf::from("/tmp/bob/admin.sock"),
            false,
        );

        assert!(matches!(
            error,
            ServiceError::InvalidRequest { ref detail }
                if detail == "missing admin socket at /tmp/bob/admin.sock"
        ));
    }

    #[test]
    fn missing_socket_error_adds_runtime_dir_hint_for_tmp_fallback() {
        let error = map_service_down_to_missing_socket(
            ServiceError::ServiceDown,
            &PathBuf::from("/tmp/bob/admin.sock"),
            true,
        );

        let ServiceError::InvalidRequest { detail } = error else {
            panic!("expected InvalidRequest, got {error:?}");
        };
        let (var, session_dir) = RUNTIME_DIR_HINT;
        assert!(
            detail.starts_with("missing admin socket at /tmp/bob/admin.sock ("),
            "hint must be appended to the base message: {detail}"
        );
        assert!(detail.contains(var), "hint must name {var}: {detail}");
        assert!(
            detail.contains(session_dir),
            "hint must point at the user-session socket dir: {detail}"
        );
    }

    #[test]
    fn non_service_down_errors_pass_through() {
        let original = ServiceError::NotImplemented;
        let mapped = map_service_down_to_missing_socket(
            original,
            &PathBuf::from("/tmp/bob/admin.sock"),
            true,
        );
        assert!(matches!(mapped, ServiceError::NotImplemented));
    }
}
