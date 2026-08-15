#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bundle_binary_path="${script_dir}/bob"
bundle_extension_path="${script_dir}/bob.ts"

require_bundle_file() {
  local path="$1"

  if [ ! -f "$path" ]; then
    printf 'Missing bundle file: %s\n' "$path" >&2
    exit 1
  fi
}

resolve_extension_path() {
  if [ "${XDG_DATA_HOME+x}" = x ]; then
    if [ -z "$XDG_DATA_HOME" ]; then
      :
    elif [[ "$XDG_DATA_HOME" = /* ]]; then
      printf '%s/bob/extensions/bob.ts\n' "$XDG_DATA_HOME"
      return 0
    else
      printf 'Error: XDG_DATA_HOME must be an absolute path when set: %s\n' "$XDG_DATA_HOME" >&2
      exit 1
    fi
  fi

  if [ "$platform" = "darwin" ]; then
    printf '%s/Library/Application Support/bob/extensions/bob.ts\n' "$HOME"
  else
    printf '%s/.local/share/bob/extensions/bob.ts\n' "$HOME"
  fi
}

platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m | tr '[:upper:]' '[:lower:]')"

case "${platform}-${arch}" in
  linux-x86_64 | darwin-arm64)
    ;;
  *)
    printf 'Unsupported platform: %s-%s\n' "$platform" "$arch" >&2
    exit 1
    ;;
esac

: "${HOME:?HOME must be set}"

require_bundle_file "$bundle_binary_path"
require_bundle_file "$bundle_extension_path"

install_binary_path="${HOME}/.local/bin/bob"
install_extension_path="$(resolve_extension_path)"

mkdir -p "$(dirname "$install_binary_path")"
mkdir -p "$(dirname "$install_extension_path")"

cp "$bundle_binary_path" "$install_binary_path"
chmod +x "$install_binary_path"
cp "$bundle_extension_path" "$install_extension_path"

printf 'Installed bob binary: %s\n' "$install_binary_path"
printf 'Installed bob extension: %s\n' "$install_extension_path"
