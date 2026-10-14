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
  # install.sh does not suppress it, writes placeholder entries (hidden one
  # included) into the resolved skill path so tests can tell what the install
  # left behind, and exits with
  # $BOB_STUB_SKILLS_ONLY_EXIT (default 0) for that subcommand so tests can
  # force a refresh failure without touching install.sh itself.
  cat >"$dir/bob" <<'STUB'
#!/usr/bin/env bash
if [ -n "${BOB_STUB_INVOCATION_LOG:-}" ]; then
  printf '%s\n' "$*" >>"$BOB_STUB_INVOCATION_LOG"
fi
if [ "${1-}" = "init" ] && [ "${2-}" = "--skills-only" ]; then
  skills_dir="${XDG_DATA_HOME:-$HOME/.local/share}/bob/skills"
  mkdir -p "$skills_dir/stub-skill"
  printf 'stub\n' >"$skills_dir/stub-skill/SKILL.md"
  printf 'stub\n' >"$skills_dir/.stub-hidden"
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
    PATH="/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" ./install.sh >"$stdout_file" 2>"$stderr_file"
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
    PATH="/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" ./install.sh </dev/null >"$stdout_file" 2>"$stderr_file"
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
    PATH="$home_dir/.local/bin/:/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" ./install.sh >"$stdout_file" 2>"$stderr_file"
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
    PATH=":/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" "$bundle_dir/install.sh" >"$stdout_file" 2>"$stderr_file"
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
    PATH="$other_dir:/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" ./install.sh >"$stdout_file" 2>"$stderr_file"
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
    PATH="$home_dir/.local/bin:/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" ./install.sh >"$stdout_file" 2>"$stderr_file"
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
    PATH="/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" ./install.sh >"$stdout_file" 2>"$stderr_file"
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
    PATH="$other_dir:/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" \
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

test_skills_only_invocation_carries_no_flags_beyond_skills_only() {
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
    PATH="/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" \
      BOB_STUB_INVOCATION_LOG="$invocation_log" \
      ./install.sh >"$stdout_file" 2>"$stderr_file"
  )

  if [ ! -f "$invocation_log" ]; then
    printf 'expected the skills-only invocation to be logged\n' >&2
    return 1
  fi

  assert_not_contains "$invocation_log" "--force"
  assert_contains "$invocation_log" "init --skills-only"
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
    PATH="/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" ./install.sh >"$stdout_file" 2>"$stderr_file"
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
    PATH="/usr/bin:/bin" HOME="$home_dir" XDG_DATA_HOME="$home_dir/.local/share" \
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

# Runs the bundle's install.sh in an isolated HOME with an explicit
# XDG_DATA_HOME. Expects scenario_* globals; stdin comes from
# $scenario_input (empty means no input at all) and any arguments are passed
# to install.sh. Sets $install_status.
setup_scenario() {
  scenario_tmp="$(mktemp -d)"
  scenario_home="$scenario_tmp/home"
  scenario_bundle="$scenario_tmp/bundle"
  scenario_stdout="$scenario_tmp/stdout"
  scenario_stderr="$scenario_tmp/stderr"
  scenario_skills="$scenario_home/.local/share/bob/skills"
  mkdir -p "$scenario_home"
  make_bundle "$scenario_bundle"
}

run_scenario_install() {
  local input="$1"
  shift

  install_status=0
  if [ -n "$input" ]; then
    (
      cd "$scenario_bundle"
      printf '%s\n' "$input" | PATH="/usr/bin:/bin" HOME="$scenario_home" \
        XDG_DATA_HOME="$scenario_home/.local/share" ./install.sh "$@" \
        >"$scenario_stdout" 2>"$scenario_stderr"
    ) || install_status=$?
  else
    (
      cd "$scenario_bundle"
      PATH="/usr/bin:/bin" HOME="$scenario_home" \
        XDG_DATA_HOME="$scenario_home/.local/share" ./install.sh "$@" \
        </dev/null >"$scenario_stdout" 2>"$scenario_stderr"
    ) || install_status=$?
  fi
}

assert_install_failed() {
  if [ "$install_status" -eq 0 ]; then
    printf 'expected install.sh to exit non-zero\n' >&2
    cat "$scenario_stdout" >&2
    exit 1
  fi
}

assert_install_succeeded() {
  if [ "$install_status" -ne 0 ]; then
    printf 'expected install.sh to succeed, got %s\n' "$install_status" >&2
    cat "$scenario_stdout" "$scenario_stderr" >&2
    exit 1
  fi
}

