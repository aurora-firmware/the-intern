---
id: CR-003
title: bob loads its pi extension by path from the XDG data directory
status: completed
created: '2026-06-23'
---

# bob loads its pi extension by path from the XDG data directory

> **Completed (2026-06-24):** Implemented by T-100, T-101, T-102, and the
> CR-003 portions of T-108. S-003 and S-007 are amended in place.

## Desired Changes

This is the **extension-delivery** half of the original CR-002, split out so it
can be decided independently of how `bob chat` invokes pi (CR-002). It depends on
the XDG filesystem layout decided in **ADR-009**.

1. **bob supplies its pi extension to pi by path.** When bob launches a pi
   session it passes the bob extension to pi directly via
   `pi --extension <path>`. The operator no longer has to pre-install `bob.ts`
   into pi's own extension search path (`~/.pi/agent/extensions/` or
   `<project>/.pi/extensions/`).

2. **Default installation location.** The default extension path is
   `$XDG_DATA_HOME/bob/extensions/bob.ts` (→ `~/.local/share/bob/extensions/bob.ts`),
   per ADR-009 (`data` is the XDG bucket for read-only app assets). It is
   overridable by the `config.toml` key `extension_path`. Placing `bob.ts` at the
   default path is an installation concern — **not** part of the release step,
   which only packages the artifact (see Potential Impact). In development the dev
   scripts point the resolved extension path (via `extension_path`, or
   `XDG_DATA_HOME`) at the repository `the-intern/extensions/bob.ts`.

3. **Resolution and absence behaviour.** Resolution order: `config.toml`
   `extension_path` override → `$XDG_DATA_HOME/bob/extensions/bob.ts`. If no
   extension file exists at the resolved path, bob does **not** launch pi: it
   fails with a clear error naming the path where the extension was expected to
   be found. Fail-closed is required because the bob extension is the monitoring /
   `tool_call` authorization membrane (S-003); a session must never run silently
   without it.

## Context

Today the design deliberately keeps bob **out** of extension delivery: S-003
states as a design principle and an explicit exclusion that bob does **not** pass
`-e`/`--extension` to pi, and that the operator installs `bob.ts` into pi's
discovery path independently. This change request reverses that for the
single-user local deployment model: bob **owns** the extension location (the XDG
`data` directory) and supplies it to pi via `--extension`.

The change is wanted because the manual install step is a usability burden and
leaves the extension location undefined; ADR-009 now gives a single, predictable
home (`~/.local/share/bob/extensions/bob.ts`).

## Potential Impact

**Affected specs (amended in place — see CR-002 scope decision):**

- **S-003 — JS extension for pi-agent event forwarding.** Directly contradicted.
  The "bob does not pass `-e`" design principle, the "Bob-side discovery of the
  extension" exclusion, the supervisor responsibility, and the
  operator-installs-it Configuration Requirements / install-path guidance all
  need revising to load the extension via `--extension` from the XDG `data`
  default, including the fail-closed missing-extension behaviour. (For the
  **supervised** spawn path the supervisor→extension env contract —
  `BOB_SESSION_ID` and the extension socket path — is unchanged. Wiring that
  contract for CR-002's interactive session is owned by CR-002's process-model
  resolution; this change request does not assume it.)
- **S-002 — bob service shell architecture.** Not affected by this change. Its
  "extension" references describe the `extension.sock` transport and the pi-agent
  supervisor scaffold (warm pool, spawn/reap, prompt routing), not
  extension-file delivery — that is S-003's domain, and the pi command line
  (`--extension`) is a supervisor/S-003 detail.
- **S-007 / user docs.** The end-user guide and the extension `README.md`
  describe the manual install into pi's search path; replace with the XDG `data`
  default and the `--extension` mechanism.

**Affected ADRs:**

- **ADR-009 (depends on).** Provides the XDG layout and the default extension
  path under `data` that this change request consumes.

**Service code (sizes the task set):**

- Neither the `extension_path` config key nor `$XDG_DATA_HOME` resolution exists in
  `config.rs` today. This change adds the `extension_path` field to the config, adds
  `XDG_DATA_HOME` resolution with the XDG-default fallback (mirroring the existing
  `default_config_path` / audit-log resolution), and wires the resolved path into the
  pi spawn as `--extension <path>` — more than just passing a flag.

**At-risk / completed work (needs review):**

- T-038 (`bob.ts` event forwarding) and T-075 (pi-agent compatibility) — the
  extension behaviour is unaffected, but its discovery path changes; review.

**Release / installation:**

- `deploy.yml` is left unchanged: it only **packages** `bob.ts` as a release
  asset (`the-intern-bob-extension-<tag>.tar.gz`), it does not install anything.
  Placing `bob.ts` at the default `~/.local/share/bob/extensions/bob.ts` is
  therefore an operator/installation step today. A dedicated installation script
  may be introduced later if that scope is accepted — out of scope for this
  change request.

**Risks:**

- Reverses an explicit S-003 design principle; needs an S-003 amendment and
  Architect sign-off at Gate 1.

## Possible Spec Amendments

- **S-003** — remove the "bob does not pass `-e`" principle and the bob-side
  discovery exclusion; define bob supplying the extension via `--extension` from
  the XDG `data` default; define the fail-closed missing-extension behaviour.
- **S-007 / user docs** — replace manual-install guidance with the XDG `data`
  default and the `--extension` mechanism.
- Depends on **ADR-009**.
