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

This is the layout every skill file under this package uses. It was first
verified with a throwaway probe skill placed at
`.pi/skills/probe-marker/SKILL.md` in a scratch copy of this package, using
that directory as `pi`'s `cwd`. The later live scheduled-job validation in
T-139 re-verified the same layout against the installed `pi --version`
**0.65.2**, which is now the repository's current recorded pi version for
this package. The full transcript of the initial probe is recorded in T-131's
Work Log.

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

## Verified deployed-workspace procedure

The live T-139 happy-path validation used a deployed workspace at
`/tmp/t139-email-workspace-s4`, while the bob runtime and audit state lived
separately at `/tmp/t139-bob-dev-s4`. The package checkout itself was **not**
used as the scheduled job's `--cwd`.

Create the deployed workspace outside this repository and make the workspace
directories owner-only before adding the job:

```bash
WORKSPACE=/absolute/path/outside/the-repo/email-skills

install -d -m 700 "$WORKSPACE"
cp -r the-intern/email-skills/. "$WORKSPACE/"
install -d -m 700 "$WORKSPACE/worklog"
chmod 700 "$WORKSPACE" "$WORKSPACE/.pi" "$WORKSPACE/config" "$WORKSPACE/worklog"
cp "$WORKSPACE/config/email-triage.example.toml" \
   "$WORKSPACE/config/email-triage.toml"
# then edit only the deployed copy's config/email-triage.toml and set
# manager_address there
```

The required ownership boundary is that the deployed workspace and its mutable
subdirectories are owned by the job user and mode `700`, so other local users
cannot read or modify the package, the local config, or the worklog. Keep the
job's `--cwd` pointed at that deployed copy only:

```bash
./scripts/bob-dev.sh schedule add --id check-email --cron "* * * * *" \
  --prompt "Check email" --cwd "$WORKSPACE"
```

Do not point `--cwd` at this repository checkout. The deployed copy is where
the mutable `config/email-triage.toml` and `worklog/*.md` live, and it is the
path the S-004 policy rules must match.

## Verified S-004 action rules for the happy path

T-139 first observed the same scheduled-job run denied by default policy, then
allowed after adding scoped action rules. The validated matcher surface was:

- `tool = "read"` with `field_path = "path"`
- `tool = "bash"` with `field_path = "command"`

The live T-139 runtime under `/tmp/t139-bob-dev-s4` only succeeded with
`field_path = "command"` in both `config.toml` and `config.full.toml`. This
matches the policy-control runtime matcher semantics: the bash action gate
matches against the JSON `arguments.command` string. Older local parser examples
and tests still use `cmd` only because `field_path` is treated as an opaque
string at config-parse time; those examples do not prove the runtime bash
payload shape and should not be copied into live S-004 policy rules.

The live happy-path rules that admitted every tool call used by the deployed
package were:

```toml
[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/workspace/.pi/skills/email-triage/SKILL.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/workspace/.pi/skills/himalaya/SKILL.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/workspace/.pi/skills/email-triage/references/*.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/workspace/.pi/skills/email-triage/references/categories/*.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/workspace/.pi/skills/himalaya/references/*.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/workspace/worklog/*.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "worklog/*.md" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya --version*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya account list*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya folder list*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya*envelope list*not flag seen*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya*message read*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya*message move*INBOX.Notifications*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya template write -H *To:* -H *Subject:Escalation:* *| himalaya template send*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "cat config/email-triage.toml*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "*find worklog*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "*ls worklog*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "test -f worklog/*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "cat worklog/*.md*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "mkdir -p worklog*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "*>> worklog/*.md*" },
]
```

Replace `/abs/workspace` with the absolute path to your deployed copy. Do not
collapse these into a blanket `tool = "bash"` rule: the T-139 denial evidence
showed the job blocked until the shell commands were admitted one scoped shape
at a time, and the successful retry used the narrowed patterns above. In
particular, the deployed package's runtime surface is broader than "himalaya
commands plus append": the skill reads `config/email-triage.toml` through
`bash`, checks and lists today's `worklog/` files through `bash`, opens prior
worklog contents through `read`, and uses one pipe-shaped escalation send.
The first-run reconciliation read was later observed in T-140 as a
`cwd`-relative `read.path` such as `worklog/2026-07-29.md`, so the deployed
allow rules must admit that relative shape as well as any absolute
workspace-qualified paths used elsewhere.

## Validation outcomes

T-139 established the happy path on the live deployed copy. T-140 then
validated the remaining continuity and failure-path behaviors against the
same mailbox and scheduled-job setup.

- Escalation: on 2026-08-03, fixture `92` (`Unclear task`) was picked up by
  the live `check-email` run and recorded in
  `worklog/2026-08-03.md` at `15:51 CEST` as an open item after sending one
  escalation email to `manager_address`. In this live account the local
  Himalaya config runs with `message.send.save-copy = false`, so the worklog
  entry is the retained local evidence while the manager-side receipt is
  observed in the addressed mailbox, not in `INBOX.Sent`. The blocked-send
  wording in the skill and worklog reference was tightened so a denied
  escalation send is recorded as blocked, not as a successful escalation.
- S-004 block: with the himalaya allow rule removed but worklog access left
  in place, the run recorded the blocked escalation as an open worklog item
  and took no fallback action on the message.
- Skipped-tick continuity: the continuity setup left
  `/tmp/t140-email-workspace-cont-YZdrii/worklog/2026-07-29.md` holding an
  open José Moreno `Documents` item whose `Next` line said to "re-check at the
  next first-run reconciliation." The next executed run on 2026-08-03 reached
  that reconciliation path through a relative `read.path =
  worklog/2026-07-29.md` lookup (observed in the live
  `/tmp/t140-bob-dev-MupzJI` audit), which proves the triage loop looked back
  to the carried item instead of assuming the previous run was "yesterday." In
  the resulting `2026-08-03.md` worklog continuation for the same validation
  flow, the item remained open and its follow-up advanced to retrying the
  escalation send once the command succeeds. The validated allow-rule set now
  includes the relative `read` matcher required for this cross-day
  carry-forward path.

## Account-specific folder names matter

The category workflow starter docs use human-readable destination names such as
`Notifications`, but the live T-139 account did not expose that folder name.
The successful validation had to move the automated notification from `INBOX`
to **`INBOX.Notifications`**, where it appeared as folder-local message id `1`.

Before copying the move rule above, verify the exact destination folder name
for your mailbox with `himalaya folder list`, then scope the `message move`
pattern to that exact folder. Do not assume the bare folder name from the
starter taxonomy if the account exposes a prefixed IMAP path instead.
