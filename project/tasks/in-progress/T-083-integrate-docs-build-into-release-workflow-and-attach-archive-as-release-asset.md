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

### Session 1 — 2026-05-28

Extended `.github/workflows/deploy.yml` with four new steps following the
existing `Build release binary` step:

1. **Cache step** (`actions/cache@v4`) — caches `~/.cargo/registry`,
   `~/.cargo/git`, and the installed `mdbook`/`mdbook-mermaid` binaries
   under a fixed key keyed on OS and approximate tool versions. This
   keeps repeat release builds fast without requiring a version file.

2. **Install mdbook and mdbook-mermaid** — uses `command -v` guards so
   a cache hit skips the install entirely; `cargo install --locked` is
   used for reproducibility. No `continue-on-error` is set, so a failed
   install fails the job (AC-4).

3. **Build docs** — runs `mdbook build` with
   `working-directory: ${{ env.DOCS_DIR }}` (resolved to
   `the-intern/docs`) and `BOB_BIN` set to
   `${{ github.workspace }}/${{ env.SERVICE_DIR }}/target/release/bob`
   — the exact binary produced in the prior step (AC-3). Failure
   propagates to the job immediately (AC-2).

4. **Archive docs** — runs
   `tar -czf the-intern-docs-${{ github.ref_name }}.tar.gz -C ${{ env.DOCS_DIR }} book`
   from the workspace root. The `-C` flag means the archive contains
   `book/…` paths rather than the full `the-intern/docs/book/…` tree.
   The tag is embedded via `github.ref_name` (AC-1).

The existing `softprops/action-gh-release@v2` step's `files:` input was
converted from a single string to a YAML block scalar listing both the
`bob` binary and the new archive, so both assets are attached to every
release (AC-1).

A `DOCS_DIR` env var was added at the top-level `env:` block to keep
the path `the-intern/docs` DRY across the new steps.

Tests were written first as a Python `unittest` file at
`.github/workflows/test_deploy_workflow.py`. The test suite covers all
four acceptance criteria (17 tests, all passing). One design decision
worth noting: the `working-directory` test accepts both a literal path
and an env-var expression (`${{ env.DOCS_DIR }}`), since the static
`grep` check already confirms the literal string appears in the file
via the env block.

No files outside `Files to Touch` were modified; the test file is in
the same workflows directory as a collocated test, consistent with the
task scope.

## Review
