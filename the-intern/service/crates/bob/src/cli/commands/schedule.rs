use std::io::{self, Write};

use bob_core::error::ServiceResult;
use serde_json::{json, Value};

use crate::config::BobConfig;

use super::{call_admin, invalid_request_error, load_config, run_async, write_json_line};

pub(super) fn run_add(json_output: bool, id: &str, cron: &str, prompt: &str) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_add_with_config(json_output, id, cron, prompt, &cfg, &mut out)
}

pub(super) fn run_remove(json_output: bool, id: &str) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_remove_with_config(json_output, id, &cfg, &mut out)
}

pub(super) fn run_list(json_output: bool) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_list_with_config(json_output, &cfg, &mut out)
}

pub(super) fn run_reload(json_output: bool) -> ServiceResult<()> {
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_reload_with_config(json_output, &cfg, &mut out)
}

pub(super) fn run_add_with_config(
    json_output: bool,
    id: &str,
    cron: &str,
    prompt: &str,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_add_with_caller(json_output, id, cron, prompt, out, |method, params| {
        run_async(call_admin(cfg, method, params))
    })
}

pub(super) fn run_remove_with_config(
    json_output: bool,
    id: &str,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_remove_with_caller(json_output, id, out, |method, params| {
        run_async(call_admin(cfg, method, params))
    })
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

pub(super) fn run_reload_with_config(
    json_output: bool,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_reload_with_caller(json_output, out, |method, params| {
        run_async(call_admin(cfg, method, params))
    })
}

fn run_add_with_caller(
    json_output: bool,
    id: &str,
    cron: &str,
    prompt: &str,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let response = caller(
        "schedule.add",
        json!({ "id": id, "cron": cron, "prompt": prompt }),
    )?;

    if json_output {
        return write_json_line(out, &response);
    }

    writeln!(out, "schedule added: {id}")
        .map_err(|e| invalid_request_error(format!("failed to write schedule output: {e}")))
}

fn run_remove_with_caller(
    json_output: bool,
    id: &str,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let response = caller("schedule.remove", json!({ "id": id }))?;

    if json_output {
        return write_json_line(out, &response);
    }

    writeln!(out, "schedule removed: {id}")
        .map_err(|e| invalid_request_error(format!("failed to write schedule output: {e}")))
}

fn run_list_with_caller(
    json_output: bool,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let response = caller("schedule.list", json!({}))?;

    if json_output {
        return write_json_line(out, &response);
    }

    write_human_schedule(out, &response)
}

fn run_reload_with_caller(
    json_output: bool,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let response = caller("schedule.reload", json!({}))?;

    if json_output {
        return write_json_line(out, &response);
    }

    writeln!(out, "schedule reloaded")
        .map_err(|e| invalid_request_error(format!("failed to write schedule output: {e}")))
}

fn write_human_schedule(out: &mut impl Write, response: &Value) -> ServiceResult<()> {
    let jobs = response
        .as_array()
        .ok_or_else(|| invalid_request_error("schedule.list response must be a json array"))?;

    for job in jobs {
        let id = job
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid_request_error("job id in schedule.list must be a string"))?;
        let cron = job
            .get("cron")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid_request_error("job cron in schedule.list must be a string"))?;
        let prompt = job
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid_request_error("job prompt in schedule.list must be a string"))?;
        writeln!(out, "{id}  {cron}  {prompt}")
            .map_err(|e| invalid_request_error(format!("failed to write schedule output: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        run_add_with_caller, run_list_with_caller, run_reload_with_caller, run_remove_with_caller,
    };

    #[test]
    fn schedule_add_calls_schedule_add_method_with_correct_params() {
        let mut out = Vec::new();
        run_add_with_caller(
            false,
            "foo",
            "* * * * *",
            "check mail",
            &mut out,
            |method, params| {
                assert_eq!(method, "schedule.add");
                assert_eq!(
                    params,
                    json!({"id": "foo", "cron": "* * * * *", "prompt": "check mail"})
                );
                Ok(json!({"ok": true}))
            },
        )
        .expect("add succeeds");

        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "schedule added: foo\n"
        );
    }

    #[test]
    fn schedule_add_json_output_is_single_json_document() {
        let mut out = Vec::new();
        run_add_with_caller(true, "foo", "* * * * *", "check mail", &mut out, |_, _| {
            Ok(json!({"ok": true}))
        })
        .expect("add succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "{\"ok\":true}\n");
    }

    #[test]
    fn schedule_remove_calls_schedule_remove_method_with_id_param() {
        let mut out = Vec::new();
        run_remove_with_caller(false, "foo", &mut out, |method, params| {
            assert_eq!(method, "schedule.remove");
            assert_eq!(params, json!({"id": "foo"}));
            Ok(json!({"ok": true}))
        })
        .expect("remove succeeds");

        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "schedule removed: foo\n"
        );
    }

    #[test]
    fn schedule_remove_json_output_is_single_json_document() {
        let mut out = Vec::new();
        run_remove_with_caller(true, "foo", &mut out, |_, _| Ok(json!({"ok": true})))
            .expect("remove succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "{\"ok\":true}\n");
    }

    #[test]
    fn schedule_list_calls_schedule_list_method_and_prints_human_readable_lines() {
        let mut out = Vec::new();
        run_list_with_caller(false, &mut out, |method, params| {
            assert_eq!(method, "schedule.list");
            assert_eq!(params, json!({}));
            Ok(json!([
                {"id": "job-1", "cron": "0 * * * *", "prompt": "check calendar"},
                {"id": "job-2", "cron": "* * * * *", "prompt": "check mail"}
            ]))
        })
        .expect("list succeeds");

        let output = String::from_utf8(out).expect("utf8");
        assert!(output.contains("job-1"), "output was: {output}");
        assert!(output.contains("0 * * * *"), "output was: {output}");
        assert!(output.contains("check calendar"), "output was: {output}");
        assert!(output.contains("job-2"), "output was: {output}");
        assert!(output.contains("* * * * *"), "output was: {output}");
        assert!(output.contains("check mail"), "output was: {output}");
    }

    #[test]
    fn schedule_list_json_output_is_single_json_document() {
        let mut out = Vec::new();
        run_list_with_caller(true, &mut out, |_, _| {
            Ok(json!([{"id": "job-1", "cron": "0 * * * *", "prompt": "check calendar"}]))
        })
        .expect("list succeeds");

        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "[{\"cron\":\"0 * * * *\",\"id\":\"job-1\",\"prompt\":\"check calendar\"}]\n"
        );
    }

    #[test]
    fn schedule_reload_calls_schedule_reload_method() {
        let mut out = Vec::new();
        run_reload_with_caller(false, &mut out, |method, params| {
            assert_eq!(method, "schedule.reload");
            assert_eq!(params, json!({}));
            Ok(json!({"ok": true}))
        })
        .expect("reload succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "schedule reloaded\n");
    }

    #[test]
    fn schedule_reload_json_output_is_single_json_document() {
        let mut out = Vec::new();
        run_reload_with_caller(true, &mut out, |_, _| Ok(json!({"ok": true})))
            .expect("reload succeeds");

        assert_eq!(String::from_utf8(out).expect("utf8"), "{\"ok\":true}\n");
    }
}
