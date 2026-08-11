# Email Skills Package

This package ships three pi-agent skills as a versioned, reviewable product
artifact: `himalaya` (a generic CLI-reference skill) and `email-triage` (the
triage policy skill), both defined by S-010, plus `worklog` (the domain-free
diary-discipline skill S-011/T-154/T-155 extracted out of `email-triage`).
The package is separate from `the-intern/bob-companion/claude` (Claude Code
dev-tooling for operating `bob`) and from this repository's own
`.claude/skills` (this repository's AI-team process tooling). Neither of
those is where an agent discovers this package's runtime skills; the two
generated packaging targets under this directory — `.pi/skills/` and
`claude/` — are (see [Package layout](#package-layout)).

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
├── package-claude-skills.sh         # T-163: generates claude/ below from skills/ below
├── skills/                          # T-151/T-152/T-154/T-155: canonical, vendor-neutral
│   │                                #   skill source — content exists here exactly once
│   │                                #   (S-011 Design Principles)
│   ├── himalaya/                    # generic himalaya CLI-reference skill
│   │   ├── SKILL.md                 #   no triage policy — reusable by any pi session
│   │   └── references/              #   sharing this package's cwd (S-010 Design Principles)
│   ├── email-triage/                # triage policy skill (detection, classification,
│   │   ├── SKILL.md                 #   act-or-escalate decision); delegates all diary
│   │   └── references/              #   mechanics to the worklog skill below (S-011)
│   │       └── categories/          #   taxonomy index + one workflow file per starter
│   │           └── README.md        #   category (newsletter-bulk, automated-notification,
│   │                                #   suspected-spam, direct-request, meeting-scheduling)
│   └── worklog/                     # domain-free diary-discipline skill (S-011/T-154/T-155):
│       ├── SKILL.md                 #   location, entry format, first-run detection,
│       └── references/              #   reconciliation, and how an open item closes
├── .pi/
│   └── skills/                      # T-153/T-156: generated pi packaging target — produced
│       ├── himalaya/                #   solely by running package-pi-skills.sh against skills/
│       ├── email-triage/            #   above; never hand-edited. Committed tracked output (no
│       └── worklog/                 #   CI or install-time build step regenerates it), so it
│                                     #   must stay in sync with skills/ by re-running the
│                                     #   script and committing the result whenever skills/
│                                     #   changes.
├── claude/                          # T-163: generated Claude Code packaging target —
│   ├── .claude-plugin/              #   produced solely by running package-claude-skills.sh
│   │   └── plugin.json              #   against skills/ above; never hand-edited. Same
│   └── skills/                      #   committed-tracked-output contract as .pi/skills/
│       ├── himalaya/                #   above — content exists only under skills/ (S-011
│       ├── email-triage/            #   Design Principles). Unlike .pi/skills/, this target
│       └── worklog/                 #   needs no vendor-specific frontmatter field added, so
│                                     #   its output is byte-for-byte identical to skills/.
├── config/
│   └── email-triage.example.toml    # T-134: shipped template (manager_address documented,
│                                     #   no real address). The real config/email-triage.toml
│                                     #   exists only in the deployed job workspace — never
│                                     #   committed, and no longer holds any skill content
│                                     #   (S-011 skill install-path model — see below).
└── worklog/                         # runtime diary directory, written by the worklog skill.
                                      #   <YYYY-MM-DD>.md entries are written only in the
                                      #   deployed job workspace — never committed.
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

**Regenerating the Claude package.** `claude/skills/` is generated the same
way, by a separate script: it also carries no independent copy of skill
content, and — unlike `.pi/skills/` — needs no vendor-specific frontmatter
field added, since Claude Code's own skill format already matches what the
canonical source carries. After editing anything under `skills/`, regenerate
and commit `claude/` from this directory:

```bash
cd the-intern/email-skills && ./package-claude-skills.sh
```

The script regenerates each packaged skill's `claude/skills/<name>/` tree
from scratch the same way `package-pi-skills.sh` does, and also (re)writes
the static `claude/.claude-plugin/plugin.json` plugin manifest — layout
metadata only, carrying no skill body content of its own. `git diff
--exit-code HEAD -- claude` after committing should be clean; a non-empty
diff there means `claude/` has drifted from `skills/` and needs the script
re-run.

## This package is installed once, service-wide — not copied per job

Under the S-011/ADR-014 skill install-path model, `bob` supplies this
package's `.pi/skills/` content to every session it spawns — RPC worker,
interactive `bob chat`, and scheduled job alike — from a single,
service-wide **skill install path**, independent of that session's working
directory. Install `.pi/skills/` there once; every session bob spawns
afterward carries it, regardless of `--cwd`. This replaces the earlier
per-workspace deployed-copy model (T-139/T-140), where every job needed its
own full copy of this package under its `--cwd`.

A scheduled job's per-entry `--cwd` (S-009 / ADR-012 §7) is still required,
but now holds only the job's **mutable runtime state** — the skill-local
`config/email-triage.toml` and the `worklog/` diary — not a copy of this
package's skill content. That state must still be owner-only permissioned
(S-010 Configuration Requirements), which a shared git working tree cannot
guarantee, so the job workspace must still be created outside this
repository checkout. See
[Verified install-path deployment procedure](#verified-install-path-deployment-procedure)
below for the exact steps.

## Verified install-path deployment procedure

Install the packaged pi skill content to bob's configured (or default)
skill install path once:

```bash
SKILL_INSTALL_PATH=~/.local/share/bob/skills   # bob's Linux default — see
                                                # the operator guide for the
                                                # macOS default and the
                                                # skill_install_path override
mkdir -p "$SKILL_INSTALL_PATH"
SKILL_PACKAGE_SRC=the-intern/email-skills/.pi/skills
cp -r "$SKILL_PACKAGE_SRC/." "$SKILL_INSTALL_PATH/"
```

Then deploy an owner-only working directory holding only the job's mutable
runtime state — `config/` and `worklog/`, not skill content:

```bash
WORKSPACE=/absolute/path/outside/the-repo/email-skills

install -d -m 700 "$WORKSPACE"
install -d -m 700 "$WORKSPACE/config"
install -d -m 700 "$WORKSPACE/worklog"
cp the-intern/email-skills/config/email-triage.example.toml \
   "$WORKSPACE/config/email-triage.toml"
# then edit only the job workspace's config/email-triage.toml and set
# manager_address there
```

The required ownership boundary is unchanged from the earlier model: the
deployed workspace and its subdirectories are owned by the job user and mode
`700`, so other local users cannot read or modify the local config or the
worklog. Keep the job's `--cwd` pointed at that workspace:

```bash
./scripts/bob-dev.sh schedule add --id check-email --cron "* * * * *" \
  --prompt "Check email" --cwd "$WORKSPACE"
```

Do not point `--cwd` at this repository checkout, and do not copy this
package's skill content into `$WORKSPACE` — that content now reaches the
session from the skill install path above, independent of `--cwd`. The
workspace exists only for `config/email-triage.toml` and `worklog/*.md`, and
it is the path the S-004 worklog rules below must match.

The live T-139/T-140 happy-path and continuity validation (see
[Validation outcomes](#validation-outcomes) below) ran under the earlier
per-workspace `.pi/skills/` copy, before the install-path model existed. The
runtime tool-call payload shapes the S-004 rules below match —
`arguments.path` for `read`, `arguments.command` for `bash` — do not depend
on which path the skill content lives at, so moving skill-reference rules
from a per-workspace path to the shared install path changes only the
`pattern` values, not the matcher shape T-139/T-140 established. This is the
same reasoning the operator guide's deployment section applies to the
identical move (`T-161`).

## Verified S-004 action rules for the install-path model

T-139 first observed the same scheduled-job run denied by default policy, then
allowed after adding scoped action rules. The validated matcher surface was:

- `tool = "read"` with `field_path = "path"`
- `tool = "bash"` with `field_path = "command"`

The live T-139 runtime only succeeded with `field_path = "command"` in both
`config.toml` and `config.full.toml`. This matches the policy-control runtime
matcher semantics: the bash action gate matches against the JSON
`arguments.command` string. Older local parser examples and tests still use
`cmd` only because `field_path` is treated as an opaque string at
config-parse time; those examples do not prove the runtime bash payload
shape and should not be copied into live S-004 policy rules.

Under the install-path model this rule set is scoped to the single, stable
skill install path instead of being re-derived per deployment. Replace
`/abs/skill-install-path` below with your resolved `skill_install_path`
(default `~/.local/share/bob/skills` on Linux, shown above):

```toml
[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/skill-install-path/email-triage/SKILL.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/skill-install-path/himalaya/SKILL.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/skill-install-path/worklog/SKILL.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/skill-install-path/email-triage/references/*.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/skill-install-path/email-triage/references/categories/*.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/skill-install-path/himalaya/references/*.md" },
]

[[policy.action_rules]]
tool = "read"
arg_matchers = [
  { field_path = "path", pattern = "/abs/skill-install-path/worklog/references/*.md" },
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
  { field_path = "command", pattern = "*ls *worklog*" },
]

[[policy.action_rules]]
tool = "bash"
arg_matchers = [
  { field_path = "command", pattern = "date +%H:%M*" },
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

**The `worklog` skill's rules are now live-validated under the install-path
model.** The `worklog/SKILL.md` and `worklog/references/*.md` read rules
above admit the `worklog` skill (`T-154`/`T-155`) that the reduced
`email-triage` `SKILL.md` now delegates diary mechanics to. `T-164` re-ran
this exact rule set live, end to end, twice — once against a scheduled
`email-triage` job and once against an interactive `bob chat` session asked
to record a worklog entry directly — both from working directories holding
no skill files of their own, both served entirely from a single shared
skill install path with no per-workspace copy anywhere. See
[Validation outcomes](#validation-outcomes) below for the full T-164
record, including two real rule-set gaps that live run found and closed
(the broadened `*ls *worklog*` pattern and the new `date +%H:%M*` rule
above) and one skill-behavior defect it found and filed rather than papered
over (`B-039`: a scheduled run can write a wrong placeholder worklog
timestamp).

The absolute-path `worklog` rule the per-workspace deployment model used
(`{ field_path = "path", pattern = "<workspace>/worklog/*.md" }`) is dropped
entirely: the relative `worklog/*.md` rule above already matches worklog
reads issued from any working directory, which is what S-011's Configuration
Requirements call for ("the rule admitting worklog writes must be broad
enough to cover arbitrary working directories") — one relative rule now
covers every deployment's worklog reads instead of one absolute rule per
workspace.

**This rule set covers the live T-139/T-140 validation runs** —
`automated-notification` (file, no reply), escalation, S-004 block handling,
and skipped-tick continuity — re-confirmed live under the skill install-path
model itself by `T-164` — **plus one additional rule** admitting the
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

Replace `/abs/skill-install-path` with your resolved `skill_install_path`. Do
not collapse these into a blanket `tool = "bash"` rule: the T-139 denial
evidence showed the job blocked until the shell commands were admitted one
scoped shape at a time, and the successful retry used the narrowed patterns
above. In particular, the deployed package's runtime surface is broader than
"himalaya commands plus append": the skill reads `config/email-triage.toml`
through `bash`, checks and lists today's `worklog/` files through `bash`,
opens prior worklog contents through `read`, and uses one pipe-shaped
escalation send. The first-run reconciliation read was later observed in
T-140 as a `cwd`-relative `read.path` such as `worklog/2026-07-29.md`, so the
deployed allow rules must admit that relative shape as well as any
install-path-qualified paths used elsewhere.

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

### T-164 — skill install-path model, end to end (2026-08-10)

S-011 replaces the per-workspace deployed-copy model T-139/T-140 validated
above with the install-path model described throughout this README. T-164
re-ran the same kind of live validation those tasks ran, but against the
new model itself: install the packaged skill content once at the resolved
`skill_install_path`, then exercise both a scheduled job and an interactive
`bob chat` session from working directories holding no skill files of their
own, and confirm both actually use the installed skills.

- **Setup.** An isolated `bob` runtime installed this package's `.pi/skills/`
  content once at a dedicated `skill_install_path`. Two separate working
  directories were used for the two validation runs below, and neither ever
  held a `.pi/skills/` tree, a `skills/` tree, or any other copy of skill
  content — confirmed by inspecting both trees before and after every run.
  The single S-004 rule set below (scoped to the shared install path plus
  the relative `worklog/*.md` rule) was the only policy in force for both
  runs.
- **Scheduled job (AC-2).** A `check-email` job was added with `--cwd`
  pointed at a workspace holding only `config/email-triage.toml` and an
  empty `worklog/` — no skill files. It was fed the same reusable
  `automated-notification` fixture T-139 originally validated (the "You
  have been invited to join Holded" message, restored from
  `INBOX.Notifications` to `INBOX` and marked unseen for the run). Every
  other message that was genuinely unseen in the live mailbox at the time
  was temporarily marked seen for the run's duration and restored to
  exactly its prior unseen state immediately afterward, so the run's
  candidate set held only the one deliberate test fixture — no real
  correspondence was read, classified, or acted on by this run. The job
  correctly classified the fixture as `automated-notification`, moved it
  back to `INBOX.Notifications`, and appended a worklog entry to
  `worklog/2026-08-10.md` in the job's own `--cwd` — proving skill delivery
  is independent of the job's working directory while diary state stayed
  correctly `--cwd`-scoped, and proving skill content lived nowhere but the
  shared install path.
- **Interactive `bob chat` (AC-3).** A `bob chat` session was started (over
  a real pty, since pi's interactive mode needs one) from a working
  directory unrelated to any skill deployment and holding no skill files,
  then asked directly to record a worklog entry. The session loaded the
  `worklog` skill from the shared install path and correctly wrote the
  entry to that same directory's own `worklog/<today>.md` — no skill files
  were ever present there.
- **Single stable rule set (AC-4).** The first pass of both runs, under the
  rule set this README documented before T-164, hit real denials that
  blocked genuinely-documented `worklog` skill behavior: `ls -ld worklog`
  and a compound existence-check-then-`ls` command didn't match the
  narrower `*ls worklog*` pattern, and no rule admitted a standalone
  `date +%H:%M` lookup for the entry's `<HH:MM>` header. Both are closed
  above (`*ls *worklog*`, `date +%H:%M*`); re-running the interactive
  session with the fixed rule set produced zero denials. The scheduled-job
  run additionally triggered three denials that were *not* rule-set gaps:
  one `find` over the skill install path's `email-triage/references/categories/`
  directory (exploratory — the taxonomy's category names are already fully
  documented in `references/categories/README.md`, which this rule set
  already admits reading, so nothing required this call), and two attempts
  (an `edit` tool call and a `bash` call running an ad hoc Python script)
  to correct a worklog entry that had been written with the wrong
  placeholder timestamp `00:00` instead of the real time. Both correction
  attempts were correctly denied: this skill's own "Tool usage" sections
  are explicit that worklog mutations stay on `bash`'s documented
  `mkdir`/`cat >>` shape, never `edit` or arbitrary scripts, precisely so a
  narrow S-004 rule set can admit its whole runtime surface. No rule was
  added to work around either denial — the `find` wasn't needed for the run
  to succeed (and didn't stop it succeeding), and admitting `edit` or
  arbitrary `bash` scripts would reopen exactly the broad surface this
  package's rule set is designed to avoid. The wrong-timestamp behavior
  itself is a real, separate skill-behavior defect, filed as `B-039`
  (out of T-164's own scope to fix — the fix belongs in `worklog`'s or
  `email-triage`'s own skill/reference files, not in this README's action
  rules or deployment procedure).

## Account-specific folder names matter

The category workflow starter docs use human-readable destination names such as
`Notifications`, but the live T-139 account did not expose that folder name.
The successful validation had to move the automated notification from `INBOX`
to **`INBOX.Notifications`**, where it appeared as folder-local message id `1`.

Before copying the move rule above, verify the exact destination folder name
for your mailbox with `himalaya folder list`, then scope the `message move`
pattern to that exact folder. Do not assume the bare folder name from the
starter taxonomy if the account exposes a prefixed IMAP path instead.
