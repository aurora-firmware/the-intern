#!/usr/bin/env bash
# Test suite for the current the-intern application-code structure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$REPO_ROOT/the-intern"
SERVICE_DIR="$ROOT_DIR/service"
EXTENSIONS_DIR="$ROOT_DIR/pi-extension"
ROOT_README="$ROOT_DIR/README.md"
SERVICE_README="$SERVICE_DIR/README.md"
EXTENSIONS_README="$EXTENSIONS_DIR/README.md"
SERVICE_MANIFEST="$SERVICE_DIR/Cargo.toml"
SPEC_REF="the-intern-agent-service-architecture.md"
SHELL_SPEC_REF="bob-service-shell-architecture.md"

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

# Required directories exist.
test_ac1_required_directories_exist() {
  local ok=0
  [ -d "$ROOT_DIR" ] || ok=1
  [ -d "$SERVICE_DIR" ] || ok=1
  [ -d "$EXTENSIONS_DIR" ] || ok=1
  run_test "AC-1: required directories exist" "$ok"
}

# READMEs exist and point to architecture/spec guidance.
test_ac2_required_readmes_exist_and_reference_specs() {
  local ok=0
  [ -f "$ROOT_README" ] || ok=1
  [ -f "$SERVICE_README" ] || ok=1
  [ -f "$EXTENSIONS_README" ] || ok=1

  if [ "$ok" = "0" ]; then
    grep -q "$SPEC_REF" "$ROOT_README" 2>/dev/null || { ok=1; echo "  root README missing S-001 reference"; }
    grep -q "$SHELL_SPEC_REF" "$ROOT_README" 2>/dev/null || { ok=1; echo "  root README missing shell spec reference"; }
    grep -q "$SPEC_REF" "$SERVICE_README" 2>/dev/null || { ok=1; echo "  service README missing S-001 reference"; }
    grep -q "$SHELL_SPEC_REF" "$SERVICE_README" 2>/dev/null || { ok=1; echo "  service README missing shell spec reference"; }
    grep -q "$SPEC_REF" "$EXTENSIONS_README" 2>/dev/null || { ok=1; echo "  extensions README missing S-001 reference"; }
  fi

  run_test "AC-2: required READMEs exist and reference specs" "$ok"
}

# The Rust service workspace exists.
test_ac3_service_workspace_exists() {
  local ok=0
  [ -f "$SERVICE_MANIFEST" ] || ok=1
  [ -d "$SERVICE_DIR/crates/bob" ] || ok=1
  [ -d "$SERVICE_DIR/crates/bob-core" ] || ok=1
  run_test "AC-3: Rust service workspace exists" "$ok"
}

# Extensions README states pi-agent is provided externally and not vendored.
test_ac4_extensions_readme_mentions_external_pi_agent_and_not_vendored() {
  local ok=0
  grep -qiE "local developer|runtime environment|provided" "$EXTENSIONS_README" 2>/dev/null || ok=1
  grep -qiE "not vendored|not included" "$EXTENSIONS_README" 2>/dev/null || ok=1
  run_test "AC-4: extensions README includes external pi-agent and not-vendored note" "$ok"
}

# No additional top-level package/crate directories beyond service, pi-extension,
# and bob-companion (the Claude plugin family).
test_ac5_no_additional_top_level_code_directories() {
  local ok=0
  local extra_dirs
  if [ ! -d "$ROOT_DIR" ]; then
    ok=1
  else
    extra_dirs=$(find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -type d ! -name service ! -name pi-extension ! -name bob-companion ! -name docs)
  fi

  if [ -n "${extra_dirs:-}" ]; then
    ok=1
    echo "  unexpected top-level directories under the-intern:"
    echo "$extra_dirs"
  fi
  run_test "AC-5: no extra package/crate directories" "$ok"
}

# Run all tests
test_ac1_required_directories_exist
test_ac2_required_readmes_exist_and_reference_specs
test_ac3_service_workspace_exists
test_ac4_extensions_readme_mentions_external_pi_agent_and_not_vendored
test_ac5_no_additional_top_level_code_directories

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
