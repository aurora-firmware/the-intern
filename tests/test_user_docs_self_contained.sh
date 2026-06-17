#!/usr/bin/env bash
# Regression checks for B-010: shipped user docs must stay self-contained.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$REPO_ROOT/the-intern/docs"
DOCS_SRC="$DOCS_DIR/src"
BUILD_WORKFLOW="$REPO_ROOT/.github/workflows/build.yml"
INTERNAL_PROJECT_DOC_PATTERN='project/(decisions|docs|specs)'

# Fail loudly if a checker tool is missing. Otherwise a non-zero exit from an
# absent `rg` (127) is swallowed by the `if rg ...` / `! rg ...` conditions and
# the affected AC reports PASS without having checked anything.
require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FATAL: required tool '$1' not found on PATH; cannot run regression checks" >&2
    exit 2
  fi
}

require_tool rg
require_tool mdbook
require_tool python3

pass_count=0
fail_count=0

run_test() {
  local name="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "PASS: $name"
    ((pass_count++)) || true
  else
    echo "FAIL: $name"
    ((fail_count++)) || true
  fi
}

resolve_bob_bin() {
  local candidate

  if [ -n "${BOB_BIN:-}" ] && [ -x "${BOB_BIN}" ]; then
    printf '%s\n' "$BOB_BIN"
    return 0
  fi

  for candidate in \
    "$REPO_ROOT/the-intern/service/target/release/bob" \
    "$REPO_ROOT/the-intern/service/target/debug/bob"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

test_ac1_docs_source_has_no_internal_project_doc_links() {
  local ok=0
  if rg -n "$INTERNAL_PROJECT_DOC_PATTERN" "$DOCS_SRC" >/dev/null 2>&1; then
    ok=1
  fi
  run_test "AC-1: docs source has no links into internal project documents" "$ok"
}

test_ac2_rendered_book_has_no_internal_project_doc_links() {
  local ok=0
  local bob_bin
  local tmp_dir

  bob_bin="$(resolve_bob_bin)" || {
    run_test "AC-2: rendered book has no links into internal project documents" "1"
    return
  }

  tmp_dir="$(mktemp -d)"
  if (
    cd "$DOCS_DIR"
    BOB_BIN="$bob_bin" mdbook build --dest-dir "$tmp_dir/book" >/dev/null
  ) && ! rg -n "$INTERNAL_PROJECT_DOC_PATTERN" "$tmp_dir/book" >/dev/null 2>&1; then
    ok=0
  else
    ok=1
  fi
  rm -rf "$tmp_dir"

  run_test "AC-2: rendered book has no links into internal project documents" "$ok"
}

test_ac3_build_workflow_rejects_internal_project_doc_links_before_build() {
  local ok=0

  python3 - "$BUILD_WORKFLOW" <<'PY' >/dev/null 2>&1 || ok=1
import sys
import yaml

workflow_path = sys.argv[1]

with open(workflow_path, "r", encoding="utf-8") as handle:
    workflow = yaml.safe_load(handle)

steps = workflow["jobs"]["user-docs"]["steps"]

build_index = next(
    index for index, step in enumerate(steps) if "mdbook build" in step.get("run", "")
)

guard_index = next(
    index
    for index, step in enumerate(steps[:build_index])
    if "project/(decisions|docs|specs)" in step.get("run", "")
    and ("rg -n" in step.get("run", "") or "grep -RInE" in step.get("run", ""))
)

if guard_index >= build_index:
    raise SystemExit(1)
PY

  run_test "AC-3: build workflow rejects internal project doc links before mdbook build" "$ok"
}

test_ac1_docs_source_has_no_internal_project_doc_links
test_ac2_rendered_book_has_no_internal_project_doc_links
test_ac3_build_workflow_rejects_internal_project_doc_links_before_build

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
