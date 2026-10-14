# Development environment for a source checkout of bob. Source it; do not run it:
#
#   source scripts/dev-env.sh
#
# It points every directory bob resolves — XDG config/data/state/runtime and
# both sockets — at a dev home under the gitignored `.tmp/`, so a dev `bob`
# and every `cargo test` run stay isolated from a `bob serve` installed and
# running on the same machine. The variables are always overwritten rather
# than defaulted: a desktop session sets `XDG_RUNTIME_DIR` to the real
# `/run/user/<uid>`, and keeping it would let the dev bob find the live
# service's sockets.
#
# Personal overrides go in `.env.local` at the repo root (gitignored), as
# shell `KEY=value` lines. It is sourced first, so it can set `BOB_DEV_HOME`
# to move the dev home, or add other variables (`RUST_LOG`, a `PATH` entry for
# a specific `pi` build, `BOB_*` service knobs). It cannot override the
# directory and socket variables below; move `BOB_DEV_HOME` instead.

# The path of this file while it is being sourced: `BASH_SOURCE` in bash; zsh
# does not set it, so use its `%x` prompt expansion there (inside `eval`, which
# bash never parses on this branch). Any other shell cannot locate the file.
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  _bob_dev_env_file="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  eval '_bob_dev_env_file="${(%):-%x}"'
else
  echo "dev-env: source this file from bash or zsh" >&2
  return 1 2>/dev/null || exit 1
fi
_bob_dev_repo_root="$(cd -- "$(dirname -- "$_bob_dev_env_file")/.." && pwd)"
unset _bob_dev_env_file

if [[ -f "$_bob_dev_repo_root/.env.local" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$_bob_dev_repo_root/.env.local"
  set +a
fi

export BOB_DEV_HOME="${BOB_DEV_HOME:-$_bob_dev_repo_root/.tmp/bob-dev}"
export XDG_CONFIG_HOME="$BOB_DEV_HOME/config"
export XDG_DATA_HOME="$BOB_DEV_HOME/data"
export XDG_STATE_HOME="$BOB_DEV_HOME/state"
export XDG_RUNTIME_DIR="$BOB_DEV_HOME/xdg-runtime"
export BOB_TEST_RUNTIME_DIR="$BOB_DEV_HOME/run"
export BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock"
export BOB_EXTENSION_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/extension.sock"
export BOB_EXTENSION_PATH="${BOB_EXTENSION_PATH:-$_bob_dev_repo_root/the-intern/pi-extension/bob.ts}"

# A Unix socket path is limited to 108 bytes (104 on macOS).
if ((${#BOB_EXTENSION_SOCK_PATH} > 100)); then
  echo "dev-env: socket path too long (${#BOB_EXTENSION_SOCK_PATH} bytes): $BOB_EXTENSION_SOCK_PATH" >&2
  echo "dev-env: set a shorter BOB_DEV_HOME in .env.local" >&2
  return 1 2>/dev/null || exit 1
fi

install -d -m 700 "$BOB_TEST_RUNTIME_DIR" "$XDG_RUNTIME_DIR"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

unset _bob_dev_repo_root
