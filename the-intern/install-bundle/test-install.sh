#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_install_script="${repo_root}/the-intern/install-bundle/install.sh"

assert_contains() {
  local file="$1"
  local expected="$2"

  if ! grep -Fq "$expected" "$file"; then
    printf 'expected %s to contain: %s\n' "$file" "$expected" >&2
    printf 'actual contents:\n' >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"

  if grep -Fq "$unexpected" "$file"; then
    printf 'expected %s not to contain: %s\n' "$file" "$unexpected" >&2
    printf 'actual contents:\n' >&2
    cat "$file" >&2
    exit 1
  fi
}

make_bundle() {
  local dir="$1"

  mkdir -p "$dir"
  cp "$source_install_script" "$dir/install.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$dir/bob"
  printf 'export default {}\n' >"$dir/bob.ts"
  chmod +x "$dir/install.sh" "$dir/bob"
}

test_abort_when_overwrite_prompt_hits_eof() {
  local tmp_dir
  local home_dir
  local bundle_dir
  local stdout_file
  local stderr_file
  local status

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  home_dir="$tmp_dir/home"
  bundle_dir="$tmp_dir/bundle"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  mkdir -p "$home_dir/.local/bin" "$home_dir/.local/share/bob/extensions"
  printf 'existing binary\n' >"$home_dir/.local/bin/bob"
  printf 'existing extension\n' >"$home_dir/.local/share/bob/extensions/bob.ts"

  make_bundle "$bundle_dir"

  status=0
  if (
    cd "$bundle_dir"
    PATH="/usr/bin:/bin" HOME="$home_dir" ./install.sh </dev/null >"$stdout_file" 2>"$stderr_file"
  ); then
    printf 'expected install.sh to fail when overwrite confirmation reads EOF\n' >&2
    exit 1
  else
    status=$?
  fi

  if [ "$status" -eq 0 ]; then
    printf 'expected a non-zero exit status when overwrite confirmation reads EOF\n' >&2
    exit 1
  fi

  assert_contains "$stderr_file" "Install aborted: no input available for overwrite confirmation."

  if [ "$(cat "$home_dir/.local/bin/bob")" != "existing binary" ]; then
    printf 'expected existing binary to remain unchanged\n' >&2
    exit 1
  fi

  if [ "$(cat "$home_dir/.local/share/bob/extensions/bob.ts")" != "existing extension" ]; then
    printf 'expected existing extension to remain unchanged\n' >&2
    exit 1
  fi
}

test_trailing_slash_path_entry_counts_as_present() {
  local tmp_dir
  local home_dir
  local bundle_dir
  local stdout_file
  local stderr_file

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  home_dir="$tmp_dir/home"
  bundle_dir="$tmp_dir/bundle"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  mkdir -p "$home_dir"
  make_bundle "$bundle_dir"

  (
    cd "$bundle_dir"
    PATH="$home_dir/.local/bin/:/usr/bin:/bin" HOME="$home_dir" ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  assert_not_contains "$stdout_file" "Warning: $home_dir/.local/bin is not on PATH."
}

test_empty_path_entry_uses_current_directory() {
  local tmp_dir
  local home_dir
  local bundle_dir
  local stdout_file
  local stderr_file

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  home_dir="$tmp_dir/home"
  bundle_dir="$tmp_dir/bundle"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  mkdir -p "$home_dir/.local/bin"
  make_bundle "$bundle_dir"

  (
    cd "$home_dir/.local/bin"
    PATH=":/usr/bin:/bin" HOME="$home_dir" "$bundle_dir/install.sh" >"$stdout_file" 2>"$stderr_file"
  )

  assert_not_contains "$stdout_file" "Warning: $home_dir/.local/bin is not on PATH."
}

test_abort_when_overwrite_prompt_hits_eof
test_trailing_slash_path_entry_counts_as_present
test_empty_path_entry_uses_current_directory