assert_nothing_installed() {
  if [ -e "$scenario_home/.local/bin/bob" ]; then
    printf 'expected no binary to be written\n' >&2
    exit 1
  fi
  if [ -e "$scenario_home/.local/share/bob/extensions/bob.ts" ]; then
    printf 'expected no extension to be written\n' >&2
    exit 1
  fi
}

test_prompts_and_aborts_when_only_skills_exist_and_answer_is_no() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills/example"
  printf 'edited\n' >"$scenario_skills/example/SKILL.md"

  run_scenario_install n

  assert_install_failed
  assert_contains "$scenario_stdout" "Overwrite? [y/N]"
  assert_contains "$scenario_stdout" "The existing skills will be replaced"
  assert_nothing_installed
  assert_contains "$scenario_skills/example/SKILL.md" "edited"
}

test_aborts_when_only_skills_exist_and_no_input_is_available() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills/example"

  run_scenario_install ""

  assert_install_failed
  assert_contains "$scenario_stderr" "no input available for overwrite confirmation"
  assert_nothing_installed
}

test_installs_when_only_skills_exist_and_answer_is_yes() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills/example"

  run_scenario_install y

  assert_install_succeeded
  assert_contains "$scenario_stdout" "The existing skills will be replaced"
  [ -f "$scenario_home/.local/bin/bob" ] || { printf 'expected binary installed\n' >&2; exit 1; }
}

test_dotfile_alone_in_skill_path_triggers_the_prompt() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills"
  : >"$scenario_skills/.hidden"

  run_scenario_install n

  assert_install_failed
  assert_contains "$scenario_stdout" "Overwrite? [y/N]"
  assert_nothing_installed
}

test_dangling_symlink_at_skill_path_triggers_the_prompt() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$(dirname "$scenario_skills")"
  ln -s "$scenario_tmp/does-not-exist" "$scenario_skills"

  run_scenario_install n

  assert_install_failed
  assert_contains "$scenario_stdout" "Overwrite? [y/N]"
  assert_nothing_installed
}

test_empty_skill_directory_installs_without_prompting() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills"

  run_scenario_install ""

  assert_install_succeeded
  assert_not_contains "$scenario_stdout" "Overwrite?"
  assert_not_contains "$scenario_stdout" "Warning: a different bob"
}

test_fresh_install_does_not_prompt() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN

  run_scenario_install ""

  assert_install_succeeded
  assert_not_contains "$scenario_stdout" "Overwrite?"
}

test_different_installed_binary_prints_version_warning_before_prompt() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_home/.local/bin"
  printf 'older bob\n' >"$scenario_home/.local/bin/bob"

  run_scenario_install n

  assert_install_failed
  assert_contains "$scenario_stdout" "a different bob version is installed"
  assert_contains "$scenario_stdout" "documentation skill"
  assert_contains "$scenario_stdout" "local edits"
  local warning_line prompt_line
  warning_line="$(grep -n 'a different bob version is installed' "$scenario_stdout" | head -1 | cut -d: -f1)"
  prompt_line="$(grep -n 'Overwrite? \[y/N\]' "$scenario_stdout" | head -1 | cut -d: -f1)"
  if [ "$warning_line" -gt "$prompt_line" ]; then
    printf 'expected the warning before the prompt\n' >&2
    exit 1
  fi
  assert_contains "$scenario_home/.local/bin/bob" "older bob"
}

test_unreadable_installed_binary_counts_as_different() {
  setup_scenario
  trap 'chmod 600 "$scenario_home/.local/bin/bob" 2>/dev/null; rm -rf "$scenario_tmp"' RETURN
  if [ "$(id -u)" -eq 0 ]; then
    return 0
  fi
  mkdir -p "$scenario_home/.local/bin"
  cp "$scenario_bundle/bob" "$scenario_home/.local/bin/bob"
  chmod 000 "$scenario_home/.local/bin/bob"

  run_scenario_install n

  assert_install_failed
  assert_contains "$scenario_stdout" "a different bob version is installed"
}

test_identical_binaries_prompt_without_a_warning() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_home/.local/bin"
  cp "$scenario_bundle/bob" "$scenario_home/.local/bin/bob"

  run_scenario_install n

  assert_install_failed
  assert_contains "$scenario_stdout" "Overwrite? [y/N]"
  assert_not_contains "$scenario_stdout" "Warning:"
}

