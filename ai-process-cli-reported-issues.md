# ai-team CLI / skill issues

Running log of bugs and friction observed while using the `ai-team` CLI and the
slash-skills that wrap it. New entries at the top.

## 2026-05-19 — `new-spec` skill uses unsupported CLI flags

**Symptom.** The `new-spec` skill prescribes
`ai-team spec new --json --title "<title>" --description "<description>" ...`.
The current CLI rejects `--title` (title is positional) and has no
`--description` option.

**Reproduction.**
```
ai-team spec new --json --title "x" --description "y" --author planner --status draft
# → Error: No such option: --title
ai-team spec new --help
# shows: ai-team spec new [OPTIONS] TITLE; options are --author, --status, --json only
```

**Impact.** Same shape as the 2026-05-18 `new-bug` issue: the skill's prescribed
command fails on first call. The caller has to inspect `--help`, drop `--title`
to positional, and then fill the `description` directly into the created spec
file because the CLI does not accept it.

**Suggested fix.** Update `.claude/skills/new-spec/SKILL.md` so the command
construction uses `"<title>"` as positional and removes `--description`. Either
have the skill seed the spec body from the description after creation (current
workaround) or add a `--description` option to the CLI.

## 2026-05-19 — `ai-team spec new` duplicate-ID bug recurs

Same as the 2026-05-16 entry below; hit again today.

```
ai-team spec new --json --author planner --status draft "JS extension for pi-agent event forwarding"
# → {"id": "S-001", "path": ".../js-extension-for-pi-agent-event-forwarding.md"}
# project/specs/ already contains the-intern-agent-service-architecture.md (id S-001)
# and bob-service-shell-architecture.md (id S-002).
```

Manual fix: rewrote the new file's frontmatter `id` to `S-003`. The 2026-05-16
entry's suggested fix still stands and has not been applied.

## 2026-05-18 — `new-bug` skill uses unsupported CLI flags

**Symptom.** The `new-bug` skill prescribes
`ai-team bug new --json --title "<title>" --description "<description>" ...`.
The current CLI rejects `--title` (title is positional) and has no
`--description` option.

**Reproduction.**
```
ai-team bug new --json --title "x" --description "y" --severity high
# → Error: No such option: --title
ai-team bug new --help
# shows: ai-team bug new [OPTIONS] TITLE
```

**Impact.** First-call bug creation fails whenever the skill is followed
literally. Callers must inspect help output and manually adapt.

**Suggested fix.** Update `.claude/skills/new-bug/SKILL.md` to use positional
`TITLE` and remove `--description` from the command construction step.

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
