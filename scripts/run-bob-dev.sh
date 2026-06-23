#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${BOB_TEST_RUNTIME_DIR:-$repo_root/.tmp/bob-dev}"

echo "Bob runtime directory: $runtime_dir"
echo "Use scripts/bob-dev.sh <command> from another terminal."

exec "$repo_root/scripts/bob-dev.sh" serve "$@"
