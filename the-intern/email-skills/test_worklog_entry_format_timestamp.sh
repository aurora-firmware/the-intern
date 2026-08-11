#!/usr/bin/env bash
# Regression test for B-039: the worklog skill's entry-format.md must show
# the current time being computed via an explicit `date` lookup the same
# way it already computes TODAY=$(date +%F), instead of leaving <HH:MM> as
# a bare fill-in-the-blank placeholder with no equivalent lookup.
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

# Extract the shown append-command bash block from the "Creating the
# worklog file" section (the first ```bash ... ``` fenced block in the
# file).
extract_command_block() {
  awk '/^```bash$/{flag=1; next} /^```$/{if (flag) exit} flag' "$ENTRY_FORMAT"
}

# Regression: the shown append-command block must compute the current time
# with an explicit `date` lookup (e.g. NOW=$(date +%H:%M)), the same way it
# already computes TODAY=$(date +%F) -- not leave <HH:MM> as a bare
# fill-in-the-blank placeholder that invites a literal default like 00:00.
test_command_block_computes_now_from_date() {
  local ok=0
  local block
  block="$(extract_command_block)"
  [ -n "$block" ] || ok=1
  echo "$block" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*=\$\(date \+%H:%M\)$' || ok=1
  run_test "shown append-command block computes the current time via a date +%H:%M lookup" "$ok"
}

test_command_block_computes_now_from_date

# Regression: the heredoc entry header inside the shown command block must
# use the computed time variable in the <HH:MM> position, not a bare
# <HH:MM> placeholder.
test_heredoc_header_uses_computed_time_variable() {
  local ok=0
  local block time_var
  block="$(extract_command_block)"
  time_var="$(echo "$block" | grep -Eo '^[A-Za-z_][A-Za-z0-9_]*=\$\(date \+%H:%M\)$' | head -n1 | cut -d= -f1)"
  [ -n "$time_var" ] || ok=1
  if [ -n "$time_var" ]; then
    echo "$block" | grep -Fq "## \$$time_var — " || ok=1
  fi
  echo "$block" | grep -Fq '<HH:MM>' && ok=1
  run_test "heredoc entry header uses the computed time variable instead of a bare <HH:MM> placeholder" "$ok"
}

test_heredoc_header_uses_computed_time_variable

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
