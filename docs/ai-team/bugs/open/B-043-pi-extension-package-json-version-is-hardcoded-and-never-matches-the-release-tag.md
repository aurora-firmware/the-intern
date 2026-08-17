---
id: B-043
title: pi-extension package.json version is hardcoded and never matches the 
  release tag
severity: low
status: open
created: '2026-08-17'
---

# pi-extension package.json version is hardcoded and never matches the release tag

## Summary

`the-intern/pi-extension/package.json`'s `"version"` field is hardcoded to
`0.1.0` and nothing in the release pipeline updates it. Every tagged
release's `the-intern-bob-extension-<tag>.tar.gz` artifact (built in
`.github/workflows/deploy.yml`'s "Archive bob extension" step) ships a
`package.json` claiming version `0.1.0` regardless of the actual release
tag, making the artifact's own metadata misleading about which release it
came from. This is GitHub issue #28.

The `bob` Rust binary already solves the identical problem for its own
`Cargo.toml`/`--version` output: `the-intern/service/crates/bob/build.rs`
reads `GITHUB_REF_NAME` at build time and bakes it in as `APP_VERSION`,
falling back to `CARGO_PKG_VERSION` when that env var is absent (i.e.
`Cargo.toml`'s own `version = "0.1.0"` is deliberately never bumped by
hand). `pi-extension/package.json` has no equivalent mechanism.

## Reproduction Status

Status: confirmed

## Evidence

- `the-intern/pi-extension/package.json:2`: `"version": "0.1.0",` — never
  changed since the file was created (`git log -- the-intern/pi-extension/package.json`
  shows no commit ever touching the `version` field).
- `.github/workflows/deploy.yml`'s "Archive bob extension" step
  (lines 104-108) tars `bob.ts README.md package.json package-lock.json`
  directly from the checked-out tree with no version-stamping step, for
  every tag push (`on: push: tags: - '*'`).
- Contrast: `the-intern/service/crates/bob/build.rs:5-13` —
  ```rust
  let version = std::env::var("GITHUB_REF_NAME")
      .ok()
      .filter(|v| !v.is_empty())
      .unwrap_or_else(|| {
          std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "unknown".to_string())
      });
  println!("cargo:rustc-env=APP_VERSION={version}");
  ```
  `the-intern/service/crates/bob/Cargo.toml:3` similarly hardcodes
  `version = "0.1.0"` and is never bumped — the release tag is the sole
  source of truth for the *shipped* version, applied at build time only.
- `the-intern/pi-extension/package-lock.json` has three occurrences of the
  literal string `"version": "0.1.0"`: the root package (lines 3 and 9,
  both before the first `node_modules/...` entry) and, coincidentally, one
  unrelated transitive dependency `xml-naming@0.1.0` (line 3524) — any fix
  that patches the lockfile must not touch that unrelated dependency
  version.

## Reproduction Steps

1. `grep -n '"version"' the-intern/pi-extension/package.json` → `"version": "0.1.0",`.
2. `grep -n "github.ref_name\|GITHUB_REF_NAME" .github/workflows/deploy.yml`
   → matches for `github.ref_name` in the docs/extension/companion/install-bundle
   archive filenames and the GitHub Release name, but no reference to it
   anywhere near the "Archive bob extension" step or `package.json`.
3. Extract any past release's `the-intern-bob-extension-<tag>.tar.gz` and
   inspect `package.json` — its `version` field reads `0.1.0`, not `<tag>`.

## Expected Behavior

The `package.json` inside a tagged release's
`the-intern-bob-extension-<tag>.tar.gz` artifact should report the actual
release tag as its `version`, the same way `bob --version` (built in the
same workflow run) reports the release tag rather than `Cargo.toml`'s
hardcoded `0.1.0`.

## Actual Behavior

Every release artifact's `package.json` unconditionally says
`"version": "0.1.0"`, regardless of the tag the workflow run was triggered
by.

## Environment

- OS / platform: n/a (CI workflow / packaging config)
- Language / runtime version: n/a
- Relevant dependencies: n/a
- Branch / commit: found on `dev-agent` @ `893e820`

## Related

- GitHub issue: `#28`

## Suspected Area

`.github/workflows/deploy.yml`, "Archive bob extension" step (and,
optionally, `the-intern/pi-extension/package.json`/`package-lock.json` if
the fix patches them at build time rather than at packaging time — analysis
of the exact approach is deferred to the Diagnosis Log).

## Fix Verification

```bash
# After the fix, a checkout with GITHUB_REF_NAME simulated must produce a
# package.json in the archived extension whose version matches the tag,
# e.g. (run from the-intern/pi-extension after the fix's patch step,
# simulating a tag):
GITHUB_REF_NAME=9.9.9 <fix's patch command> && grep '"version"' package.json
# expect: "version": "9.9.9",
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
