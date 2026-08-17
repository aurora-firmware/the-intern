---
id: B-043
title: pi-extension package.json version is hardcoded and never matches the 
  release tag
severity: low
status: in-progress
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

### Diagnosis 1 — 2026-08-17

Reproduction status: Confirmed. Direct inspection of
`the-intern/pi-extension/package.json` and `.github/workflows/deploy.yml`
on `dev-agent` @ `893e820`.

Evidence captured:
- `grep -n '"version"' the-intern/pi-extension/package.json` → single hit,
  line 2, `"version": "0.1.0",` — the only `"version"` key in the file (no
  dependency entries carry a nested `version` object key; devDependencies
  are bare semver-range strings).
- `sed -n '104,108p' .github/workflows/deploy.yml` (the "Archive bob
  extension" step) → tars `bob.ts README.md package.json
  package-lock.json` straight from the checkout with no version-stamping.
- `the-intern/service/crates/bob/build.rs:5-13` — the existing, working
  precedent: reads `GITHUB_REF_NAME` (a var GitHub Actions sets
  automatically on every run, equal to the tag name on a tag-triggered
  workflow like this one — confirmed via `github.ref_name` already being
  used throughout `deploy.yml`, e.g. line 106
  `the-intern-bob-extension-${{ github.ref_name }}.tar.gz`) and bakes it in
  as `APP_VERSION` at build time, leaving `Cargo.toml`'s own `version =
  "0.1.0"` (`the-intern/service/crates/bob/Cargo.toml:3`) untouched and
  never manually bumped.
- Local test of the planned `sed` patch against a scratch copy of the real
  `package.json`: `sed -i "s/\"version\": \"[^\"]*\"/\"version\":
  \"9.9.9\"/" /tmp/pkg-test.json` → diff shows exactly one line changed
  (`"version": "0.1.0",` → `"version": "9.9.9",`), rest of the file
  byte-identical; `grep -c '"version"'` on the result still reports `1`
  (no accidental double-match or corruption).
- `the-intern/pi-extension/package-lock.json` has three `"version": "0.1.0"`
  occurrences: the root package (lines 3, 9 — both before the first
  `node_modules/...` entry) and, coincidentally, an unrelated transitive
  dependency `xml-naming@0.1.0` at line 3524
  (`grep -n '"version": "0.1.0"' the-intern/pi-extension/package-lock.json`).
  A naive global replace of that literal string would corrupt
  `xml-naming`'s pinned version.

Isolated fault: `.github/workflows/deploy.yml`'s "Archive bob extension"
step (lines 104-108) — it packages `the-intern/pi-extension/package.json`
verbatim from the checkout with no step anywhere in the workflow that
updates its `version` field to the release tag before archiving.

Root cause: Unlike the `bob` binary (`build.rs` reads `GITHUB_REF_NAME` and
bakes it into `APP_VERSION` at build time), no equivalent mechanism exists
for the TypeScript extension's `package.json`. The field was set once at
file creation and nothing in the release pipeline was ever built to keep it
in sync with the tag it ships under.

Planned fix: In `.github/workflows/deploy.yml`'s "Archive bob extension"
step, before the `tar` command, patch
`${{ env.EXTENSIONS_DIR }}/package.json`'s `version` field to `${{
github.ref_name }}` with `sed` (no reliance on `node`/`npm`/`jq`, none of
which are confirmed present in the `rust-dev` container this job runs in):

```bash
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${{ github.ref_name }}\"/" \
  "${{ env.EXTENSIONS_DIR }}/package.json"
```

This mutates the ephemeral CI checkout only — the tracked repo file stays
at `0.1.0`, exactly mirroring how `Cargo.toml`'s `version` field is never
bumped either. `package-lock.json` is explicitly out of scope: the
extension's own README states it is "shipped as source only. No npm
publish, no build artifact, and no `pi install` command is involved" — no
consumer of the release tarball runs `npm ci`/`npm install` against it, so
the lockfile's version fields have no practical effect, and safely patching
them (skipping the unrelated `xml-naming@0.1.0` entry) would add complexity
disproportionate to any real benefit.

Planned verification: Since this only runs inside the tag-triggered release
workflow, verify locally by simulating the same `sed` command against a
scratch copy of the real file with a stand-in tag value, confirming exactly
one line changes and the JSON stays valid:

```bash
cp the-intern/pi-extension/package.json /tmp/b043-verify.json
sed -i 's/"version": "[^"]*"/"version": "9.9.9"/' /tmp/b043-verify.json
diff the-intern/pi-extension/package.json /tmp/b043-verify.json
# expect exactly one line changed: "version": "0.1.0", -> "version": "9.9.9",
grep -c '"version"' /tmp/b043-verify.json
# expect: 1
python3 -c "import json; json.load(open('/tmp/b043-verify.json'))"
# expect: no error (file is still valid JSON)
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-17

Implemented the Diagnosis Log's planned fix on
`bug/B-043-pi-extension-version-tag`, cut from `dev-agent` @ `be66f04`.

Added a `sed` command to `.github/workflows/deploy.yml`'s "Archive bob
extension" step, immediately before the `tar` invocation, that patches
`${{ env.EXTENSIONS_DIR }}/package.json`'s `version` field to `${{
github.ref_name }}`:

```yaml
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${{ github.ref_name }}\"/" \
  "${{ env.EXTENSIONS_DIR }}/package.json"
