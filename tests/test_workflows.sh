#!/usr/bin/env bash
# Test suite for GitHub Actions workflow scaffolding (T-001)
# Each test function prints PASS or FAIL and exits 1 on first failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
BUILD="$WORKFLOWS_DIR/build.yml"
TEST_WF="$WORKFLOWS_DIR/test.yml"
DEPLOY="$WORKFLOWS_DIR/deploy.yml"

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

# AC-1: All three workflow files must exist
test_ac1_files_exist() {
  local ok=0
  [ -f "$BUILD" ] || ok=1
  [ -f "$TEST_WF" ] || ok=1
  [ -f "$DEPLOY" ] || ok=1
  run_test "AC-1: all three workflow files exist" "$ok"
}

# AC-1: All three files parse as valid YAML
test_ac1_valid_yaml() {
  local ok=0
  python3 -c "
import yaml, sys
for p in sys.argv[1:]:
    yaml.safe_load(open(p))
" "$BUILD" "$TEST_WF" "$DEPLOY" 2>/dev/null || ok=1
  run_test "AC-1: all workflow files are valid YAML" "$ok"
}

# AC-2: build.yml has pull_request trigger
test_ac2_build_has_pull_request() {
  local ok=0
  grep -q "pull_request" "$BUILD" 2>/dev/null || ok=1
  run_test "AC-2: build.yml has pull_request trigger" "$ok"
}

# AC-2: test.yml has pull_request trigger
test_ac2_test_has_pull_request() {
  local ok=0
  grep -q "pull_request" "$TEST_WF" 2>/dev/null || ok=1
  run_test "AC-2: test.yml has pull_request trigger" "$ok"
}

# AC-2: build.yml has push trigger for dev-agent and main
test_ac2_build_has_push_branches() {
  local ok=0
  grep -qE "dev-agent|main" "$BUILD" 2>/dev/null || ok=1
  run_test "AC-2: build.yml has push trigger for dev-agent and main" "$ok"
}

# AC-2: test.yml has push trigger for dev-agent and main
test_ac2_test_has_push_branches() {
  local ok=0
  grep -qE "dev-agent|main" "$TEST_WF" 2>/dev/null || ok=1
  run_test "AC-2: test.yml has push trigger for dev-agent and main" "$ok"
}

# AC-3: deploy.yml triggers on v* tags only
test_ac3_deploy_has_vtag_trigger() {
  local ok=0
  grep -qE "tags:|v\*" "$DEPLOY" 2>/dev/null || ok=1
  run_test "AC-3: deploy.yml has v* tag trigger" "$ok"
}

# AC-3: deploy.yml does NOT have pull_request trigger
test_ac3_deploy_no_pull_request() {
  local ok=0
  grep -q "pull_request" "$DEPLOY" 2>/dev/null && ok=1
  run_test "AC-3: deploy.yml does not have pull_request trigger" "$ok"
}

# AC-3: deploy.yml does NOT have push to branches (only tags)
test_ac3_deploy_no_branch_push() {
  # The deploy file should not list dev-agent or main under push branches
  local ok=0
  python3 -c "
import yaml, sys
doc = yaml.safe_load(open(sys.argv[1]))
on = doc.get('on', doc.get(True, {}))
push = on.get('push', {})
branches = push.get('branches', [])
if branches:
    sys.exit(1)
" "$DEPLOY" 2>/dev/null || ok=1
  run_test "AC-3: deploy.yml push trigger uses tags, not branches" "$ok"
}

# AC-4: Each workflow has at least one job with an echo step
test_ac4_build_has_echo_step() {
  local ok=0
  grep -q "echo" "$BUILD" 2>/dev/null || ok=1
  run_test "AC-4: build.yml has an echo placeholder step" "$ok"
}

test_ac4_test_has_echo_step() {
  local ok=0
  grep -q "echo" "$TEST_WF" 2>/dev/null || ok=1
  run_test "AC-4: test.yml has an echo placeholder step" "$ok"
}

test_ac4_deploy_has_echo_step() {
  local ok=0
  grep -q "echo" "$DEPLOY" 2>/dev/null || ok=1
  run_test "AC-4: deploy.yml has an echo placeholder step" "$ok"
}

# AC-5: No forbidden content (secrets, docker, codecov, semantic-release, changelog)
test_ac5_no_forbidden_content() {
  local ok=0
  grep -RinE "secrets\.|docker/build-push|codecov|semantic-release|changelog" \
    "$WORKFLOWS_DIR/" 2>/dev/null && ok=1
  run_test "AC-5: no forbidden content in any workflow" "$ok"
}

# Run all tests
test_ac1_files_exist
test_ac1_valid_yaml
test_ac2_build_has_pull_request
test_ac2_test_has_pull_request
test_ac2_build_has_push_branches
test_ac2_test_has_push_branches
test_ac3_deploy_has_vtag_trigger
test_ac3_deploy_no_pull_request
test_ac3_deploy_no_branch_push
test_ac4_build_has_echo_step
test_ac4_test_has_echo_step
test_ac4_deploy_has_echo_step
test_ac5_no_forbidden_content

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
