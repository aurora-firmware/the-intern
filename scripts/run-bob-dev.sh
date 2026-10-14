#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/dev-env.sh
source "$repo_root/scripts/dev-env.sh"

echo "Bob dev home: $BOB_DEV_HOME"
echo "Bob runtime directory: $BOB_TEST_RUNTIME_DIR"
echo "Bob extension: $BOB_EXTENSION_PATH"
echo "Use scripts/bob-dev.sh <command> from another terminal."

exec "$repo_root/scripts/bob-dev.sh" serve "$@"
