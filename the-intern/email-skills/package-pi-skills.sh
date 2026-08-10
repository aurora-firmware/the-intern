#!/usr/bin/env bash
# Generates the pi packaging target (.pi/skills/<name>/) from the canonical,
# vendor-neutral skill source (skills/<name>/). See T-153.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
canonical_dir="$package_dir/skills"
pi_skills_dir="$package_dir/.pi/skills"

skill_names=(himalaya email-triage)

for skill_name in "${skill_names[@]}"; do
  source_dir="$canonical_dir/$skill_name"
  dest_dir="$pi_skills_dir/$skill_name"

  if [ ! -d "$source_dir" ]; then
    echo "error: canonical skill source not found: $source_dir" >&2
    exit 1
  fi

  mkdir -p "$pi_skills_dir"
  cp -r "$source_dir" "$dest_dir"
done
