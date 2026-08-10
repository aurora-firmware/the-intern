#!/usr/bin/env bash
# Test suite for the Claude Code packaging script (T-163)
# Each test function prints PASS or FAIL and exits 1 on first failure.
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$PACKAGE_DIR/package-claude-skills.sh"

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
# repository's own tracked claude/ output.
WORK_DIR="$(mktemp -d)"
WORK_DIR2="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR" "$WORK_DIR2"' EXIT
cp -r "$PACKAGE_DIR/skills" "$WORK_DIR/skills"
cp "$SCRIPT" "$WORK_DIR/package-claude-skills.sh"
chmod +x "$WORK_DIR/package-claude-skills.sh"

# AC-1: running the script produces SKILL.md and references/ for all three
# skills under the new claude/skills/<name>/ location.
test_ac1_generates_expected_tree() {
  local ok=0
  ( cd "$WORK_DIR" && ./package-claude-skills.sh ) || ok=1
  [ -f "$WORK_DIR/claude/skills/himalaya/SKILL.md" ] || ok=1
  [ -d "$WORK_DIR/claude/skills/himalaya/references" ] || ok=1
  [ -f "$WORK_DIR/claude/skills/email-triage/SKILL.md" ] || ok=1
  [ -d "$WORK_DIR/claude/skills/email-triage/references" ] || ok=1
  [ -f "$WORK_DIR/claude/skills/worklog/SKILL.md" ] || ok=1
  [ -d "$WORK_DIR/claude/skills/worklog/references" ] || ok=1
  run_test "AC-1: script generates SKILL.md and references/ for all three skills under claude/skills/" "$ok"
}

test_ac1_generates_expected_tree

# AC-3: generated output (SKILL.md and the full references/ tree) is
# byte-for-byte identical to the canonical source for all three skills.
# Unlike the pi target (T-153), Claude Code's own frontmatter fields (name,
# description, compatibility) are already what the canonical source carries,
# so no vendor-specific field needs to be added here.
test_ac3_output_byte_identical_to_canonical_source() {
  local ok=0
  for name in himalaya email-triage worklog; do
    diff -r "$WORK_DIR/skills/$name" "$WORK_DIR/claude/skills/$name" >/dev/null || ok=1
  done
  run_test "AC-3: generated SKILL.md and references/ trees are byte-for-byte identical to canonical source" "$ok"
}

test_ac3_output_byte_identical_to_canonical_source

# AC-3 (regeneration): re-running the script regenerates each packaged
# skill's tree from scratch, so a file that no longer exists in the
# canonical source does not survive as stale generated output and break the
# byte-for-byte identity AC-3 requires.
test_ac3_regeneration_removes_stale_generated_files() {
  local ok=0
  local stale_file="$WORK_DIR/claude/skills/himalaya/references/stale-leftover.md"
  mkdir -p "$(dirname "$stale_file")"
  echo "stale content that no longer exists in the canonical source" > "$stale_file"
  ( cd "$WORK_DIR" && ./package-claude-skills.sh ) || ok=1
  [ ! -e "$stale_file" ] || ok=1
  run_test "AC-3: regeneration removes stale generated files not in canonical source" "$ok"
}

test_ac3_regeneration_removes_stale_generated_files

# AC-2: the generated package lives at a new location within
# the-intern/email-skills/ (claude/skills/, verified above) and the script
# must never modify any file under the-intern/bob-companion/claude/ — a
# different plugin with a different audience/release cadence. Mirrors the
# real repository's sibling layout (the-intern/email-skills/ next to
# the-intern/bob-companion/) in an isolated copy so this proves it without
# touching the real repository tree.
test_ac2_does_not_modify_bob_companion_claude() {
  local ok=0
  local repo_root
  repo_root="$(cd "$PACKAGE_DIR/../.." && pwd)"
  mkdir -p "$WORK_DIR2/the-intern/email-skills"
  cp -r "$PACKAGE_DIR/skills" "$WORK_DIR2/the-intern/email-skills/skills"
  cp "$SCRIPT" "$WORK_DIR2/the-intern/email-skills/package-claude-skills.sh"
  chmod +x "$WORK_DIR2/the-intern/email-skills/package-claude-skills.sh"
  cp -r "$repo_root/the-intern/bob-companion" "$WORK_DIR2/the-intern/bob-companion"

  local before_snapshot="$WORK_DIR2/bob-companion-before.txt"
  local after_snapshot="$WORK_DIR2/bob-companion-after.txt"
  ( cd "$WORK_DIR2/the-intern/bob-companion" && find . -type f -exec sha256sum {} \; | sort ) > "$before_snapshot"

  ( cd "$WORK_DIR2/the-intern/email-skills" && ./package-claude-skills.sh ) || ok=1

  ( cd "$WORK_DIR2/the-intern/bob-companion" && find . -type f -exec sha256sum {} \; | sort ) > "$after_snapshot"
  diff "$before_snapshot" "$after_snapshot" >/dev/null || ok=1
  run_test "AC-2: script never modifies bob-companion/claude" "$ok"
}

test_ac2_does_not_modify_bob_companion_claude

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
