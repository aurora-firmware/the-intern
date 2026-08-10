#!/usr/bin/env bash
# Generates the Claude Code packaging target (claude/skills/<name>/) from the
# canonical, vendor-neutral skill source (skills/<name>/). See T-163.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
canonical_dir="$package_dir/skills"
claude_dir="$package_dir/claude"
claude_skills_dir="$claude_dir/skills"
plugin_manifest_dir="$claude_dir/.claude-plugin"

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

# Plugin manifest and layout only (S-011 Design Principles): this carries no
# skill body content, so it is script-owned static metadata rather than
# derived from any skill's canonical source. Mirrors the shape of
# the-intern/bob-companion/claude/.claude-plugin/plugin.json with this
# package's own name and description.
mkdir -p "$plugin_manifest_dir"
cat > "$plugin_manifest_dir/plugin.json" <<'EOF'
{
  "name": "email-skills",
  "description": "Packages the himalaya, email-triage, and worklog skills as a Claude Code plugin, generated from this repository's canonical email-skills source.",
  "version": "0.1.0",
  "author": {
    "name": "aurora-firmware"
  },
  "homepage": "https://github.com/aurora-firmware/the-intern",
  "repository": "https://github.com/aurora-firmware/the-intern",
  "license": "UNLICENSED",
  "keywords": ["email", "himalaya", "email-triage", "worklog", "the-intern", "pi-agent"]
}
EOF
