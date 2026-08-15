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

## Verification

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml')); print('YAML OK')"
grep -n "macos-14\|build-macos\|bob-install" .github/workflows/deploy.yml

# Local smoke test of the staging/zip shape for one platform (mirrors the CI step):
mkdir -p /tmp/bob-install-smoke && cd /tmp/bob-install-smoke
cp the-intern/service/target/debug/bob bob
cp the-intern/pi-extension/bob.ts bob.ts
cp the-intern/install-bundle/install.sh install.sh
cp the-intern/install-bundle/README.txt README.txt
zip -r the-intern-bob-install-smoke-linux-x86_64.zip bob bob.ts install.sh README.txt
unzip -l the-intern-bob-install-smoke-linux-x86_64.zip
```

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
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
