use std::io::{self, Write};

use bob_core::error::ServiceResult;
use serde_json::{json, Value};

use crate::config::BobConfig;

use super::{call_admin, invalid_request_error, load_config, run_async, write_json_line};

/// The resolved prompt source for `schedule add`, mapping to exactly one of the
/// mutually exclusive `prompt`/`file` RPC parameters.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum AddSource {
    Prompt(String),
    File(String),
}

/// Resolve the `--prompt`/`--file` CLI arguments into an [`AddSource`].
///
/// `--file` is canonicalised to an absolute path against the caller's working
/// directory (so a relative path resolves against the operator's shell), and the
/// absolute path is what gets stored — the `bob serve` process re-reads it from
/// its own working directory at each fire, where only an absolute path resolves
/// reliably. A missing path, a non-file, or a non-UTF-8 path is an error so the
/// operator finds out at add time rather than silently at fire time. Exactly one
/// of `--prompt`/`--file` must be present (clap also enforces this).
pub(super) fn resolve_add_source(
    prompt: Option<&str>,
    file: Option<&str>,
) -> ServiceResult<AddSource> {
    match (prompt, file) {
        (Some(p), None) => Ok(AddSource::Prompt(p.to_owned())),
        (None, Some(f)) => {
            let abs = std::fs::canonicalize(f).map_err(|e| {
                invalid_request_error(format!("--file {f:?} could not be resolved: {e}"))
            })?;
            if !abs.is_file() {
                return Err(invalid_request_error(format!(
                    "--file {f:?} is not a regular file"
                )));
            }
            let abs = abs.to_str().ok_or_else(|| {
                invalid_request_error(format!("--file {f:?} resolves to a non-UTF-8 path"))
            })?;
            Ok(AddSource::File(abs.to_owned()))
        }
        (Some(_), Some(_)) => Err(invalid_request_error(
            "--prompt and --file are mutually exclusive",
        )),
        (None, None) => Err(invalid_request_error("--prompt or --file is required")),
    }
}

