#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
service_dir="$repo_root/the-intern/service"
dev_home="${BOB_DEV_HOME:-$repo_root/.tmp/bob-dev}"
extension_path="$repo_root/the-intern/pi-extension/bob.ts"

if ! command -v pi >/dev/null 2>&1; then
  echo "error: pi must be available on PATH" >&2
  exit 1
fi

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$dev_home/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$dev_home/data}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$dev_home/state}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$dev_home/xdg-runtime}"
export BOB_TEST_RUNTIME_DIR="${BOB_TEST_RUNTIME_DIR:-$dev_home/run}"
export BOB_ADMIN_SOCK_PATH="${BOB_ADMIN_SOCK_PATH:-$BOB_TEST_RUNTIME_DIR/admin.sock}"
export BOB_EXTENSION_SOCK_PATH="${BOB_EXTENSION_SOCK_PATH:-$BOB_TEST_RUNTIME_DIR/extension.sock}"
export BOB_EXTENSION_PATH="${BOB_EXTENSION_PATH:-$extension_path}"

install -d -m 700 "$BOB_TEST_RUNTIME_DIR" "$XDG_RUNTIME_DIR"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

exec cargo run --manifest-path "$service_dir/Cargo.toml" -p bob -- "$@"
