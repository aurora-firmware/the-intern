#!/usr/bin/env bash
# Generates the Claude Code packaging target (claude/skills/<name>/) from the
# canonical, vendor-neutral skill source (skills/<name>/). See T-163.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
canonical_dir="$package_dir/skills"
claude_skills_dir="$package_dir/claude/skills"

skill_names=(himalaya email-triage worklog)

for skill_name in "${skill_names[@]}"; do
  source_dir="$canonical_dir/$skill_name"
  dest_dir="$claude_skills_dir/$skill_name"

  if [ ! -d "$source_dir" ]; then
    echo "error: canonical skill source not found: $source_dir" >&2
    exit 1
  fi

  # Regenerate from scratch: a stray or stale file left over in a previous
  # generated tree must never survive a re-run once its canonical source is
  # gone.
  rm -rf "$dest_dir"
  mkdir -p "$claude_skills_dir"
  cp -r "$source_dir" "$dest_dir"
done