pub(super) fn run_add(
    json_output: bool,
    id: &str,
    cron: &str,
    prompt: Option<&str>,
    file: Option<&str>,
    cwd: Option<&str>,
) -> ServiceResult<()> {
    // Resolve (and canonicalise a --file) before touching the service so a bad
    // path fails fast, before any RPC round-trip.
    let source = resolve_add_source(prompt, file)?;
    let cfg = load_config()?;
    let mut out = io::stdout();
    run_add_with_config(json_output, id, cron, source, cwd, &cfg, &mut out)
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
    source: AddSource,
    cwd: Option<&str>,
    cfg: &BobConfig,
    out: &mut impl Write,
) -> ServiceResult<()> {
    run_add_with_caller(json_output, id, cron, source, cwd, out, |method, params| {
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
    source: AddSource,
    cwd: Option<&str>,
    out: &mut impl Write,
    mut caller: impl FnMut(&str, Value) -> ServiceResult<Value>,
) -> ServiceResult<()> {
    let mut params = match &source {
        AddSource::Prompt(prompt) => json!({ "id": id, "cron": cron, "prompt": prompt }),
        AddSource::File(file) => json!({ "id": id, "cron": cron, "file": file }),
    };
    if let Some(cwd) = cwd {
        params["cwd"] = json!(cwd);
    }
    let response = caller("schedule.add", params)?;

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
        // An entry carries exactly one of `prompt` (literal) or `file` (path).
        let source = if let Some(prompt) = job.get("prompt").and_then(|v| v.as_str()) {
            format!("prompt: {prompt}")
        } else if let Some(file) = job.get("file").and_then(|v| v.as_str()) {
            format!("file: {file}")
        } else {
            return Err(invalid_request_error(
                "job in schedule.list must have a prompt or file",
            ));
        };
        writeln!(out, "{id}  {cron}  {source}")
            .map_err(|e| invalid_request_error(format!("failed to write schedule output: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        resolve_add_source, run_add_with_caller, run_list_with_caller, run_reload_with_caller,
        run_remove_with_caller, AddSource,
    };

    #[test]
    fn schedule_add_calls_schedule_add_method_with_correct_params() {
        let mut out = Vec::new();
        run_add_with_caller(
            false,
            "foo",
            "* * * * *",
            AddSource::Prompt("check mail".to_owned()),
            None,
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
        run_add_with_caller(
            true,
            "foo",
            "* * * * *",
            AddSource::Prompt("check mail".to_owned()),
            None,
            &mut out,
            |_, _| Ok(json!({"ok": true})),
        )
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

    // --- per-entry working directory (--cwd) ---

    #[test]
    fn schedule_add_sends_cwd_param_when_cwd_is_given() {
        let mut out = Vec::new();
        run_add_with_caller(
            false,
            "foo",
            "* * * * *",
            AddSource::Prompt("check mail".to_owned()),
            Some("/srv/workspaces/a"),
            &mut out,
            |method, params| {
                assert_eq!(method, "schedule.add");
                assert_eq!(
                    params,
                    json!({
                        "id": "foo",
                        "cron": "* * * * *",
                        "prompt": "check mail",
                        "cwd": "/srv/workspaces/a",
                    })
                );
                Ok(json!({"ok": true}))
            },
        )
        .expect("add succeeds");
    }

    #[test]
    fn schedule_add_omits_cwd_param_when_cwd_is_not_given() {
        let mut out = Vec::new();
        run_add_with_caller(
            false,
            "foo",
            "* * * * *",
            AddSource::Prompt("check mail".to_owned()),
            None,
            &mut out,
            |_, params| {
                assert!(
                    params.get("cwd").is_none(),
                    "cwd key must be omitted when --cwd is not given: {params}"
                );
                Ok(json!({"ok": true}))
            },
        )
        .expect("add succeeds");
    }

    // --- file-backed prompts (--file) ---

    #[test]
    fn schedule_add_sends_file_param_for_a_file_source() {
        let mut out = Vec::new();
        run_add_with_caller(
            false,
            "foo",
            "0 9 * * *",
            AddSource::File("/abs/prompt.txt".to_owned()),
            None,
            &mut out,
            |method, params| {
                assert_eq!(method, "schedule.add");
                assert_eq!(
                    params,
                    json!({"id": "foo", "cron": "0 9 * * *", "file": "/abs/prompt.txt"})
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
    fn resolve_add_source_returns_prompt_for_prompt_arg() {
        let src = resolve_add_source(Some("check mail"), None).expect("prompt resolves");
        assert_eq!(src, AddSource::Prompt("check mail".to_owned()));
    }

    #[test]
    fn resolve_add_source_canonicalizes_existing_file_to_absolute() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("prompt.txt");
        std::fs::write(&path, "file contents").expect("write");

        let src = resolve_add_source(None, Some(path.to_str().expect("utf8 path")))
            .expect("existing file resolves");
        match src {
            AddSource::File(abs) => {
                assert!(
                    std::path::Path::new(&abs).is_absolute(),
                    "resolved path must be absolute: {abs}"
                );
                assert_eq!(
                    std::fs::read_to_string(&abs).expect("read resolved path"),
                    "file contents"
                );
            }
            other => panic!("expected AddSource::File, got {other:?}"),
        }
    }

    #[test]
    fn resolve_add_source_errors_on_missing_file() {
        let err = resolve_add_source(None, Some("/nonexistent/abs/does-not-exist.txt"))
            .expect_err("missing file must error");
        assert!(
            err.to_string().to_lowercase().contains("file"),
            "message must mention the file: {err}"
        );
    }

    #[test]
    fn resolve_add_source_errors_when_neither_prompt_nor_file() {
        resolve_add_source(None, None).expect_err("neither prompt nor file must error");
    }

    #[test]
    fn resolve_add_source_errors_when_both_prompt_and_file() {
        resolve_add_source(Some("hi"), Some("/abs/p.txt"))
            .expect_err("both prompt and file must error");
    }
}
