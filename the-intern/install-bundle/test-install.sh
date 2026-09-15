#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_install_script="${repo_root}/the-intern/install-bundle/install.sh"

assert_contains() {
  local file="$1"
  local expected="$2"

  if ! grep -Fq -- "$expected" "$file"; then
    printf 'expected %s to contain: %s\n' "$file" "$expected" >&2
    printf 'actual contents:\n' >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"

  if grep -Fq -- "$unexpected" "$file"; then
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
  # The stub `bob` logs every invocation to $BOB_STUB_INVOCATION_LOG (when
  # set), prints a fake `init --skills-only` report so tests can confirm
  # install.sh does not suppress it, and exits with
  # $BOB_STUB_SKILLS_ONLY_EXIT (default 0) for that subcommand so tests can
  # force a refresh failure without touching install.sh itself.
  cat >"$dir/bob" <<'STUB'
#!/usr/bin/env bash
if [ -n "${BOB_STUB_INVOCATION_LOG:-}" ]; then
  printf '%s\n' "$*" >>"$BOB_STUB_INVOCATION_LOG"
fi
if [ "${1-}" = "init" ] && [ "${2-}" = "--skills-only" ]; then
  printf 'created skill: example\n'
  exit "${BOB_STUB_SKILLS_ONLY_EXIT:-0}"
fi
exit 0
STUB
  printf 'export default {}\n' >"$dir/bob.ts"
  chmod +x "$dir/install.sh" "$dir/bob"
}

