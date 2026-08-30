#!/usr/bin/env bash
# Regression guard for the worklog skill's entry-format reference.
#
# History: the worklog entry timestamp was mis-specified twice while the
# entry format was a raw shell recipe a session ran by hand -- first with
# no instruction to look up the real time at all, so a literal placeholder
# time landed in the file; then with a hand-transcribed bracketed <NOW>
# placeholder that was itself routinely transcribed wrong. Both defects are
# structurally gone now that `bob worklog` owns the entry format and stamps
# every entry from its own clock. This test locks that in: entry-format.md
# must stay a reference description that defers to `bob worklog append`, and
# must never drift back into a hand-run append recipe (a `date +%H:%M`
# lookup, a `<NOW>` transcription placeholder, a `mkdir -p worklog`, or a
# `>> worklog/...` redirect).
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRY_FORMAT="$PACKAGE_DIR/skills/worklog/references/entry-format.md"

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

# The reference must point the reader at the command, not at a recipe.
test_defers_to_bob_worklog_append() {
  local ok=0
  grep -Fq 'bob worklog append' "$ENTRY_FORMAT" || ok=1
  run_test "entry-format.md instructs calling bob worklog append" "$ok"
}

# The command now supplies the timestamp; no hand-run time lookup remains.
test_no_hand_run_time_lookup() {
  local ok=0
  grep -Eq 'date \+%H:%M' "$ENTRY_FORMAT" && ok=1
  run_test "entry-format.md contains no hand-run 'date +%H:%M' time lookup" "$ok"
}

# The <NOW> transcription placeholder retired with the hand-run recipe.
test_no_now_transcription_placeholder() {
  local ok=0
  grep -Fq '<NOW>' "$ENTRY_FORMAT" && ok=1
  run_test "entry-format.md contains no <NOW> transcription placeholder" "$ok"
}

# No raw shell append recipe for the worklog file.
test_no_raw_worklog_shell_recipe() {
  local ok=0
  grep -Eq '>> *"?worklog/' "$ENTRY_FORMAT" && ok=1
  grep -Fq 'mkdir -p worklog' "$ENTRY_FORMAT" && ok=1
  run_test "entry-format.md contains no raw 'mkdir'/'>> worklog/' shell recipe" "$ok"
}

test_defers_to_bob_worklog_append
test_no_hand_run_time_lookup
test_no_now_transcription_placeholder
test_no_raw_worklog_shell_recipe

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
