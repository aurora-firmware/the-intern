#!/usr/bin/env bash
# Test suite for coding guidelines documents (T-002)
# Adapted TDD discipline: failing grep = missing section = red; file with section = green.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DOC="$REPO_ROOT/project/docs/coding-guidelines-rust.md"
NODE_DOC="$REPO_ROOT/project/docs/coding-guidelines-node.md"

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

# AC-1: Both files must exist
test_ac1_rust_file_exists() {
  local ok=0
  [ -f "$RUST_DOC" ] || ok=1
  run_test "AC-1: coding-guidelines-rust.md exists" "$ok"
}

test_ac1_node_file_exists() {
  local ok=0
  [ -f "$NODE_DOC" ] || ok=1
  run_test "AC-1: coding-guidelines-node.md exists" "$ok"
}

# AC-2: Each file must cover the six required sections
REQUIRED_SECTIONS=("source layout" "naming" "error handling" "logging" "testing" "formatter")

test_ac2_rust_sections() {
  local ok=0
  for section in "${REQUIRED_SECTIONS[@]}"; do
    grep -qi "$section" "$RUST_DOC" 2>/dev/null || { ok=1; echo "  missing in rust doc: $section"; }
  done
  run_test "AC-2: rust doc covers all six required sections" "$ok"
}

test_ac2_node_sections() {
  local ok=0
  for section in "${REQUIRED_SECTIONS[@]}"; do
    grep -qi "$section" "$NODE_DOC" 2>/dev/null || { ok=1; echo "  missing in node doc: $section"; }
  done
  run_test "AC-2: node doc covers all six required sections" "$ok"
}

# AC-3: No tool config files must exist in the repo root
test_ac3_no_tool_config_files() {
  local ok=0
  # The task verification uses ls + grep; replicate that logic
  if ls "$REPO_ROOT"/rustfmt.toml \
        "$REPO_ROOT"/clippy.toml \
        "$REPO_ROOT"/.eslintrc* \
        "$REPO_ROOT"/biome.json \
        "$REPO_ROOT"/.prettierrc* \
        "$REPO_ROOT"/.editorconfig 2>/dev/null | grep -q .; then
    ok=1
  fi
  run_test "AC-3: no tool config files exist in repo root" "$ok"
}

# AC-5: No specific test framework names in the guideline docs
FORBIDDEN_FRAMEWORKS=("cargo nextest" "jest" "vitest" "mocha" "jasmine" "ava" "tap ")

test_ac5_rust_no_framework_names() {
  local ok=0
  for fw in "${FORBIDDEN_FRAMEWORKS[@]}"; do
    grep -qi "$fw" "$RUST_DOC" 2>/dev/null && { ok=1; echo "  found forbidden framework in rust doc: $fw"; }
  done
  run_test "AC-5: rust doc names no specific test framework" "$ok"
}

test_ac5_node_no_framework_names() {
  local ok=0
  for fw in "${FORBIDDEN_FRAMEWORKS[@]}"; do
    grep -qi "$fw" "$NODE_DOC" 2>/dev/null && { ok=1; echo "  found forbidden framework in node doc: $fw"; }
  done
  run_test "AC-5: node doc names no specific test framework" "$ok"
}

# Run all tests
test_ac1_rust_file_exists
test_ac1_node_file_exists
test_ac2_rust_sections
test_ac2_node_sections
test_ac3_no_tool_config_files
test_ac5_rust_no_framework_names
test_ac5_node_no_framework_names

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