test_replaces_a_running_binary_atomically() {
  local tmp_dir
  local home_dir
  local bundle_dir
  local stdout_file
  local stderr_file
  local running_pid=""

  tmp_dir="$(mktemp -d)"
  trap 'kill "$running_pid" 2>/dev/null || true; rm -rf "$tmp_dir"' RETURN
  home_dir="$tmp_dir/home"
  bundle_dir="$tmp_dir/bundle"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  mkdir -p "$home_dir/.local/bin" "$home_dir/.local/share/bob/extensions"

  # A running `#!` script at the target path never hits ETXTBSY -- only a
  # file currently execve()d as a program image does. Copy a real ELF (the
  # `sleep` binary) to the target and run it, so the path is genuinely busy
  # the same way a running `bob serve` executable is.
  cp "$(command -v sleep)" "$home_dir/.local/bin/bob"
  chmod +x "$home_dir/.local/bin/bob"
  "$home_dir/.local/bin/bob" 300 &
  running_pid=$!
  sleep 0.2

  make_bundle "$bundle_dir"

  if ! printf 'y\n' | (
    cd "$bundle_dir"
    PATH="/usr/bin:/bin" HOME="$home_dir" ./install.sh >"$stdout_file" 2>"$stderr_file"
  ); then
    printf 'expected install.sh to succeed while overwriting a running binary\n' >&2
    printf 'stdout:\n' >&2
    cat "$stdout_file" >&2
    printf 'stderr:\n' >&2
    cat "$stderr_file" >&2
    return 1
  fi

  if ! diff -q "$bundle_dir/bob" "$home_dir/.local/bin/bob" >/dev/null; then
    printf 'expected the installed binary to be replaced with the bundle binary\n' >&2
    return 1
  fi

  if compgen -G "$home_dir/.local/bin/bob.??????" >/dev/null; then
    printf 'expected no leftover install temp file in %s\n' "$home_dir/.local/bin" >&2
    ls -la "$home_dir/.local/bin" >&2
    return 1
  fi
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

test_warns_when_another_bob_shadows_the_install() {
  local tmp_dir
  local home_dir
  local bundle_dir
  local other_dir
  local stdout_file
  local stderr_file

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  home_dir="$tmp_dir/home"
  bundle_dir="$tmp_dir/bundle"
  other_dir="$tmp_dir/other-install"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  mkdir -p "$home_dir" "$other_dir"
  make_bundle "$bundle_dir"

  # A second, unrelated `bob` (e.g. a mise shim) earlier on PATH than
  # ~/.local/bin, the way the reported mise/install.sh collision has it.
  printf '#!/usr/bin/env bash\nexit 0\n' >"$other_dir/bob"
  chmod +x "$other_dir/bob"

  (
    cd "$bundle_dir"
    PATH="$other_dir:/usr/bin:/bin" HOME="$home_dir" ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  assert_contains "$stdout_file" "Warning: another \`bob\` is on PATH at $other_dir/bob"
  assert_contains "$stdout_file" "$home_dir/.local/bin/bob"
}

test_no_shadow_warning_when_path_agrees_with_the_install() {
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
    PATH="$home_dir/.local/bin:/usr/bin:/bin" HOME="$home_dir" ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  assert_not_contains "$stdout_file" "is on PATH at"
}

test_no_shadow_warning_when_no_other_bob_on_path() {
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
    PATH="/usr/bin:/bin" HOME="$home_dir" ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  assert_not_contains "$stdout_file" "is on PATH at"
}

test_invokes_installed_binary_directly_for_skills_only_refresh() {
  local tmp_dir
  local home_dir
  local bundle_dir
  local other_dir
  local invocation_log
  local shadow_log
  local stdout_file
  local stderr_file

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  home_dir="$tmp_dir/home"
  bundle_dir="$tmp_dir/bundle"
  other_dir="$tmp_dir/other-install"
  invocation_log="$tmp_dir/invocation.log"
  shadow_log="$tmp_dir/shadow.log"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  mkdir -p "$home_dir" "$other_dir"
  make_bundle "$bundle_dir"

  # A shadowing `bob` earlier on PATH than the just-installed one. If
  # install.sh ever resolved `bob` through PATH instead of invoking
  # $install_binary_path directly, this shadow is the one that would run.
  printf '#!/usr/bin/env bash\nprintf %s "shadow $*" >>"$BOB_STUB_SHADOW_LOG"\nexit 0\n' \
    >"$other_dir/bob"
  chmod +x "$other_dir/bob"

  (
    cd "$bundle_dir"
    PATH="$other_dir:/usr/bin:/bin" HOME="$home_dir" \
      BOB_STUB_INVOCATION_LOG="$invocation_log" \
      BOB_STUB_SHADOW_LOG="$shadow_log" \
      ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  if [ ! -f "$invocation_log" ] || ! grep -Fq "init --skills-only" "$invocation_log"; then
    printf 'expected the just-installed binary to be invoked with init --skills-only\n' >&2
    printf 'stdout:\n' >&2
    cat "$stdout_file" >&2
    printf 'stderr:\n' >&2
    cat "$stderr_file" >&2
    return 1
  fi

  if [ -f "$shadow_log" ]; then
    printf 'expected the PATH-shadowing bob not to be invoked for the skills-only refresh\n' >&2
    cat "$shadow_log" >&2
    return 1
  fi
}

test_never_passes_force_to_skills_only_invocation() {
  local tmp_dir
  local home_dir
  local bundle_dir
  local invocation_log
  local stdout_file
  local stderr_file

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  home_dir="$tmp_dir/home"
  bundle_dir="$tmp_dir/bundle"
  invocation_log="$tmp_dir/invocation.log"
  stdout_file="$tmp_dir/stdout"
  stderr_file="$tmp_dir/stderr"

  mkdir -p "$home_dir"
  make_bundle "$bundle_dir"

  (
    cd "$bundle_dir"
    PATH="/usr/bin:/bin" HOME="$home_dir" \
      BOB_STUB_INVOCATION_LOG="$invocation_log" \
      ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  if [ ! -f "$invocation_log" ]; then
    printf 'expected the skills-only invocation to be logged\n' >&2
    return 1
  fi

  assert_not_contains "$invocation_log" "--force"
}

test_skills_only_success_output_is_not_suppressed() {
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
    PATH="/usr/bin:/bin" HOME="$home_dir" ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  assert_contains "$stdout_file" "created skill: example"
}

test_skills_only_failure_warns_and_does_not_block_install() {
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

  mkdir -p "$home_dir"
  make_bundle "$bundle_dir"

  if (
    cd "$bundle_dir"
    PATH="/usr/bin:/bin" HOME="$home_dir" \
      BOB_STUB_SKILLS_ONLY_EXIT=7 \
      ./install.sh >"$stdout_file" 2>"$stderr_file"
  ); then
    status=0
  else
    status=$?
  fi

  if [ "$status" -ne 0 ]; then
    printf 'expected install.sh to succeed even when the skills-only refresh fails\n' >&2
    printf 'stdout:\n' >&2
    cat "$stdout_file" >&2
    printf 'stderr:\n' >&2
    cat "$stderr_file" >&2
    return 1
  fi

  assert_contains "$stderr_file" "init --skills-only"
  assert_contains "$stderr_file" "Warning"

  if [ ! -f "$home_dir/.local/bin/bob" ]; then
    printf 'expected the binary to still be installed despite the skills-only refresh failure\n' >&2
    return 1
  fi

  if [ ! -f "$home_dir/.local/share/bob/extensions/bob.ts" ]; then
    printf 'expected the extension to still be installed despite the skills-only refresh failure\n' >&2
    return 1
  fi
}

test_replaces_a_running_binary_atomically
test_abort_when_overwrite_prompt_hits_eof
test_trailing_slash_path_entry_counts_as_present
test_empty_path_entry_uses_current_directory
test_warns_when_another_bob_shadows_the_install
test_no_shadow_warning_when_path_agrees_with_the_install
test_no_shadow_warning_when_no_other_bob_on_path
test_invokes_installed_binary_directly_for_skills_only_refresh
test_never_passes_force_to_skills_only_invocation
test_skills_only_success_output_is_not_suppressed
test_skills_only_failure_warns_and_does_not_block_install
