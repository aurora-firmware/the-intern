#!/usr/bin/env bash
# Run cargo in the-intern/service/ with the isolated dev environment from
# scripts/dev-env.sh, so tests never reach a bob installed and running on
# this machine. Arguments pass straight through to cargo:
#
#   ./scripts/cargo-dev.sh test --workspace
#   ./scripts/cargo-dev.sh test -p bob --test non_serve

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/dev-env.sh
source "$repo_root/scripts/dev-env.sh"

cd "$repo_root/the-intern/service"
exec cargo "$@"