test_dash_y_proceeds_without_prompting_and_still_warns() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_home/.local/bin" "$scenario_skills/example"
  printf 'older bob\n' >"$scenario_home/.local/bin/bob"

  run_scenario_install "" -y

  assert_install_succeeded
  assert_not_contains "$scenario_stdout" "Overwrite?"
  assert_contains "$scenario_stdout" "a different bob version is installed"
  if ! cmp -s "$scenario_bundle/bob" "$scenario_home/.local/bin/bob"; then
    printf 'expected the bundled binary to be installed\n' >&2
    exit 1
  fi
}

test_dash_y_with_only_skills_prints_skills_warning() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills/example"

  run_scenario_install "" -y

  assert_install_succeeded
  assert_contains "$scenario_stdout" "The existing skills will be replaced"
  assert_not_contains "$scenario_stdout" "Overwrite?"
}

test_default_skill_path_is_used_when_xdg_data_home_is_unset() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  local default_skills
  case "$(uname -s)" in
    Darwin) default_skills="$scenario_home/Library/Application Support/bob/skills" ;;
    *) default_skills="$scenario_home/.local/share/bob/skills" ;;
  esac
  mkdir -p "$default_skills/example"

  install_status=0
  (
    cd "$scenario_bundle"
    env -u XDG_DATA_HOME PATH="/usr/bin:/bin" HOME="$scenario_home" ./install.sh \
      </dev/null >"$scenario_stdout" 2>"$scenario_stderr"
  ) || install_status=$?

  assert_install_failed
  assert_contains "$scenario_stderr" "no input available for overwrite confirmation"
}

test_xdg_data_home_skill_path_is_checked() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_tmp/xdg/bob/skills/example"

  install_status=0
  (
    cd "$scenario_bundle"
    PATH="/usr/bin:/bin" HOME="$scenario_home" XDG_DATA_HOME="$scenario_tmp/xdg" ./install.sh \
      </dev/null >"$scenario_stdout" 2>"$scenario_stderr"
  ) || install_status=$?

  assert_install_failed
  assert_contains "$scenario_stderr" "no input available for overwrite confirmation"
}

test_install_leaves_exactly_what_skills_only_wrote() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills/stale-skill" "$scenario_skills/stub-skill"
  printf 'old\n' >"$scenario_skills/stale-skill/SKILL.md"
  printf 'edited\n' >"$scenario_skills/stub-skill/SKILL.md"
  printf 'old\n' >"$scenario_skills/stub-skill/extra.md"
  : >"$scenario_skills/.stale-hidden"

  run_scenario_install "" -y

  assert_install_succeeded
  local listing
  listing="$(cd "$scenario_skills" && find . -mindepth 1 | LC_ALL=C sort | tr '\n' ' ')"
  if [ "$listing" != "./.stub-hidden ./stub-skill ./stub-skill/SKILL.md " ]; then
    printf 'unexpected skill path contents: %s\n' "$listing" >&2
    exit 1
  fi
  assert_contains "$scenario_skills/stub-skill/SKILL.md" "stub"
}

test_same_version_reinstall_still_replaces_the_skill_folder() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_home/.local/bin" "$scenario_skills/stub-skill"
  cp "$scenario_bundle/bob" "$scenario_home/.local/bin/bob"
  printf 'edited\n' >"$scenario_skills/stub-skill/SKILL.md"
  : >"$scenario_skills/stub-skill/local-note.md"

  run_scenario_install y

  assert_install_succeeded
  assert_contains "$scenario_skills/stub-skill/SKILL.md" "stub"
  [ ! -e "$scenario_skills/stub-skill/local-note.md" ] || { printf 'expected local file removed\n' >&2; exit 1; }
}

test_skill_path_symlink_is_replaced_without_touching_its_target() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_tmp/outside" "$(dirname "$scenario_skills")"
  printf 'precious\n' >"$scenario_tmp/outside/keep.txt"
  ln -s "$scenario_tmp/outside" "$scenario_skills"

  run_scenario_install "" -y

  assert_install_succeeded
  assert_contains "$scenario_tmp/outside/keep.txt" "precious"
  [ ! -e "$scenario_tmp/outside/.stub-hidden" ] || { printf 'expected nothing written through the link\n' >&2; exit 1; }
  [ ! -L "$scenario_skills" ] || { printf 'expected the link replaced by a directory\n' >&2; exit 1; }
  [ -f "$scenario_skills/stub-skill/SKILL.md" ] || { printf 'expected skills installed\n' >&2; exit 1; }
}

