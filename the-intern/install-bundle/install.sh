#!/usr/bin/env bash

set -euo pipefail

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

echo "install.sh is not implemented yet" >&2
exit 1
