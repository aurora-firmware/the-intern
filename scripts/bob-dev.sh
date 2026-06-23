#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
service_dir="$repo_root/the-intern/service"

if ! command -v pi >/dev/null 2>&1; then
  echo "error: pi must be available on PATH" >&2
  exit 1
fi

export BOB_TEST_RUNTIME_DIR="${BOB_TEST_RUNTIME_DIR:-$repo_root/.tmp/bob-dev}"
export BOB_ADMIN_SOCK_PATH="${BOB_ADMIN_SOCK_PATH:-$BOB_TEST_RUNTIME_DIR/admin.sock}"
export BOB_EXTENSION_SOCK_PATH="${BOB_EXTENSION_SOCK_PATH:-$BOB_TEST_RUNTIME_DIR/extension.sock}"

# Point bob at the repo-local config that admits the chat identity, so the
# policy pre-flight gate does not reject `bob chat`. Override by setting
# BOB_DEV_CONFIG_HOME, or edit scripts/bob-dev-config/bob/config.toml.
export XDG_CONFIG_HOME="${BOB_DEV_CONFIG_HOME:-$repo_root/scripts/bob-dev-config}"

mkdir -p "$BOB_TEST_RUNTIME_DIR"

cd "$service_dir"
exec cargo run -p bob -- "$@"
