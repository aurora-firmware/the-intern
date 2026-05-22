use std::io::{self, Write};

use bob_core::error::ServiceResult;
use serde_json::{json, Value};

use crate::config::BobConfig;

use super::{call_admin, invalid_request_error, load_config, run_async, write_json_line};

pub(super) fn run_list(json_output: bool) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_list_with_config(json_output, &cfg, &mut out)
}

pub(super) fn run_kill(json_output: bool, id: &str) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_kill_with_config(json_output, id, &cfg, &mut out)
}

pub(super) fn run_list_with_config(
    json_output: bool,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_list_with_caller(json_output, out, |method, params| {
        run_async(call_admin(cfg, method, params))
    })
}

pub(super) fn run_kill_with_config(
    json_output: bool,
    id: &str,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_kill_with_caller(json_output, id, out, |method, params| {
        run_async(call_admin(cfg, method, params))
    })
}

fn run_list_with_caller(
    json_output: bool,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let response = caller("sessions.list", json!({}))?;

    if json_output {
        return write_json_line(out, &response);
    }

    write_human_sessions(out, &response)
}

fn run_kill_with_caller(
    json_output: bool,
    id: &str,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let response = caller("sessions.kill", json!({ "id": id }))?;

    if json_output {
        return write_json_line(out, &response);
    }

    writeln!(out, "killed: {id}")
        .map_err(|e| invalid_request_error(format!("failed to write sessions output: {e}")))
}

fn write_human_sessions(out: &mut impl Write, response: &Value) -> ServiceResult<()> {
    let sessions = response
        .as_array()
        .ok_or_else(|| invalid_request_error("sessions.list response must be a json array"))?;

    for session in sessions {
        let id = session
            .as_str()
            .ok_or_else(|| invalid_request_error("session id in sessions.list must be a string"))?;
        writeln!(out, "{id}")
            .map_err(|e| invalid_request_error(format!("failed to write sessions output: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{run_kill_with_caller, run_list_with_caller};

    #[test]
    fn sessions_list_calls_sessions_list_method_and_prints_lines() {
        let mut out = Vec::new();
        run_list_with_caller(false, &mut out, |method, params| {
            assert_eq!(method, "sessions.list");
            assert_eq!(params, json!({}));
            Ok(json!(["alpha", "beta"]))
        })
        .expect("list succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "alpha\nbeta\n");
    }

    #[test]
    fn sessions_list_json_output_is_single_json_document() {
        let mut out = Vec::new();
        run_list_with_caller(true, &mut out, |_, _| Ok(json!(["alpha", "beta"])))
            .expect("list succeeds");

        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "[\"alpha\",\"beta\"]\n"
        );
    }

    #[test]
    fn sessions_kill_calls_sessions_kill_with_id_param() {
        let mut out = Vec::new();
        run_kill_with_caller(false, "session-9", &mut out, |method, params| {
            assert_eq!(method, "sessions.kill");
            assert_eq!(params, json!({"id":"session-9"}));
            Ok(json!({"ok": true}))
        })
        .expect("kill succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "killed: session-9\n");
    }
}
