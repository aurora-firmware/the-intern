#!/usr/bin/env bash
# Run cargo in the-intern/service/ with the isolated XDG directories from
# scripts/dev-env.sh, so tests never reach a bob installed and running on
# this machine. Every BOB_* variable is then cleared: the socket paths are for
# a dev `bob`, not for tests, and inherited bob config overrides (from the
# shell or .env.local) leak into the workers tests spawn and change results.
# Arguments pass straight through to cargo:
#
#   ./scripts/cargo-dev.sh test --workspace
#   ./scripts/cargo-dev.sh test -p bob --test non_serve

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/dev-env.sh
source "$repo_root/scripts/dev-env.sh"
while IFS= read -r var; do unset "$var"; done < <(compgen -e | grep '^BOB_')

cd "$repo_root/the-intern/service"
exec cargo "$@"
