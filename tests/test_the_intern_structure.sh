#!/usr/bin/env bash
# Test suite for T-003 the-intern folder structure
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$REPO_ROOT/the-intern"
SERVICE_DIR="$ROOT_DIR/service"
EXTENSIONS_DIR="$ROOT_DIR/extensions"
ROOT_README="$ROOT_DIR/README.md"
SERVICE_README="$SERVICE_DIR/README.md"
EXTENSIONS_README="$EXTENSIONS_DIR/README.md"
SPEC_REF="project/specs/the-intern-agent-service-architecture.md"

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

assert_readme_stub_requirements() {
  local readme_path="$1"
  local ok=0
  local line_count
  line_count=$(wc -l < "$readme_path") || ok=1

  if [ "$line_count" -lt 3 ] || [ "$line_count" -gt 6 ]; then
    ok=1
    echo "  invalid line count in $readme_path: $line_count"
  fi

  grep -q "$SPEC_REF" "$readme_path" 2>/dev/null || {
    ok=1
    echo "  missing spec reference in $readme_path"
  }

  return "$ok"
}

# AC-1: required directories exist
test_ac1_required_directories_exist() {
  local ok=0
  [ -d "$ROOT_DIR" ] || ok=1
  [ -d "$SERVICE_DIR" ] || ok=1
  [ -d "$EXTENSIONS_DIR" ] || ok=1
  run_test "AC-1: required directories exist" "$ok"
}

# AC-2: each required README exists and is a 3-6 line stub with a spec reference
test_ac2_required_readmes_exist_and_stubbed() {
  local ok=0
  [ -f "$ROOT_README" ] || ok=1
  [ -f "$SERVICE_README" ] || ok=1
  [ -f "$EXTENSIONS_README" ] || ok=1

  if [ "$ok" = "0" ]; then
    assert_readme_stub_requirements "$ROOT_README" || ok=1
    assert_readme_stub_requirements "$SERVICE_README" || ok=1
    assert_readme_stub_requirements "$EXTENSIONS_README" || ok=1
  fi

  run_test "AC-2: required READMEs exist and match stub requirements" "$ok"
}

# AC-3: no source files or build manifests are present under the-intern
test_ac3_no_source_or_manifest_files() {
  local ok=0
  if find "$ROOT_DIR" -type f \( -name '*.rs' -o -name '*.ts' -o -name '*.js' \
    -o -name 'Cargo.toml' -o -name 'package.json' -o -name 'tsconfig.json' \) \
    2>/dev/null | grep -q .; then
    ok=1
  fi
  run_test "AC-3: no source files or manifests under the-intern" "$ok"
}

# AC-4: extensions README states pi-agent is in dev container and not vendored
test_ac4_extensions_readme_mentions_dev_container_and_not_vendored() {
  local ok=0
  grep -qi "dev container" "$EXTENSIONS_README" 2>/dev/null || ok=1
  grep -qiE "not vendored|not included|installed in" "$EXTENSIONS_README" 2>/dev/null || ok=1
  run_test "AC-4: extensions README includes dev-container and not-vendored note" "$ok"
}

# AC-5: no additional top-level package/crate directories beyond service and extensions
test_ac5_no_additional_top_level_code_directories() {
  local ok=0
  local extra_dirs
  if [ ! -d "$ROOT_DIR" ]; then
    ok=1
  else
    extra_dirs=$(find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -type d ! -name service ! -name extensions)
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
test_ac2_required_readmes_exist_and_stubbed
test_ac3_no_source_or_manifest_files
test_ac4_extensions_readme_mentions_dev_container_and_not_vendored
test_ac5_no_additional_top_level_code_directories

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
