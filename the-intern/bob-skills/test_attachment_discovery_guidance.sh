#!/usr/bin/env bash
# Content assertions for the attachment-discovery guidance in the shipped
# himalaya and email-triage skills: a message's envelope `has_attachment`
# flag and its rendered MML `<#part>` lines are not authoritative, and
# `attachment download` into a scratch directory is the check to run before
# concluding an attachment is missing.
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$PACKAGE_DIR/skills"
HIMALAYA_REF="$SKILLS/himalaya/references/command-reference.md"
TRIAGE_SKILL="$SKILLS/email-triage/SKILL.md"
DIRECT_REQUEST="$SKILLS/email-triage/references/categories/direct-request.md"

pass_count=0
fail_count=0

run_test() {
  if [ "$2" = "0" ]; then
    echo "PASS: $1"
    ((pass_count++)) || true
  else
    echo "FAIL: $1"
    ((fail_count++)) || true
  fi
}

# Collapse whitespace so assertions survive markdown line wrapping.
flatten() { tr '\n' ' ' < "$1" | tr -s ' '; }

test_himalaya_reference_says_has_attachment_false_is_not_proof() {
  local ok=0 text
  text="$(flatten "$HIMALAYA_REF")"
  grep -q -i 'has_attachment":false` and an absent `<#part>` line do not prove' <<<"$text" || ok=1
  run_test "himalaya reference: has_attachment:false and missing <#part> do not prove absence" "$ok"
}

test_himalaya_reference_names_download_as_authoritative_check() {
  local ok=0 text
  text="$(flatten "$HIMALAYA_REF")"
  grep -q -i 'attachment download -d <scratch-dir> <id>` is the authoritative check' <<<"$text" || ok=1
  run_test "himalaya reference: attachment download into a scratch dir is the authoritative check" "$ok"
}

test_himalaya_reference_documents_nested_inline_part() {
  local ok=0 text
  text="$(flatten "$HIMALAYA_REF")"
  grep -q -i 'nested' <<<"$text" || ok=1
  grep -q -i 'inline' <<<"$text" || ok=1
  run_test "himalaya reference: describes nested inline parts invisible to both signals" "$ok"
}

test_triage_skill_requires_attachment_download_before_missing_conclusion() {
  local ok=0
  grep -q 'attachment download' "$TRIAGE_SKILL" || ok=1
  grep -q -i 'scratch' "$TRIAGE_SKILL" || ok=1
  run_test "email-triage SKILL.md: requires attachment download before concluding missing" "$ok"
}

test_direct_request_requires_attachment_download_before_escalating() {
  local ok=0
  grep -q 'attachment download' "$DIRECT_REQUEST" || ok=1
  grep -q -i 'scratch' "$DIRECT_REQUEST" || ok=1
  run_test "direct-request.md: requires attachment download before escalating a missing attachment" "$ok"
}

test_shipped_guidance_has_no_internal_ids() {
  local ok=0
  grep -r -n -E '\b(B|T|S|ADR)-[0-9]{2,3}\b' "$HIMALAYA_REF" "$TRIAGE_SKILL" "$DIRECT_REQUEST" >/dev/null && ok=1
  run_test "shipped guidance contains no internal task/bug/spec IDs" "$ok"
}

test_pi_mirror_matches_regenerated_output() {
  local ok=0 work
  work="$(mktemp -d)"
  cp -r "$SKILLS" "$work/skills"
  cp "$PACKAGE_DIR/package-pi-skills.sh" "$work/"
  ( cd "$work" && ./package-pi-skills.sh ) >/dev/null || ok=1
  diff -r "$work/.pi/skills" "$PACKAGE_DIR/.pi/skills" >/dev/null || ok=1
  rm -rf "$work"
  run_test ".pi/skills mirror is in sync with canonical skills" "$ok"
}

test_himalaya_reference_says_has_attachment_false_is_not_proof
test_himalaya_reference_names_download_as_authoritative_check
test_himalaya_reference_documents_nested_inline_part
test_triage_skill_requires_attachment_download_before_missing_conclusion
test_direct_request_requires_attachment_download_before_escalating
test_shipped_guidance_has_no_internal_ids
test_pi_mirror_matches_regenerated_output

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
