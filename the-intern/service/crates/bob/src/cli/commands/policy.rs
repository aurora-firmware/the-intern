use std::io::{self, Write};

use bob_core::error::ServiceResult;
use serde_json::{json, Value};

use crate::config::BobConfig;

use super::{call_admin, invalid_request_error, load_config, run_async, write_json_line};

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
    let response = caller("policy.reload", json!({}))?;

    if json_output {
        return write_json_line(out, &response);
    }

    writeln!(out, "policy reloaded")
        .map_err(|e| invalid_request_error(format!("failed to write policy output: {e}")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::run_with_caller;

    #[test]
    fn policy_reload_calls_policy_reload_method() {
        let mut out = Vec::new();
        run_with_caller(false, &mut out, |method, params| {
            assert_eq!(method, "policy.reload");
            assert_eq!(params, json!({}));
            Ok(json!({"ok": true}))
        })
        .expect("reload succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "policy reloaded\n");
    }

    #[test]
    fn policy_reload_json_output_is_single_json_document() {
        let mut out = Vec::new();
        run_with_caller(true, &mut out, |_, _| Ok(json!({"ok": true}))).expect("reload succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "{\"ok\":true}\n");
    }
}
