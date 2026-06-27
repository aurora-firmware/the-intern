#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dev_home="${BOB_DEV_HOME:-$repo_root/.tmp/bob-dev}"
runtime_dir="${BOB_TEST_RUNTIME_DIR:-$dev_home/run}"

echo "Bob dev home: $dev_home"
echo "Bob runtime directory: $runtime_dir"
echo "Bob extension: ${BOB_EXTENSION_PATH:-$repo_root/the-intern/extensions/bob.ts}"
echo "Use scripts/bob-dev.sh <command> from another terminal."

exec "$repo_root/scripts/bob-dev.sh" serve "$@"
