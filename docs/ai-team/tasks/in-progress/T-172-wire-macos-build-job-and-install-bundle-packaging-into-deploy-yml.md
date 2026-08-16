---
id: T-172
title: Wire macOS build job and install-bundle packaging into deploy.yml
status: pending
priority: high
assigned-role: unassigned
created: '2026-08-15'
---

# Wire macOS build job and install-bundle packaging into deploy.yml

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Implement `docs/ai-team/specs/S-013-cross-platform-bob-install-bundle-release-packaging.md`
Components 1 and 2 (and the Linux side of Component 2) in `.github/workflows/deploy.yml`.

Add a new job (e.g. `build-macos`) with `runs-on: macos-14` that: builds
`cargo build --release -p bob` for macOS arm64; stages that binary alongside
`the-intern/pi-extension/bob.ts`, `the-intern/install-bundle/install.sh`, and
`the-intern/install-bundle/README.txt`; zips them as
`the-intern-bob-install-${{ github.ref_name }}-macos-arm64.zip`; and uploads that zip as a
CI build artifact (`actions/upload-artifact`).

Extend the existing Linux release job — do not touch its docs build, CLI reference
generation, or the three existing archive steps — to additionally: stage the same four
files for Linux and zip them as
`the-intern-bob-install-${{ github.ref_name }}-linux-x86_64.zip`; add a `needs: build-macos`
dependency so the job only proceeds once the macOS job succeeds; download the macOS job's
artifact (`actions/download-artifact`); and add both new zip filenames to the existing
`files:` list already passed to `softprops/action-gh-release@v2`, leaving the four existing
entries untouched. If the macOS job fails, the Linux job's `needs:` dependency means the
release step never runs — no partial release ships.

Pin `actions/upload-artifact`/`actions/download-artifact` to the same major version already
used elsewhere in this repo's workflows (check `build.yml`) — a version mismatch silently
fails to find the artifact. Zip before uploading as a CI artifact, not after downloading:
GitHub's artifact upload does not preserve Unix file-mode bits, so uploading the loose macOS
binary and `install.sh` and zipping them on the Linux runner would ship a bundle whose
executables have lost their execute bit.

`.github/workflows/test_deploy_workflow.py` is a static acceptance-test harness for
`deploy.yml` (from T-083) that locates "the archive step" by matching step names containing
`archive`, `tar`, or `package`, and asserts things about the *first* such match. A new step
placed before "Archive docs" will make it match the wrong step and silently fail an
assertion about docs coverage (this harness is not wired into `build.yml`, so a break here
would otherwise go unnoticed). Extend `test_deploy_workflow.py` alongside the `deploy.yml`
changes so it correctly accounts for the new macOS job and the two new install-bundle
release assets, while keeping its existing docs/archive assertions passing.

## Acceptance Criteria

AC-1: WHEN a tag is pushed THE SYSTEM SHALL build a macOS arm64 `bob` binary in a job
      separate from the existing Linux release job.
AC-2: THE SYSTEM SHALL produce two zip assets named
      `the-intern-bob-install-<tag>-linux-x86_64.zip` and
      `the-intern-bob-install-<tag>-macos-arm64.zip`, each containing that platform's `bob`
      binary, `bob.ts`, `install.sh`, and `README.txt`.
AC-3: THE SYSTEM SHALL attach both new zips to the GitHub Release via the single existing
      `action-gh-release` step, alongside the four existing unchanged assets (bare `bob`
      binary, docs archive, `bob-extension` tarball, `bob-companion` tarball).
AC-4: IF the macOS build job fails THEN THE SYSTEM SHALL fail the release job as a whole
      rather than publish Linux-only assets.
AC-5: THE SYSTEM SHALL continue to build the docs archive, CLI reference, extension archive,
      and `bob-companion` archive exactly once, only in the Linux job.

## Dependencies

- `T-170` — `install.sh` must exist to be staged into both zips
- `T-171` — `README.txt` must exist to be staged into both zips

## Files to Touch

- `.github/workflows/deploy.yml` — add the macOS build job; extend the Linux release job
  with staging, artifact download, and the two new release asset entries
- `.github/workflows/test_deploy_workflow.py` — extend to account for the new macOS job and
  the two new install-bundle release assets, keeping its existing docs/archive assertions
  passing

## Verification

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml')); print('YAML OK')"
grep -n "macos-14\|build-macos\|bob-install" .github/workflows/deploy.yml
python3 .github/workflows/test_deploy_workflow.py

# Local smoke test of the staging/zip shape for one platform (mirrors the CI step):
REPO="$PWD"
STAGE="$(mktemp -d)"
cp "$REPO/the-intern/service/target/debug/bob" "$STAGE/bob"
cp "$REPO/the-intern/pi-extension/bob.ts" "$STAGE/bob.ts"
cp "$REPO/the-intern/install-bundle/install.sh" "$STAGE/install.sh"
cp "$REPO/the-intern/install-bundle/README.txt" "$STAGE/README.txt"
(cd "$STAGE" && zip -r the-intern-bob-install-smoke-linux-x86_64.zip bob bob.ts install.sh README.txt)
unzip -l "$STAGE/the-intern-bob-install-smoke-linux-x86_64.zip"
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-16

Implemented the macOS build/artifact job and Linux/macOS install-bundle release packaging in `deploy.yml`, and expanded the static workflow harness to cover the new job, release gate, artifacts, and assets while retaining docs-archive checks. YAML parsing, grep checks, the static harness (35 passing tests), and a local bundle zip smoke test passed. Implementation commit: `8a04602`. Nothing remains for implementation.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-16
PASS

- Stage 1 passed: AC-1 through AC-5 are satisfied in commit `8a04602`. `.github/workflows/deploy.yml` adds a separate `build-macos` job on `macos-14`, packages both install-bundle zips with the required four files, keeps the existing Linux docs/CLI/archive work in the `release` job exactly once, gates release publication on `needs: build-macos`, and attaches the two new zip assets through the existing `softprops/action-gh-release@v2` step alongside the four unchanged assets.
- Stage 1 scope check passed: only the two task-listed files changed.
- Stage 2 passed: `deploy.yml` parses as valid YAML, `.github/workflows/test_deploy_workflow.py` passes with 35 tests, `actions/upload-artifact` and `actions/download-artifact` match the `@v6` major already used in `.github/workflows/build.yml`, and the workflow zips each install bundle before artifact upload so executable mode bits for `bob` and `install.sh` are preserved in the shipped bundles.
