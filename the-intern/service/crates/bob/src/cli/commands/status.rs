use std::io::{self, Write};

use bob_core::error::{ServiceError, ServiceResult};
use serde_json::{json, Value};

use crate::config::BobConfig;

use super::{call_admin, load_config, run_async, write_json_line};

pub(super) fn run(json_output: bool) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_with_config(json_output, &cfg, &mut out)
}

pub(super) fn run_with_config(
    json_output: bool,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_with_caller(json_output, out, |method, params| {
        run_async(call_admin(cfg, method, params))
    })
}

fn run_with_caller(
    json_output: bool,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let response = caller("service.status", json!({}))?;

    if json_output {
        return write_json_line(out, &response);
    }

    write_human_status(out, &response)
}

fn write_human_status(out: &mut impl Write, value: &Value) -> ServiceResult<()> {
    let ok = value
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid_status_error("missing boolean field: ok"))?;
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_status_error("missing string field: version"))?;
    let uptime_seconds = value
        .get("uptime_seconds")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_status_error("missing integer field: uptime_seconds"))?;

    writeln!(out, "ok: {ok}")
        .and_then(|_| writeln!(out, "version: {version}"))
        .and_then(|_| writeln!(out, "uptime_seconds: {uptime_seconds}"))
        .map_err(|e| invalid_status_error(format!("failed to write status output: {e}")))
}

fn invalid_status_error(detail: impl Into<String>) -> ServiceError {
    ServiceError::InvalidRequest {
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::run_with_caller;

    #[test]
    fn status_calls_service_status_and_prints_human_block() {
        let mut out = Vec::new();
        let mut called = false;

        run_with_caller(false, &mut out, |method, params| {
            called = true;
            assert_eq!(method, "service.status");
            assert_eq!(params, json!({}));
            Ok(json!({"ok": true, "version": "0.1.0", "uptime_seconds": 7}))
        })
        .expect("status succeeds");

        assert!(called, "status should perform one rpc call");
        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "ok: true\nversion: 0.1.0\nuptime_seconds: 7\n"
        );
    }

    #[test]
    fn status_json_output_is_single_json_document() {
        let mut out = Vec::new();
        run_with_caller(true, &mut out, |_, _| {
            Ok(json!({"ok": true, "version": "0.1.0", "uptime_seconds": 7}))
        })
        .expect("status succeeds");

        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "{\"ok\":true,\"uptime_seconds\":7,\"version\":\"0.1.0\"}\n"
        );
    }
}