test_symlink_inside_skill_path_is_removed_without_following_it() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_tmp/outside/sub" "$scenario_skills"
  printf 'precious\n' >"$scenario_tmp/outside/keep.txt"
  printf 'precious\n' >"$scenario_tmp/outside/sub/deep.txt"
  ln -s "$scenario_tmp/outside" "$scenario_skills/escape"
  ln -s "$scenario_tmp/outside/sub" "$scenario_skills/.hidden-escape"

  run_scenario_install "" -y

  assert_install_succeeded
  assert_contains "$scenario_tmp/outside/keep.txt" "precious"
  assert_contains "$scenario_tmp/outside/sub/deep.txt" "precious"
  [ ! -L "$scenario_skills/escape" ] || { printf 'expected inner link removed\n' >&2; exit 1; }
  [ ! -L "$scenario_skills/.hidden-escape" ] || { printf 'expected hidden inner link removed\n' >&2; exit 1; }
}

test_relative_skill_path_is_never_emptied() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_bundle/relhome/.local/share/bob/skills/keep"
  printf 'mine\n' >"$scenario_bundle/relhome/.local/share/bob/skills/keep/SKILL.md"

  install_status=0
  (
    cd "$scenario_bundle"
    env -u XDG_DATA_HOME PATH="/usr/bin:/bin" HOME="relhome" ./install.sh -y \
      </dev/null >"$scenario_stdout" 2>"$scenario_stderr"
  ) || install_status=$?

  assert_install_succeeded
  assert_contains "$scenario_bundle/relhome/.local/share/bob/skills/keep/SKILL.md" "mine"
  assert_contains "$scenario_stderr" "skills may be missing"
}

test_skill_step_failure_warns_about_missing_skills_and_keeps_the_rest() {
  setup_scenario
  trap 'rm -rf "$scenario_tmp"' RETURN
  mkdir -p "$scenario_skills/old"

  install_status=0
  (
    cd "$scenario_bundle"
    PATH="/usr/bin:/bin" HOME="$scenario_home" XDG_DATA_HOME="$scenario_home/.local/share" \
      BOB_STUB_SKILLS_ONLY_EXIT=7 ./install.sh -y </dev/null >"$scenario_stdout" 2>"$scenario_stderr"
  ) || install_status=$?

  assert_install_succeeded
  assert_contains "$scenario_stderr" "skills may be missing"
  assert_contains "$scenario_stderr" "scheduled jobs"
  assert_contains "$scenario_stderr" "Rerun install.sh"
  [ -f "$scenario_home/.local/bin/bob" ] || { printf 'expected binary kept\n' >&2; exit 1; }
  [ -f "$scenario_home/.local/share/bob/extensions/bob.ts" ] || { printf 'expected extension kept\n' >&2; exit 1; }
}

test_replaces_a_running_binary_atomically
test_abort_when_overwrite_prompt_hits_eof
test_trailing_slash_path_entry_counts_as_present
test_empty_path_entry_uses_current_directory
test_warns_when_another_bob_shadows_the_install
test_no_shadow_warning_when_path_agrees_with_the_install
test_no_shadow_warning_when_no_other_bob_on_path
test_invokes_installed_binary_directly_for_skills_only_refresh
test_skills_only_invocation_carries_no_flags_beyond_skills_only
test_skills_only_success_output_is_not_suppressed
test_skills_only_failure_warns_and_does_not_block_install
test_prompts_and_aborts_when_only_skills_exist_and_answer_is_no
test_aborts_when_only_skills_exist_and_no_input_is_available
test_installs_when_only_skills_exist_and_answer_is_yes
test_dotfile_alone_in_skill_path_triggers_the_prompt
test_dangling_symlink_at_skill_path_triggers_the_prompt
test_empty_skill_directory_installs_without_prompting
test_fresh_install_does_not_prompt
test_different_installed_binary_prints_version_warning_before_prompt
test_unreadable_installed_binary_counts_as_different
test_identical_binaries_prompt_without_a_warning
test_dash_y_proceeds_without_prompting_and_still_warns
test_dash_y_with_only_skills_prints_skills_warning
test_default_skill_path_is_used_when_xdg_data_home_is_unset
test_xdg_data_home_skill_path_is_checked
test_install_leaves_exactly_what_skills_only_wrote
test_same_version_reinstall_still_replaces_the_skill_folder
test_skill_path_symlink_is_replaced_without_touching_its_target
test_symlink_inside_skill_path_is_removed_without_following_it
test_relative_skill_path_is_never_emptied
test_skill_step_failure_warns_about_missing_skills_and_keeps_the_rest
