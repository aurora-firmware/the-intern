#!/usr/bin/env bash
# Tests for T-084: README section pointing at user documentation and release docs archive.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
README="$REPO_ROOT/README.md"

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

# AC-1: README names the-intern/docs/ as the user manual location and
# distinguishes it from project/docs/.
test_ac1_readme_points_at_intern_docs_and_distinguishes_project_docs() {
  local ok=0
  grep -q "the-intern/docs" "$README" 2>/dev/null || ok=1
  # Must also retain the existing project/docs reference (not removed)
  grep -q "project/docs" "$README" 2>/dev/null || ok=1
  run_test "AC-1: README names the-intern/docs/ and distinguishes it from project/docs/" "$ok"
}

# AC-2: README documents how to build docs locally, naming mdbook and
# mdbook-mermaid as cargo install dependencies.
test_ac2_readme_documents_local_build_with_mdbook_and_mdbook_mermaid() {
  local ok=0
  grep -q "mdbook" "$README" 2>/dev/null || ok=1
  grep -q "mdbook-mermaid" "$README" 2>/dev/null || ok=1
  grep -q "cargo install" "$README" 2>/dev/null || ok=1
  run_test "AC-2: README documents local build with mdbook and mdbook-mermaid via cargo install" "$ok"
}

# AC-3: README states every GitHub Release ships a docs archive as a release
# asset and links to the Releases page.
test_ac3_readme_mentions_release_docs_archive_and_releases_page() {
  local ok=0
  grep -qi "release" "$README" 2>/dev/null || ok=1
  grep -qi "docs archive\|documentation archive" "$README" 2>/dev/null || ok=1
  run_test "AC-3: README mentions release docs archive and links to Releases page" "$ok"
}

# AC-4: README names BOB_BIN and its documented fallback so a first-time
# docs builder knows what to set.
test_ac4_readme_names_bob_bin_and_fallback() {
  local ok=0
  grep -q "BOB_BIN" "$README" 2>/dev/null || ok=1
  run_test "AC-4: README names BOB_BIN and its fallback paths" "$ok"
}

# Run all tests
test_ac1_readme_points_at_intern_docs_and_distinguishes_project_docs
test_ac2_readme_documents_local_build_with_mdbook_and_mdbook_mermaid
test_ac3_readme_mentions_release_docs_archive_and_releases_page
test_ac4_readme_names_bob_bin_and_fallback

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
