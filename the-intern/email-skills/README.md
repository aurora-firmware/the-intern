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
**0.65.2**. This package does not keep its own separate version record —
see the root `README.md`'s "pi-agent Version Compatibility" section (the
project's canonical record) for the currently supported version of the
scheduled/periodic `pi` invocation this package relies on. The full
transcript of the initial probe is recorded in T-131's Work Log.

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
├── package-pi-skills.sh             # T-153: generates .pi/skills/ below from skills/ below
├── skills/                          # T-151/T-152: canonical, vendor-neutral skill source —
│   │                                #   content exists here exactly once (S-011 Design Principles)
│   ├── himalaya/                    # generic himalaya CLI-reference skill
│   │   ├── SKILL.md                 #   no triage policy — reusable by any pi session
│   │   └── references/              #   sharing this package's cwd (S-010 Design Principles)
│   └── email-triage/                # triage policy skill (core loop + taxonomy)
│       ├── SKILL.md
│       └── references/
│           ├── worklog.md           # diary format + skip-tolerant reconciliation rules
│           ├── escalation.md        # manager-escalation rules and hard-stop behavior
│           └── categories/          # taxonomy index + one workflow file per starter category
│               └── README.md        #   (newsletter-bulk, automated-notification,
│                                    #   suspected-spam, direct-request, meeting-scheduling)
├── .pi/
│   └── skills/                      # T-153: generated pi packaging target — produced solely
│       ├── himalaya/                #   by running package-pi-skills.sh against skills/ above;
│       │   ├── SKILL.md             #   never hand-edited. Committed tracked output (no CI or
│       │   └── references/          #   install-time build step regenerates it), so it must stay
│       └── email-triage/            #   in sync with skills/ by re-running the script and
│           ├── SKILL.md             #   committing the result whenever skills/ changes.
│           └── references/
├── config/
│   └── email-triage.example.toml    # T-134: shipped template (manager_address documented,
│                                     #   no real address). The real config/email-triage.toml
│                                     #   exists only in the deployed copy — never committed.
└── worklog/                         # runtime diary directory. <YYYY-MM-DD>.md entries are
                                      #   written only in the deployed copy — never committed.
```

Later tasks add files at the paths shown above without editing this section.

**Regenerating the pi package.** `.pi/skills/` is generated, not hand-authored:
it carries no independent copy of skill content, only the canonical `skills/`
tree's files plus the one frontmatter field (`allowed-tools: Read Bash`) that
pi's skill format needs and the canonical source deliberately omits (S-011
Design Principles: canonical content stays vendor-neutral). After editing
anything under `skills/`, regenerate and commit `.pi/skills/` from this
directory:

```bash
cd the-intern/email-skills && ./package-pi-skills.sh
```

The script regenerates each packaged skill's `.pi/skills/<name>/` tree from
scratch, so a file removed from `skills/<name>/` does not linger as stale
output. `git diff --exit-code HEAD -- .pi/skills` after committing should be
clean; a non-empty diff there means `.pi/skills/` has drifted from `skills/`
and needs the script re-run.

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
  { field_path = "command", pattern = "himalaya*message move*Escalations*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "BODY=$(cat <<'*himalaya template reply *-- \"$BODY\" | himalaya template send*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "SUBJECT=$(cat <<'*SUBJECT=\"${SUBJECT//*BODY=$(cat <<'*himalaya template write -H *To:* -H \"Subject:Escalation: $SUBJECT\" -- \"$BODY\" | himalaya template send*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "himalaya template write" },
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

**This rule set covers the live T-139/T-140 validation runs** —
`automated-notification` (file, no reply), escalation, S-004 block handling,
and skipped-tick continuity — **plus one additional rule** admitting the
`himalaya template reply` -> `himalaya template send` shape that
`direct-request` and `meeting-scheduling` need to send a reply (`B-029`).
T-139's Session 2 explicitly deferred the direct-request route rather than
validate it; that rule gap is now closed. **This set still has no `message
move` rule for `Newsletters` or `Spam`** — the destinations `newsletter-bulk`
and `suspected-spam` need — since those categories haven't been through the
same live-validation pass; add matching rules (same shape as the
`INBOX.Notifications` rule) before relying on autonomous handling of either
category, or a confident match in one will sit blocked in the worklog
indefinitely. The rule is built on `B-030`'s
hardened heredoc pattern (`"$BODY"` loaded via a quoted heredoc, `--` before
the body argument), and, per `B-034`, admits the pipe form of the
composition rather than the `$()` capture-and-splice form it originally
shipped with: `himalaya v1.2.0`'s `template send` cannot actually parse a
template passed as a positional CLI argument (`Error: 0: cannot parse
template`), though stdin-piped input of the identical content works, so the
correct shape is `himalaya template reply <ID> [-A] -- "$BODY" | himalaya
template send`, not the earlier `himalaya template send "$(himalaya
template reply <ID> [-A] -- "$BODY")"` shape. Checked against the real
`wildmatch` crate: it matches the intended safe plain-reply and reply-all
(`-A`) pipe shapes — including when the message-derived body itself
contains adversarial shell metacharacters — and correctly rejects an
unquoted-heredoc bypass, a bare/unquoted `$BODY` regression, a
missing-`--` variant, the pre-`B-030` naive literal-splice shape, and the
now-removed `B-029`-era `$()` capture-and-splice shape that `B-034` found
himalaya cannot actually parse. This rule has since been re-run against a
live mailbox and `bob` instance the same way T-139/T-140 validated the
paths above: the job was fed a message that confidently classified as
`direct-request`, the reply was sent, the recipient confirmed receipt, and
the worklog recorded it correctly (`B-031`). Treat this rule as both
statically verified and live-validated for `direct-request` and
`meeting-scheduling` replies.

**The escalation rule above matches a hardened command shape, not the
originally live-validated one.** Subject/body are now loaded through the
heredoc pattern in the `himalaya` skill's "Embedding message-derived text
safely" reference rather than typed as literal quoted text, closing a
command-injection path from untrusted email content. The pattern itself was
checked against the real `wildmatch` crate for both the safe shape and
several unsafe variants, but the command — a multi-line script containing
heredocs, run via pi's `bash` tool — has since been re-run live against a
real mailbox and `bob` instance the same way T-139/T-140 validated the
original one-liner, and the recipient confirmed receipt of the escalation
email (`B-030`). Treat it as both hardened and live-validated.

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
