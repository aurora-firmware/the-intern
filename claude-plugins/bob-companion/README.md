# bob-companion

A Claude Code plugin that teaches Claude how to work with **bob** — the
Rust admin service and CLI in `the-intern/service`. It does not add new
tools; it packages the knowledge Claude needs to drive `bob` correctly with
the tools it already has (Bash, Read, Grep).

## Skills

| Skill | Triggers on |
|---|---|
| `bob-setup` | Building, installing, or configuring bob; missing `pi` on PATH; the dev helper scripts |
| `bob-cli` | Running any `bob` subcommand (`serve`, `status`, `sessions`, `audit`, `policy`, `schedule`, `chat`) |
| `bob-health-check` | Checking whether bob is up/healthy, reading `service.status`, live-diagnosing with `audit tail` |
| `bob-troubleshooting` | An error from `bob`/`pi`/the extension, or something not behaving as expected |

## Install

From a Claude Code session with access to this repository:

```
/plugin install claude-plugins/bob-companion
```

or add `claude-plugins/bob-companion` as a plugin source per your
Claude Code plugin-marketplace configuration.

## Scope note

This plugin intentionally does **not** duplicate the mdBook user manual at
`the-intern/docs/` (End-User Guide, Operator Guide, Architecture Overview,
Extension Author Guide, CLI Reference). It exists so Claude can act
correctly *without* a human first pointing it at those docs, and it calls
out gaps in them (e.g. `schedule` missing from the generated CLI reference)
rather than re-explaining what they already cover well.
