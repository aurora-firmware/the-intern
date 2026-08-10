#!/usr/bin/env bash
# Test suite for the pi packaging script (T-153)
# Each test function prints PASS or FAIL and exits 1 on first failure.
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$PACKAGE_DIR/package-pi-skills.sh"

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

# Work in an isolated copy of the canonical source so tests never mutate the
# repository's own tracked .pi/skills output.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cp -r "$PACKAGE_DIR/skills" "$WORK_DIR/skills"
cp "$SCRIPT" "$WORK_DIR/package-pi-skills.sh"
chmod +x "$WORK_DIR/package-pi-skills.sh"

# AC-1: running the script produces SKILL.md and references/ for both skills
test_ac1_generates_expected_tree() {
  local ok=0
  ( cd "$WORK_DIR" && ./package-pi-skills.sh ) || ok=1
  [ -f "$WORK_DIR/.pi/skills/himalaya/SKILL.md" ] || ok=1
  [ -d "$WORK_DIR/.pi/skills/himalaya/references" ] || ok=1
  [ -f "$WORK_DIR/.pi/skills/email-triage/SKILL.md" ] || ok=1
  [ -d "$WORK_DIR/.pi/skills/email-triage/references" ] || ok=1
  run_test "AC-1: script generates SKILL.md and references/ for both skills" "$ok"
}

test_ac1_generates_expected_tree

# AC-2: generated SKILL.md body is byte-for-byte identical to the canonical
# source, and its frontmatter additionally contains allowed-tools: Read Bash.
# Stripping that one added line from the generated frontmatter must
# reproduce the canonical file exactly (frontmatter and body alike).
test_ac2_frontmatter_gains_allowed_tools_body_unchanged() {
  local ok=0
  for name in himalaya email-triage; do
    local canonical="$WORK_DIR/skills/$name/SKILL.md"
    local generated="$WORK_DIR/.pi/skills/$name/SKILL.md"
    grep -q '^allowed-tools: Read Bash$' "$generated" || ok=1
    diff <(cat "$canonical") <(grep -v '^allowed-tools: Read Bash$' "$generated") >/dev/null || ok=1
  done
  run_test "AC-2: generated SKILL.md adds allowed-tools and leaves everything else byte-identical" "$ok"
}

test_ac2_frontmatter_gains_allowed_tools_body_unchanged

# AC-4: re-running the script regenerates each packaged skill's tree from
# scratch, so a file that no longer exists in the canonical source does not
# survive as stale generated output.
test_ac4_regeneration_removes_stale_generated_files() {
  local ok=0
  local stale_file="$WORK_DIR/.pi/skills/himalaya/references/stale-leftover.md"
  mkdir -p "$(dirname "$stale_file")"
  echo "stale content that no longer exists in the canonical source" > "$stale_file"
  ( cd "$WORK_DIR" && ./package-pi-skills.sh ) || ok=1
  [ ! -e "$stale_file" ] || ok=1
  run_test "AC-4: regeneration removes stale generated files not in canonical source" "$ok"
}

test_ac4_regeneration_removes_stale_generated_files

# AC-3: the generated .pi/skills output stays committed to version control
# with unchanged tracked status (this is a regression guard on repository
# configuration, not on the script itself — the script has no say over what
# git tracks). Runs against the real repository, not the isolated WORK_DIR.
test_ac3_generated_output_stays_tracked_and_not_ignored() {
  local ok=0
  local repo_root
  repo_root="$(cd "$PACKAGE_DIR/../.." && pwd)"
  for generated in \
    the-intern/email-skills/.pi/skills/himalaya/SKILL.md \
    the-intern/email-skills/.pi/skills/email-triage/SKILL.md
  do
    git -C "$repo_root" check-ignore -q "$generated" && ok=1
    git -C "$repo_root" ls-files --error-unmatch "$generated" >/dev/null 2>&1 || ok=1
  done
  run_test "AC-3: generated .pi/skills output stays git-tracked, not ignored" "$ok"
}

test_ac3_generated_output_stays_tracked_and_not_ignored

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
