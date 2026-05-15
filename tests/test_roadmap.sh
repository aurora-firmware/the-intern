#!/usr/bin/env bash
# Test suite for T-005 phase-based project roadmap
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROADMAP="$REPO_ROOT/project/docs/roadmap.md"
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

roadmap_exists() {
  [ -f "$ROADMAP" ]
}

get_phase_section() {
  local phase="$1"
  awk -v phase="$phase" '
    $0 ~ "^## Phase " phase "([^0-9]|$)" { in_section=1; next }
    in_section && $0 ~ "^## Phase [0-9]([^0-9]|$)" { exit }
    in_section { print }
  ' "$ROADMAP"
}

# AC-1: roadmap file exists
test_ac1_roadmap_exists() {
  local ok=0
  [ -f "$ROADMAP" ] || ok=1
  run_test "AC-1: roadmap.md exists" "$ok"
}

# AC-2: Phase 0 plus phases 1..7 exist in correct order and match implementation sequence
test_ac2_phase_headings_in_order() {
  local ok=0
  local prev_line=0
  local line

  if ! roadmap_exists; then
    run_test "AC-2: phases 0..7 are present and in implementation order" "1"
    return
  fi

  local patterns=(
    '^## Phase 0[^0-9]*Foundations'
    '^## Phase 1[^0-9]*Rust service skeleton'
    '^## Phase 2[^0-9]*pi-agent process supervision'
    '^## Phase 3[^0-9]*JS extension'
    '^## Phase 4[^0-9]*Policy Control'
    '^## Phase 5[^0-9]*Monitoring'
    '^## Phase 6[^0-9]*Channel adapters'
    '^## Phase 7[^0-9]*Actions'
  )

  for pattern in "${patterns[@]}"; do
    line=$(grep -inE "$pattern" "$ROADMAP" 2>/dev/null | head -n1 | cut -d: -f1)
    if [ -z "${line:-}" ]; then
      ok=1
      echo "  missing phase heading matching: $pattern"
      continue
    fi

    if [ "$line" -le "$prev_line" ]; then
      ok=1
      echo "  out-of-order phase heading for pattern: $pattern"
    fi
    prev_line="$line"
  done

  run_test "AC-2: phases 0..7 are present and in implementation order" "$ok"
}

# AC-3: each phase has prose plus an architecture spec reference
test_ac3_each_phase_has_outcome_and_spec_reference() {
  local ok=0
  local section
  local phase

  if ! roadmap_exists; then
    run_test "AC-3: each phase includes prose and architecture spec reference" "1"
    return
  fi

  for phase in 0 1 2 3 4 5 6 7; do
    section="$(get_phase_section "$phase")"

    if ! printf '%s\n' "$section" | grep -q "$SPEC_REF"; then
      ok=1
      echo "  missing architecture spec reference in Phase $phase"
    fi

    if ! printf '%s\n' "$section" | grep -qE '[[:alpha:]][^.]*\.'; then
      ok=1
      echo "  missing prose paragraph in Phase $phase"
    fi
  done

  run_test "AC-3: each phase includes prose and architecture spec reference" "$ok"
}

# AC-4: forbidden content must not appear
test_ac4_forbidden_content_absent() {
  local ok=0

  if ! roadmap_exists; then
    run_test "AC-4: roadmap omits forbidden planning metadata" "1"
    return
  fi

  grep -qE 'T-[0-9]+' "$ROADMAP" 2>/dev/null && { ok=1; echo "  found forbidden task ID reference"; }
  grep -qiE 'story point|t-shirt|estimate|hours?:|owner:|assignee' "$ROADMAP" 2>/dev/null && { ok=1; echo "  found forbidden estimate/ownership content"; }
  grep -qiE 'exit criteri' "$ROADMAP" 2>/dev/null && { ok=1; echo "  found forbidden exit criteria content"; }

  run_test "AC-4: roadmap omits forbidden planning metadata" "$ok"
}

# AC-5: dependency ordering statements must align with the architecture implementation order
test_ac5_dependency_ordering_not_contradicted() {
  local ok=0

  if ! roadmap_exists; then
    run_test "AC-5: dependency ordering is consistent with architecture spec" "1"
    return
  fi

  local phase2 phase3 phase4 phase5 phase6 phase7
  phase2="$(get_phase_section 2)"
  phase3="$(get_phase_section 3)"
  phase4="$(get_phase_section 4)"
  phase5="$(get_phase_section 5)"
  phase6="$(get_phase_section 6)"
  phase7="$(get_phase_section 7)"

  printf '%s\n' "$phase2" | grep -qE 'Phase 1' || { ok=1; echo "  Phase 2 should depend on Phase 1"; }
  printf '%s\n' "$phase3" | grep -qE 'Phase 2' || { ok=1; echo "  Phase 3 should depend on Phase 2"; }
  printf '%s\n' "$phase4" | grep -qE 'Phase 2' || { ok=1; echo "  Phase 4 should depend on Phase 2"; }
  printf '%s\n' "$phase4" | grep -qE 'Phase 3' || { ok=1; echo "  Phase 4 should depend on Phase 3"; }
  printf '%s\n' "$phase5" | grep -qE 'Phase 1' || { ok=1; echo "  Phase 5 should depend on Phase 1"; }
  printf '%s\n' "$phase5" | grep -qE 'Phase 3' || { ok=1; echo "  Phase 5 should depend on Phase 3"; }
  printf '%s\n' "$phase6" | grep -qE 'Phase 1' || { ok=1; echo "  Phase 6 should depend on Phase 1"; }
  printf '%s\n' "$phase7" | grep -qE 'Phase 4' || { ok=1; echo "  Phase 7 should depend on Phase 4"; }
  printf '%s\n' "$phase7" | grep -qE 'Phase 5' || { ok=1; echo "  Phase 7 should depend on Phase 5"; }

  run_test "AC-5: dependency ordering is consistent with architecture spec" "$ok"
}

# Run all tests
test_ac1_roadmap_exists
test_ac2_phase_headings_in_order
test_ac3_each_phase_has_outcome_and_spec_reference
test_ac4_forbidden_content_absent
test_ac5_dependency_ordering_not_contradicted

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
