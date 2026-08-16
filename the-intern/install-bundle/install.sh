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

path_contains_dir() {
  local target="$1"
  local entry=""
  local normalized_entry=""
  local normalized_target="$target"
  local remaining_path="${PATH-}"
  local path_entries=()

  while [ "$normalized_target" != "/" ] && [ "${normalized_target%/}" != "$normalized_target" ]; do
    normalized_target="${normalized_target%/}"
  done

  while :; do
    if [[ "$remaining_path" == *:* ]]; then
      path_entries+=("${remaining_path%%:*}")
      remaining_path="${remaining_path#*:}"
      continue
    fi

    path_entries+=("$remaining_path")
    break
  done

  for entry in "${path_entries[@]}"; do
    normalized_entry="$entry"
    if [ -z "$normalized_entry" ]; then
      normalized_entry="$PWD"
    else
      while [ "$normalized_entry" != "/" ] && [ "${normalized_entry%/}" != "$normalized_entry" ]; do
        normalized_entry="${normalized_entry%/}"
      done
    fi

    if [ "$normalized_entry" = "$normalized_target" ]; then
      return 0
    fi
  done

  return 1
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
pi_install_guide="https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md"

if [ -e "$install_binary_path" ]; then
  printf 'A bob binary already exists at %s. Overwrite? [y/N] ' "$install_binary_path"
  if ! read -r overwrite_response; then
    printf 'Install aborted: no input available for overwrite confirmation.\n' >&2
    exit 1
  fi
  case "$overwrite_response" in
    y | Y)
      ;;
    *)
      printf 'Install aborted. No changes were made.\n'
      exit 1
      ;;
  esac
fi

mkdir -p "$(dirname "$install_binary_path")"
mkdir -p "$(dirname "$install_extension_path")"

cp "$bundle_binary_path" "$install_binary_path"
chmod +x "$install_binary_path"
cp "$bundle_extension_path" "$install_extension_path"

if ! command -v pi >/dev/null 2>&1; then
  printf 'Warning: `pi` was not found on PATH. Install it first: %s\n' "$pi_install_guide"
fi

if ! path_contains_dir "${HOME}/.local/bin"; then
  printf 'Warning: %s is not on PATH.\n' "${HOME}/.local/bin"
fi

printf 'Installed bob binary: %s\n' "$install_binary_path"
printf 'Installed bob extension: %s\n' "$install_extension_path"
