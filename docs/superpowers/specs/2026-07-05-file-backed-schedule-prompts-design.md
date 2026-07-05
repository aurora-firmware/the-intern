# File-backed schedule prompts — design

**Date:** 2026-07-05
**Status:** Implemented (branch `feat/schedule-file-prompt`)
**Scope:** `bob` service — schedule configuration

## Problem

`bob schedule add` only accepts a literal `--prompt` string. Long or
multi-line prompts are awkward on the command line, and changing a scheduled
job's prompt requires re-running the command. Operators want to point a
scheduled job at a file and edit the prompt independently of the schedule.

## Decision

Add a `--file` CLI option, **mutually exclusive** with `--prompt` (exactly one
required). The schedule store (`schedules.json`) grows a second, mutually
exclusive field so an entry carries **either** `prompt` **or** `file`:

```json
{ "id": "...", "cron": "...", "prompt": "literal text" }
{ "id": "...", "cron": "...", "file": "/abs/path.txt" }
```

The file's contents are read **fresh at each fire** (dynamic), so editing the
file changes what future runs send without touching the schedule.

Decisions taken during brainstorming:

- **Explicit field, not overloaded `--prompt`.** A distinct `--file`/`file`
  removes any literal-vs-path ambiguity and makes a missing file at fire time an
  unambiguous skip rather than a silent literal fallback.
- **Dynamic re-read** (not a snapshot captured at add time), per the operator's
  intent to edit the file between runs.
- **No ownership/permission check on the prompt file** — a deliberate,
  documented relaxation of the ADR-012 trust boundary (see Security).
- **Absolute paths only.** The CLI canonicalises `--file` against the operator's
  shell cwd and stores the absolute path; `bob serve` re-reads it from its own
  cwd at fire time, where only an absolute path resolves reliably. Store
  validation rejects a relative `file`.

## Behaviour

**Add time (CLI, `commands/schedule.rs::resolve_add_source`).** `--file` is
canonicalised to an absolute path; a missing path, a non-file, or a non-UTF-8
path is rejected immediately (fail fast). The absolute path is sent as the
`file` RPC param; `--prompt` is sent as `prompt`.

**Validation (`bob-core::types::schedule::validate_schedule_store`).** Each
entry must set exactly one non-blank prompt source; `file` must be absolute.
Setting both, setting neither, or a relative `file` fails the whole-store load.
Store version stays **1** — existing `prompt`-only stores load unchanged.

**Fire time (`scheduler-adapter::resolve_payload`).** Each entry becomes a
`PromptSource { Text | File(PathBuf) }`. On each fire:

| Source | Result |
|---|---|
| `Text` | literal text sent verbatim |
| `File`, exists, non-blank | file contents sent (read fresh) |
| `File`, missing / unreadable / blank | tick skipped, warning logged |

## Security (ADR-012 relaxation)

Scheduled jobs bypass `[policy].admitted_users` because `schedules.json` is
trusted (owner-only, ADR-012). A `file` prompt is read at fire time with **no**
ownership/permission check, so a file another principal can write is an
injection path into a trusted job. This was an explicit operator decision.
Documented in the fire-time reader's doc comment, the operator guide, and here.
Operators must keep prompt files under the same owner-only protection as the
store.

## Change surface

- `bob-core`: `ScheduleEntry.prompt: String` → `prompt: Option<String>` +
  `file: Option<String>`, `with_prompt`/`with_file` constructors, validation,
  TOML writer.
- `scheduler-adapter`: `PromptSource`, `prompt_source`, `resolve_payload`;
  fire-time resolution and skip-on-missing in `run_job_tick_loop`.
- `admin-rpc`: `schedule.add` accepts `prompt` xor `file`; `schedule.list`
  emits whichever field the entry carries.
- `bob` CLI: `--file` arg (clap mutual exclusion), threading through the
  `DispatchRuntime` trait, `resolve_add_source`, human `list` output.
- Docs: operator-guide schedule section.

## Testing

TDD throughout. Store: file round-trip, exactly-one validation (both/neither),
relative/blank `file` rejected. Scheduler-adapter: `resolve_payload` unit tests
(text, fresh re-read, missing → None, blank → None) plus integration tick tests
(file contents as payload; missing file → no event). admin-rpc: add-with-file
persists `file`, both/neither rejected, list emits `file`. CLI:
`resolve_add_source` (canonicalise, missing → error, both/neither), file param
sent. Full workspace suite: 551 passed.