```

Placed it in the same step rather than a separate one, matching this
workflow's existing style (each `- name:` step already does several
related shell operations, e.g. "Package macOS install bundle").

Considered and rejected also patching `package-lock.json`: its root-package
`version` fields have no practical consumer (the extension is shipped
source-only, no `npm ci`/`install` against the release tarball per its own
README), and a naive fix risks corrupting the unrelated transitive
dependency `xml-naming@0.1.0` pinned at the exact same literal version
string — added complexity for zero real benefit, so left untouched, as
scoped in the Diagnosis Log.

Ran the Diagnosis Log's Planned Verification locally (this only runs for
real inside the tag-triggered release workflow, so local verification
simulates the `sed` command against a scratch copy of the real file):

```
cp the-intern/pi-extension/package.json /tmp/b043-verify.json
sed -i 's/"version": "[^"]*"/"version": "9.9.9"/' /tmp/b043-verify.json
diff the-intern/pi-extension/package.json /tmp/b043-verify.json
# -> exactly one line changed: "version": "0.1.0", -> "version": "9.9.9",
grep -c '"version"' /tmp/b043-verify.json
# -> 1
python3 -c "import json; json.load(open('/tmp/b043-verify.json'))"
# -> no error, still valid JSON
```

All three checks passed as predicted. Also confirmed the edited
`deploy.yml` is still valid YAML: `python3 -c "import yaml;
yaml.safe_load(open('.github/workflows/deploy.yml'))"` → no error.

No automated test exists for this workflow file (no CI harness runs
`deploy.yml` outside of an actual tag push); the bug's own local-simulation
Fix Verification is the full verification available short of cutting a
real tag. Nothing remains outstanding for this bug; ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-17

PASS

Reviewed on `dev-agent` against branch `bug/B-043-pi-extension-version-tag`
(single commit `fcd227f`, "fix(ci): stamp pi-extension package.json version
from the release tag", based on `dev-agent` @ `be66f04`). Used
`git diff dev-agent...bug/B-043-pi-extension-version-tag` (merge-base
form) to avoid a direction artifact from the branch predating this bug
file's Work Log commit on `dev-agent` — confirmed the branch touches only
`.github/workflows/deploy.yml` (+2 lines) and does not modify the bug
lifecycle file.

**Evidence-chain pre-check:** Diagnosis Log ("Diagnosis 1 — 2026-08-17") is
complete — reproduction status (confirmed), evidence captured (grep of the
single `version` occurrence, the "Archive bob extension" step's lack of any
stamping, the `build.rs`/`Cargo.toml` precedent for the `bob` binary, a
local dry run of the exact planned `sed` command, and the
`package-lock.json` `xml-naming@0.1.0` collision that ruled lockfile
patching out of scope), isolated fault (`deploy.yml` lines 104-108), root
cause (no equivalent of `build.rs`'s `GITHUB_REF_NAME` mechanism exists for
the extension), and a concrete planned fix + planned verification are all
present. Chain is sufficient to proceed.

**Stage 1 — Bug criteria:**
- Fix addresses the isolated fault exactly as planned: the `sed` command
  added to the "Archive bob extension" step is character-for-character the
  command recorded in the Diagnosis Log's Planned Fix.
- Fix Verification steps followed and independently re-run here: copied
  `the-intern/pi-extension/package.json`, applied the same `sed` pattern
  with a stand-in tag, diffed against the original (exactly one line
  changed), `grep -c '"version"'` → `1`, and `python3 -c "import json;
  json.load(...)"` → valid JSON. All three match the Work Log's reported
  results.
- No unrelated behavior added: diff is two lines in one file, nothing else
  touched; `package-lock.json` correctly left alone per the Diagnosis Log's
  explicit scope decision.

**Stage 2 — Code quality:**
- Correctness: the `sed` pattern targets `"version": "<anything>"` — spot
  checked against the real `package.json` and confirmed there is exactly
  one such key in the file (no nested `version` fields in `devDependencies`,
  which are bare semver-range strings), so there's no risk of an
  unintended second match.
- Tests: no CI harness exercises `deploy.yml` outside of an actual tag
  push; the bug's own local-simulation verification (re-run above) is the
  practical equivalent and it passed.
- Security: `${{ github.ref_name }}` is interpolated directly into a `run:`
  block, which is a known GitHub Actions injection pattern in general — but
  this file already does the same interpolation in six other places (e.g.
  the `tar`/`zip` filenames, the release `name:` field), and tag creation
  on this repo already requires push access, i.e. the same trust boundary
  every other `github.ref_name` reference in this file relies on. Not a new
  risk introduced by this fix; consistent with existing file convention.
  Noting as non-blocking.
- Readability: single, clearly-labeled command; comment-free but
  self-explanatory in context of the step name.
- Performance: n/a (one `sed` invocation on a small file).

**Bug Fix Addendum:**
- Fix is minimal: two lines, one file, matches Suspected Area exactly.
- No automated regression test — acceptable given no test harness exists
  for this workflow file outside of an actual release run; the recorded
  local-simulation verification fills the equivalent role and was
  independently re-run above.
- No unrelated refactoring or cleanup bundled.
- Diagnosis Log fix contract matches the implementation exactly.

**Minor observation (non-blocking):** a release tag containing a literal
`/` (Git tags permit this) would break this `sed` command, since `/` is
its delimiter — but every other `github.ref_name` interpolation in this
file (filenames, the release `name:` field) has the same latent
assumption, all existing release tags are plain semver, and defending
against it is out of scope for this bug.

Next owner: Integrator, merge `bug/B-043-pi-extension-version-tag` into
`dev-agent`.
