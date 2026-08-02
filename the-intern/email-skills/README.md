# Email Skills Package

This package ships the two pi-agent skills S-010 defines — `himalaya` (a
generic CLI-reference skill) and `email-triage` (the triage policy skill) — as
a versioned, reviewable product artifact, separate from
`the-intern/bob-companion/claude` (Claude Code dev-tooling for operating
`bob`) and from this repository's own `.claude/skills` (this repository's
AI-team process tooling). Neither of those is where pi-agent discovers its
runtime skills; this package is.

## Verified skill discovery path and invocation form

pi-agent auto-discovers skills relative to the session's working directory
(`cwd`), mirroring its global `~/.pi/agent/skills/<name>/SKILL.md` layout:

```
.pi/skills/<name>/SKILL.md
```

This is the layout every skill file under this package uses. It was verified
against the installed `pi --version` **0.80.3** with a throwaway probe skill
placed at `.pi/skills/probe-marker/SKILL.md` in a scratch copy of this
package, using its directory as `pi`'s `cwd`. The full transcript is recorded
in T-131's Work Log.

**Invocation form.** `pi`'s default mode is an interactive `ink` TUI that
needs a real TTY, so verification (and later manual checks against this
package) uses the non-interactive print mode:

```
pi --print --approve "<prompt>"
# short form:
pi -p -a "<prompt>"
```

`--approve`/`-a` ("trust project-local files for this run") is required, not
optional: a bare `pi -p "<prompt>"` run from this package's directory never
surfaced the probe skill (confirmed across repeated runs), because pi does
not load project-local skills, extensions, or other project-local content
from an untrusted `cwd` without explicit per-run trust. Every later task that
needs to manually re-check skill discovery from this package should use the
`-p -a` form above, not bare `-p`.

No deviation from the expected `.pi/skills/<name>/SKILL.md` path was found
(AC-3 N/A) — the path itself matched on the first try. The only correction
relative to the task's starting assumption is the invocation form: `-a` is
required for discovery to work at all, and is now the recorded form.

## Package layout

```
the-intern/email-skills/
├── README.md                       # this file
├── .pi/
│   └── skills/
│       ├── himalaya/                # T-132: generic himalaya CLI-reference skill
│       │   ├── SKILL.md             #   no triage policy — reusable by any pi session
│       │   └── references/          #   sharing this package's cwd (S-010 Design Principles)
│       └── email-triage/            # T-135/T-136: triage policy skill (core loop + taxonomy)
│           ├── SKILL.md
│           └── references/
│               ├── worklog.md       # T-133: diary format + skip-tolerant reconciliation rules
│               ├── escalation.md    # T-134: manager-escalation rules and hard-stop behavior
│               └── categories/      # T-136/T-137/T-138: taxonomy index + one workflow file
│                   └── README.md    #   per starter category (newsletter-bulk,
│                                    #   automated-notification, suspected-spam,
│                                    #   direct-request, meeting-scheduling)
├── config/
│   └── email-triage.example.toml    # T-134: shipped template (manager_address documented,
│                                     #   no real address). The real config/email-triage.toml
│                                     #   exists only in the deployed copy — never committed.
└── worklog/                         # runtime diary directory. <YYYY-MM-DD>.md entries are
                                      #   written only in the deployed copy — never committed.
```

Later tasks (T-132–T-138) add files at the paths shown above without editing
this section.

## This package is the repository source of truth only

A scheduled job's per-entry `--cwd` (S-009 / ADR-012 §7) must point at an
owner-only **deployed copy** of this package, never at this repository
checkout. The deployed copy also holds mutable runtime state — the
skill-local `config/email-triage.toml` and the `worklog/` diary — that must
be owner-only permissioned (S-010 Configuration Requirements), which a shared
git working tree cannot guarantee.
