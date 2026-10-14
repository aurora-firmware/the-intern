#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
service_dir="$repo_root/the-intern/service"

if ! command -v pi >/dev/null 2>&1; then
  echo "error: pi must be available on PATH" >&2
  exit 1
fi

# shellcheck source=scripts/dev-env.sh
source "$repo_root/scripts/dev-env.sh"

exec cargo run --manifest-path "$service_dir/Cargo.toml" -p bob -- "$@"
