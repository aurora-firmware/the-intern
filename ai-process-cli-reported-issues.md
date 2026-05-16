# ai-team CLI / skill issues

Running log of bugs and friction observed while using the `ai-team` CLI and the
slash-skills that wrap it. New entries at the top.

## 2026-05-16 — `ai-team spec new` assigns duplicate IDs

**Symptom.** Running `ai-team spec new ...` produced a new spec with `id: S-001`
while `project/specs/the-intern-agent-service-architecture.md` already used
`id: S-001`. The CLI did not look at existing IDs when allocating the next one.

**Reproduction.**
```
ai-team spec new --json --author planner --status draft "Bob Service Shell Architecture"
# → {"id": "S-001", "path": ".../bob-service-shell-architecture.md"}
# but project/specs/the-intern-agent-service-architecture.md already has id: S-001
```

**Impact.** Two specs with the same identifier; references like "S-001" become
ambiguous. Required manual frontmatter fixup.

**Suggested fix.** Scan `project/specs/` for the highest existing `S-NNN` in
frontmatter and increment, the same way task IDs are allocated.

## 2026-05-16 — `new-spec` skill documents an out-of-date CLI signature

**Symptom.** The `new-spec` skill prescribes
`ai-team spec new --json --title "<title>" --description "<description>" ...`.
The current CLI rejects `--title` (the title is a positional argument) and does
not accept `--description` at all (description content is written into the spec
body by hand).

**Reproduction.**
```
ai-team spec new --json --title "X" --description "Y"
# → Error: No such option: --title
ai-team spec new --help
# shows: ai-team spec new [OPTIONS] TITLE  with only --author/--status/--json
```

**Impact.** The skill's first attempt always fails; the caller has to inspect
`--help` and reconstruct the right invocation. The skill should also be told
that `description` is purely an input to the spec body, not a CLI flag.

**Suggested fix.** Update `.claude/skills/new-spec/SKILL.md` step 2 to use
`ai-team spec new --json [--author X] [--status Y] "<title>"` and to instruct
the caller to write the description into the spec body during step 4.
