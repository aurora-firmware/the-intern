---
id: T-083
title: Integrate docs build into release workflow and attach archive as release
  asset
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Integrate docs build into release workflow and attach archive as release asset

## Description

Extend the existing tag-triggered release workflow at
`.github/workflows/deploy.yml` so every release also ships the rendered
user documentation as a downloadable asset.

The workflow today builds `bob` (release profile) and uploads the binary
to a GitHub Release via `softprops/action-gh-release@v2`. This task adds,
in the same job and after the existing `Build release binary` step:

1. Installation of `mdbook` and `mdbook-mermaid` on the self-hosted
   runner (e.g. via `cargo install`, ideally with caching to keep
   release builds fast). Failure to install must fail the job.
2. A docs build step that runs the single-command build from
   `the-intern/docs/` with `BOB_BIN` pointing at the binary produced by
   the prior step, so the CLI reference matches the binary that will
   ship in the same release.
3. An archive step that packages `the-intern/docs/book/` into a single
   archive whose filename includes the tag (e.g.
   `the-intern-docs-<tag>.tar.gz`).
4. An addition of that archive path to the `files:` input of the existing
   `softprops/action-gh-release@v2` step so the release contains both
   the `bob` binary and the docs archive.

The job must fail (no partial release) if any of these steps fails, in
particular if the docs build fails because `bob` is missing or the
preprocessor errors. The exact archive filename is a developer decision
as long as it is one archive per release and includes the tag.

## Acceptance Criteria

AC-1: WHEN a tag is pushed and `.github/workflows/deploy.yml` runs to
completion, THE SYSTEM SHALL create a GitHub Release whose assets include
both the `bob` binary and exactly one docs archive whose filename
contains the tag.

AC-2: IF the docs build fails during the release job, THEN THE SYSTEM
SHALL fail the entire release job and SHALL NOT create a partial release
that omits the docs archive.

AC-3: The system shall produce the CLI reference inside the release docs
archive from the same `bob` binary that the release attaches, by passing
its path via `BOB_BIN` to the docs build.

AC-4: WHERE `mdbook` or `mdbook-mermaid` is not pre-installed on the
runner, THE SYSTEM SHALL install them before the docs build step and
SHALL fail the job if installation fails.

## Dependencies

- `T-077` — the docs project must exist for the workflow to build it.
- `T-082` — the workflow relies on the CLI-reference generator and its
  `BOB_BIN` contract.

## Files to Touch

- `.github/workflows/deploy.yml` — add docs toolchain install, docs build,
  archive, and release-asset upload.

## Verification

```bash
# Static check: workflow references mdbook, the docs path, and BOB_BIN
grep -q "mdbook" .github/workflows/deploy.yml
grep -q "the-intern/docs" .github/workflows/deploy.yml
grep -q "BOB_BIN" .github/workflows/deploy.yml

# End-to-end verification (manual, performed at next tag push):
#   gh release view <tag> --json assets \
#     | jq -r '.assets[].name' | grep -q "the-intern-docs"
```

## Work Log

## Review
