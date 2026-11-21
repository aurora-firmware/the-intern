---
id: S-008
title: Skills and instructions
version: '0.3'
status: approved  # draft | review | approved | superseded
created: '2026-11-13'
author: planner
---

# Skills and instructions

## Purpose

This spec covers S-000's **Skills and instructions** component. Today the text that steers agents is split: a role's
instructions are a string in `config.toml`, a role's skills are absolute folder paths, the preamble every agent gets is
fixed in the installed package, and The Intern ships one skill. A team can't change the common prompt, can't see which
skills an agent has or why, and can't give a working agent a skill it needs. When this is done, The Intern ships its
common system prompt, the role instructions and three skills into one folder of its own that the team edits in place;
skills come from search paths by name, with a priority a team member can inspect; each role enables skills by default,
and a team member or an agent can switch them for an agent that is already working; and every agent, the front desk
included, reads skills through one tool.

## Definitions

This spec uses the Definitions of S-001 to S-007 (team member, job, role, seat, workspace, front desk, conversation,
service operation, page, way in) and the shared vocabulary of `docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Skill | A folder holding a `SKILL.md` file whose frontmatter gives a `name` and a `description`, plus any bundled files, in the shared Agent Skills format (REQ-004). |
| Instruction file | A markdown file whose text goes into an agent's system prompt: the common prompt, a role's instructions, or a workspace's context file: the `AGENTS.md` or `CLAUDE.md` file, or the other name pi agent reads in its place, of the workspace or one of its parent folders (REQ-007). |
| Common prompt | The instruction file every agent gets first, whatever its role (REQ-001). It replaces the fixed preamble. |
| Shipped content | The common prompt, the shipped roles' instructions and the shipped skills, as the installed package carries them (REQ-001). |
| Internal folder | The folder under the instance's data directory that holds the live copy of the shipped content and the team roles' instruction files (REQ-002). |
| Skill search path | A folder of skills the team names in the configuration (REQ-004). |
| Skill catalog | Every skill found in the internal folder and the skill search paths, resolved by name (REQ-004). |
| Enabled set | The skill names an agent has enabled. It is a fact of the agent, kept with its conversation and separate from its seat: changing it is not a seat change (REQ-006). |
| Enabled skills | The skills an agent is offered: those of its enabled set that the catalog holds, plus its workspace's skills (REQ-005, REQ-006). |
| Role catalog | The skill catalog as an agent of that role would see it in the role's default workspace (REQ-005). |
| Shadowed skill | A skill found under a name that a higher-priority source also holds; it is not used (REQ-004). |
| Edited | A shipped file in the internal folder whose content differs from what The Intern last copied there, or that was deleted (REQ-003). |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member | Fits The Intern to the team: changes the common prompt and role instructions, adds skills and chooses which agents get them, and finds out why an agent has or lacks a skill. |
| Agent in a job | Reads the skills it is offered when its task matches, and switches its own skills through `bob` when it needs another. |
| Front desk | Explains The Intern to team members from the shipped skill, without file tools. |
| Developer | Tests the catalog, the upgrade rule and live changes against a fake model. |

Journeys, in priority order:

1. **Change what agents are told.** A team member edits `instructions/common.md` or a role's file, by hand, on the web
   or through an agent, and every running agent works with the new text from its next model request. Delivered by
   REQ-002, REQ-007, REQ-010, REQ-013.
2. **Add a skill and give it to a role.** A team member drops a skill folder into a search path and enables it for a
   role with `bob skills enable` or a check box. Delivered by REQ-004, REQ-005, REQ-012, REQ-013.
3. **Give a working agent a skill.** A team member, or the agent itself through `bob`, enables a skill for one running
   agent. Delivered by REQ-006, REQ-012, REQ-013, REQ-014.
4. **Find out why.** `bob skills list --conversation <id>` shows each skill's source, whether it is enabled, and the
   copies a higher source shadows; `bob instructions list` shows the files that build a prompt. Delivered by REQ-009,
   REQ-012.
5. **Ask the front desk about The Intern.** The front desk answers from the shipped skill through the `skill` tool.
   Delivered by REQ-001, REQ-008.
6. **Upgrade without losing edits.** An upgrade brings new shipped text where nobody edited it, and restore brings the
   shipped text back on request. Delivered by REQ-003, REQ-011.

## Exclusions

- **Adding and removing skills through The Intern.** A team member adds or removes a skill folder with their own tools.
  The command line and the web change the configuration and the text of files that exist (REQ-010, REQ-012, REQ-013).
- **Printing skill and instruction file text on the command line.** The `bob skills` and `bob instructions` commands
  print names, paths and states only, because file text can hold characters a terminal mishandles; the files are read
  directly. `bob roles show` keeps printing a role's instructions as S-005 REQ-012 states.
- **Fetching skills remotely.** No installing from a URL, git or a marketplace: the team puts folders on the machine and
  adds a search path.
- **Edit history.** No versions or undo of edits, apart from restoring a shipped file (REQ-003).
- **pi extensions and code.** Skills add no code to The Intern. Neither the service account's nor a workspace's pi
  agent extensions are loaded, as S-001 states; a skill's scripts run only through an agent's `bash`.
- **Frontmatter that changes the agent.** Fields that would set a model, thinking level or tools are ignored. Applying
  them is an open question for a later version (Open Questions).
- **Translating vendor formats.** Skills in the shared format load as they are; vendor-specific fields are ignored, not
  converted.
- **Typed skill commands.** No `/skill:name` input: agents load skills through `skill`, and team members enable skills
  rather than invoke them.
- **Skills chosen in a job request, a handoff or an invocation.** A new seat starts with its role's defaults, and a
  team member or the agent switches skills afterwards (REQ-006).
- **Confining file operations.** `files.read`, `files.write` and the `skill` tool follow symbolic links wherever they
  lead; the operating system's permissions for the service account decide what can be read or written (REQ-010,
  REQ-016). The Intern adds no limit of its own, by design.
- **The service account's own pi agent skill folders.** `~/.pi/agent/skills` and `~/.agents/skills` aren't loaded by
  default. A team adds one as a search path like any other folder.

## Alternatives Considered

- **A skills library The Intern owns, with roles naming library skills only.** Rejected by the product owner: skills
  stay folders at paths the team chooses, and the shipped ones sit in a path included by default.
- **A team copy that overrides a shipped skill, keeping the shipped file live underneath.** Rejected by the product
  owner: skills are edited where they are, with no extra copy.
- **Editing the installed package's files.** Rejected: an upgrade or reinstall would wipe the team's edits, and S-000
  keeps the installed copy untouched.
- **An upgrade that overwrites every shipped file, edited or not.** Rejected by the product owner: the team would
  re-apply its edits after each upgrade.
- **Keeping role instructions as text in `config.toml`.** Rejected by the product owner: all text the team edits follows
  one model, files edited in place.
- **Every agent offered every skill.** Rejected: every prompt would list every skill, and the front desk would see
  execution skills.
- **Agents searching the catalog and enabling skills for themselves through a tool.** Rejected: an agent's skills would
  drift from what the team configured. An agent can still switch its skills through `bob`, as a team member does.
- **Named skill sets.** Rejected: a new concept for a team that keeps a handful of skills.
- **Instruction edits reaching only agents seated after them.** Rejected by the product owner: one rule for every edit,
  from the next model request.
- **Inlining a skill's text in the prompt for agents without file tools, or giving the front desk the `read` tool.**
  Rejected: inlining costs context on every request, and `read` would let the front desk read any file.
- **`show`, `add`, `edit` and `remove` commands for skill and instruction files.** Rejected by the product owner: files
  are read and changed with the team's own tools, and the commands change only configuration.
- **A skill set per schedule entry.** Rejected: from the Schedules page the panel opens the role the entry names.
- **Refusing symbolic links that lead out of a skill folder or a workspace, and parent folders' context files.**
  Rejected by the product owner on 2026-11-15: The Intern doesn't stop file operations, and the
  operating system's permissions decide.

## Interfaces

### Exposed: the internal folder

**Contract** (paths under the instance's data directory, S-002 REQ-006):

```text
<data dir>/instructions/common.md          the common prompt
<data dir>/instructions/roles/<role>.md    a role's instructions, shipped and team roles
<data dir>/skills/<name>/SKILL.md          a shipped skill, with its bundled files beside it
```

Team members may read and edit these files with their own tools (REQ-002).

### Exposed: the configuration file

**Contract** (keys in `config.toml`, S-002 REQ-021):

```toml
[skills]
paths = ["/srv/team-skills", "/home/intern/more-skills"]   # optional, absolute folders; a later path wins on a name

[roles.reviewer]
skills = ["code-review", "about-the-intern"]   # skill names, no longer folder paths
```

A role table no longer takes an `instructions` key; the text lives in the role's instruction file (REQ-007). REQ-011
says how an older file is read.

### Exposed: the workspace

A workspace's `AGENTS.md`/`CLAUDE.md` files, from the workspace and its parent folders (S-001), and its skills under
`<workspace>/.pi/skills`. **Contract**: this spec makes the `.pi/skills` location, which the code already uses, part of
the product's contract.

### Exposed: service operations

All are reachable through both listeners at `POST /operations/<name>` (S-003 REQ-003) and return S-002's errors. An
agent is named by its conversation id; a role by its name. Where the input is "`role` or `conversation`", exactly one
is required, and none or both is refused `invalid_input`.

| Operation | Kind | Input | Result | Requirement |
|---|---|---|---|---|
| `skills.list` | read | `role` or `conversation` | the catalog for that role or agent: per skill its name, description, source, path, enabled flag, shipped and edited marks, the shadowed copies, and the skills left out with the reason; for a conversation also its seat | REQ-009 |
| `skills.enable`, `skills.disable` | control | `name`, and `role` or `conversation` | the new enabled set; `not_found`, `invalid_input`, `conflict` | REQ-005, REQ-006 |
| `skills.paths.list` | read | none | the search paths in priority order, lowest first, each with whether it passes REQ-004's check | REQ-004 |
| `skills.paths.add` | control | `path` | the search paths, the new one last; a path already listed returns them unchanged; `invalid_input`, `conflict` (file changed on disk) | REQ-004 |
| `skills.paths.remove` | control | `path` | the search paths; `not_found`, `conflict` (file changed on disk) | REQ-004 |
| `skills.restore` | control | `name` of a shipped skill | the skill; `not_found` | REQ-003 |
| `instructions.list` | read | `role` or `conversation` | the instruction files that build that prompt, in order, each with its kind, path and shipped, edited or missing mark | REQ-009 |
| `instructions.restore` | control | `common` or a shipped role's name | the file; `not_found` | REQ-003 |
| `files.read` | read | `path` of a skill file or instruction file | the text and a version token; `not_found`, `invalid_input` | REQ-010 |
| `files.write` | control | `path`, `text`, the version token read | the new version token; `not_found`, `invalid_input`, `conflict` | REQ-010 |

`skills.paths.add` takes no idempotency key: adding a listed path again changes nothing and succeeds, so a retry is
safe.

`roles.list` keeps returning each role's instructions, now read from its file, with a version token, and its skills as
names; a role whose file is missing is returned with no instructions and marked missing. `roles.create` and
`roles.change` write the instructions they are given to the role's file, `roles.change` only with the version token
`roles.list` returned. `roles.restore` also restores a shipped role's file and default skills, and `roles.remove`
deletes the removed role's file (REQ-007).

Feed, on the instance scope (S-002 REQ-014):

| Delta | Carries | Requirement |
|---|---|---|
| `settings_changed` (existing, S-002 REQ-022) | that a role's skills or the search paths changed | REQ-004, REQ-005 |
| `files_changed` (new) | the path and kind of a file changed through `files.write`, a restore or a role operation | REQ-010 |
| `skills_changed` (new) | a conversation id and its new enabled set, after an enable, a disable or a seat change | REQ-006 |

**Contract** (transcript entry): each enabled-set change is stored as an `intern.skills` entry in the conversation,
read through `conversations.entries` and the conversation feed. It carries the actor, the skill, whether it was enabled
or disabled, and the new set. It is not part of the model's context. The Job page shows it in the conversation's
activity (REQ-013).

`conversations.get`, `conversations.list` and the instance feed snapshot return each conversation's enabled set beside
its seat. A file changed by hand is not announced: pages show it when they next read it, and a save over it is refused
`conflict` (REQ-010).

### Exposed: the `bob skills` and `bob instructions` commands

They take S-005's reserved group names and follow its conventions: `--json`, exit codes, stderr for errors. No command
prints file text.

| Command | Operations called | Requirement |
|---|---|---|
| `bob skills list --role <role>`, `bob skills list --conversation <id>` | `skills.list` | REQ-012 |
| `bob skills enable <name> --role <role>`, `bob skills disable <name> --role <role>` | `skills.enable`, `skills.disable` | REQ-012 |
| `bob skills enable <name> --conversation <id>`, `bob skills disable <name> --conversation <id>` | `skills.enable`, `skills.disable` | REQ-012 |
| `bob skills paths`, `bob skills add-path <path>`, `bob skills remove-path <path>` | `skills.paths.list`, `skills.paths.add`, `skills.paths.remove` | REQ-012 |
| `bob skills restore <name>` | `skills.restore` | REQ-012 |
| `bob instructions list --role <role>`, `bob instructions list --conversation <id>` | `instructions.list` | REQ-012 |
| `bob instructions restore common`, `bob instructions restore <role>` | `instructions.restore` | REQ-012 |

### Exposed: the web interface

- A **Skills panel** (REQ-013), opened from a role on the Roles page, from each conversation on a Job page, and from an
  entry on the Schedules page, where it shows the role the entry names.
- **File editing** of skill and instruction files in the browser (REQ-013).
- A **Skills and instructions** section of the Roles page for the common prompt, the search paths and restores.

The pages call only the operations above and those S-006 already lists.

### Exposed: the `skill` tool

| Tool | Offered to | Does |
|---|---|---|
| `skill` | every agent, the front desk included | given a skill name and an optional file path inside the skill, returns the text of that enabled skill's `SKILL.md` or the named file (REQ-008) |

**Contract**: the tool name `skill`, its `name` parameter and its optional `file` parameter. The system prompt lists the
enabled skills by name and description and tells the agent to load them with `skill`.

### Consumed

- S-001: roles, seats, the seat change, workspace context files and skills, the front desk.
- S-002: the instance directories, the configuration file and settings operations (REQ-021, REQ-022), the error
  outcomes, the instance feed.
- S-003: the routes and the client library.
- S-005: the reserved `skills` and `instructions` groups and the conventions of every group.
- S-006: the Roles page, the Job page, the style, refusals and lost connections. S-007: the Schedules page.
- The user manual, which the shipped `about-the-intern` skill is drawn from (REQ-017).

## Workflow

```text
First start of this version: seed the internal folder, migrate the configuration            REQ-002, REQ-011
Later start after an upgrade: update unedited shipped files, add new ones                     REQ-003
Team member or agent edits an instruction file or skill (by hand, web, or agent tools)        REQ-010
  (web save after the file changed on disk → refused conflict, typed text kept, disk text offered)  REQ-010, REQ-013
  (a linked file is read and written at its target; the system's permissions decide)           REQ-010, REQ-016
Team member adds a search path or drops a skill folder into one                               REQ-004
  (path not absolute, missing, or reachable by other accounts → refused; in the file → startup stops)  REQ-004
Team member enables a skill for a role or for one running agent                               REQ-005, REQ-006
  (unknown name → refused, nothing changes)                                                    REQ-005, REQ-006
Agent's next model request: prompt built from common, role, workspace files and enabled skills REQ-007
  (broken skill or missing file → left out with a diagnostic, the agent carries on)           REQ-004, REQ-007
Agent loads a skill with `skill`                                                               REQ-008
  (skill not enabled, or a path written out of its folder → refused; a link is followed)      REQ-008, REQ-016
Seat changes → enabled skills reset to the new role's defaults                                REQ-006
Team member inspects: `bob skills list`, `bob instructions list`, the Skills panel             REQ-009, REQ-012, REQ-013
Team member restores a shipped file                                                            REQ-003
```

## Behavioral Requirements

### REQ-001 — Shipped content

The Intern SHALL ship a common prompt, the instructions of `bob`, `gp`, `desk` and `triage` (S-009 REQ-019), and these
skills, each enabled by default for the roles named:

| Skill | Purpose | Enabled by default for |
|---|---|---|
| `carry-out-a-part` | how to carry out a part of a job to completion and report back (S-001 REQ-002) | `gp` |
| `about-the-intern` | how The Intern works and how a team member uses and configures it, drawn from the user manual | `bob`, `desk`, `triage` |
| `bob-command-line` | how an agent uses the `bob` commands from `bash` to read and manage The Intern, `bob mail` included | `bob`, `gp` |

The common prompt SHALL cover what today's preamble covers: The Intern works unattended, every conversation belongs to
a job except the front desk, the seat, the coordination capabilities, the context modes and the choices after an
invocation. It SHALL also tell agents that mail texts and the mail they send show no short number, job, conversation
or request ID, role name, tool name or path of saved mail, unless the person they write to asked for one
(S-009 REQ-016). The shipped text may change in later versions without amending this spec.

#### AC-001.1 — A fresh instance

- **Given:** a daemon started for the first time with no configuration file
- **When:** a team member runs `bob skills list --role desk` and `bob skills list --role gp`
- **Then:** `desk` shows `about-the-intern` enabled, `gp` shows `carry-out-a-part` and `bob-command-line` enabled, and
  each skill's path is under `<data dir>/skills/`

**Verification:** test — `test/service/skill_catalog.test.ts`.

#### AC-001.2 — The shipped text matches its purpose

- **Given:** the shipped common prompt and the three shipped skills
- **When:** a reviewer reads them against this requirement and S-001 REQ-002
- **Then:** the common prompt covers the listed topics, mail without internals included, each skill covers its
  purpose, and `bob-command-line` names only commands S-005, S-007, S-009 and this spec define, and teaches `bob mail`

**Verification:** inspection — the shipped content in the package.

### REQ-002 — The internal folder

On every start, right after it takes single ownership (S-002 REQ-002 step 3) and before it reads the configuration
file's older keys (REQ-011), the daemon SHALL create any part of the internal folder that is missing, apply REQ-003's
upgrade rule, and copy into it each shipped file it has never copied before, so that the internal folder is the only
live copy of the shipped content. A failure to write it SHALL stop startup with an error naming the path. The daemon
SHALL never write to the installed package. Folders it creates SHALL be accessible only to the service account, and
files it writes readable and writable only by it (ADR-002). A team member's edits to the internal folder, made by any
means, SHALL be used as they are.

#### AC-002.1 — Seeded once, then used in place

- **Given:** a first start that seeded the internal folder
- **When:** a team member edits `<data dir>/skills/carry-out-a-part/SKILL.md` by hand and the daemon restarts
- **Then:** the file keeps the edit, an agent that loads the skill gets the edited text, and the package file is
  unchanged

**Verification:** test — `test/service/internal_folder.test.ts`.

#### AC-002.2 — Owner-only

- **Given:** a first start
- **When:** the internal folder is inspected
- **Then:** its folders are `0700` and its files `0600`

**Verification:** test — `test/service/internal_folder.test.ts`.

### REQ-003 — Upgrades and restore

When a version starts whose shipped content differs from the content last copied, the daemon SHALL replace each shipped
file that is not edited with the new version, add each new shipped file, and leave each edited file, deleted ones
included, as it is. A shipped file a version no longer ships SHALL stay in the internal folder if edited and be removed
if not. `skills.restore` and `instructions.restore` SHALL copy the installed version of a shipped skill, the common
prompt or a shipped role's instructions back into the internal folder, replacing what is there, and the file SHALL then
count as not edited. A restore of a name that is not shipped SHALL be refused `not_found`.

#### AC-003.1 — An upgrade keeps edits

- **Given:** an instance whose `instructions/roles/bob.md` was edited and whose `instructions/roles/gp.md` was not
- **When:** a version shipping new text for both starts
- **Then:** `gp.md` holds the new text, `bob.md` keeps the edit, and `bob instructions list --role bob` marks it edited

**Verification:** test — `test/service/internal_folder.test.ts`.

#### AC-003.2 — A deleted shipped skill stays deleted until restored

- **Given:** a team member deleted `<data dir>/skills/about-the-intern`
- **When:** the daemon restarts, then a team member runs `bob skills restore about-the-intern`
- **Then:** after the restart the skill is still absent and listed as edited (deleted); after the restore it is back
  with the shipped text and is not edited

**Verification:** test — `test/service/internal_folder.test.ts`.

#### AC-003.3 — Restore of a team file

- **Given:** a team role `reviewer`
- **When:** a team member runs `bob instructions restore reviewer`
- **Then:** the call is refused `not_found`, and the file is unchanged

**Verification:** test — `test/service/skill_operations.test.ts`.

### REQ-004 — Skill search paths and the catalog

The skill catalog SHALL be built from these sources, in rising priority: the internal folder's `skills` folder, each
skill search path in its configured order, and, for an agent, its workspace's `.pi/skills` folder. A later path in
`[skills] paths` therefore wins over an earlier one, and the workspace wins over all. A source is either a folder that
is itself a skill (it holds `SKILL.md`) or a folder whose skills are found at any depth below it. When two sources hold
the same name, the higher-priority copy SHALL be used and the other is shadowed. Inside one source, the copy whose
folder path sorts first by byte order SHALL be used, and the others are shadowed with a diagnostic. A `SKILL.md` that
can't be parsed or has no description SHALL be left out with the reason, and nothing else is affected. A skill folder
added to or removed from a source SHALL be seen from the next catalog read, without a restart.

`skills.paths.add` and `skills.paths.remove` SHALL change the configuration file as S-002 REQ-022 states for settings,
including its `conflict` refusal when the file changed on disk. `skills.paths.add` appends the path, which then has the
highest priority among the search paths; adding a path already listed SHALL change nothing and succeed. A search path
SHALL be an absolute path to an existing folder that only the service account can access, as a workspace is checked
(S-001 REQ-018); one that fails is refused `invalid_input`, and one in the file stops startup at S-002 REQ-002 step 1
with an error naming it.

#### AC-004.1 — Priority and shadowing

- **Given:** a search path `/srv/team-skills` holding `carry-out-a-part`, and a workspace whose `.pi/skills` also holds
  `carry-out-a-part`
- **When:** a team member lists the skills of a `gp` agent seated in that workspace
- **Then:** the workspace copy is in use, and the search path copy and the internal copy are listed as shadowed

**Verification:** test — `test/service/skill_catalog.test.ts`.

#### AC-004.2 — A broken skill is left out

- **Given:** a search path holding one skill with no description and one valid skill
- **When:** the catalog is listed
- **Then:** the valid skill is listed, the broken one is listed as left out with the reason, and agents carry on

**Verification:** test — `test/service/skill_catalog.test.ts`.

#### AC-004.3 — A path that fails the check

- **Given:** a running daemon
- **When:** a team member adds, in turn, a relative path, a missing folder, a folder other accounts can read, and a path
  already listed
- **Then:** the first three are refused `invalid_input` and the file is unchanged; the last succeeds and the list is
  unchanged

**Verification:** test — `test/service/skill_operations.test.ts`.

#### AC-004.4 — Order inside one source and between paths

- **Given:** search paths `/a` then `/b`, where `/a` holds `x/lint` and `y/lint`, and `/b` holds `lint`
- **When:** the catalog is listed
- **Then:** `/b/lint` is used; `/a/x/lint` and `/a/y/lint` are shadowed, and a diagnostic names `/a/y/lint` as shadowed
  inside its source

**Verification:** test — `test/service/skill_operations.test.ts`.

### REQ-005 — A role's default skills

A role's `skills` SHALL be a list of skill names. An agent seated with a role SHALL start with that list as its
enabled set. `skills.enable` and `skills.disable` with a `role` SHALL change that list in the configuration file as
S-002 REQ-022 states; enabling a name the role catalog doesn't hold SHALL be refused `not_found`, and nothing changes. A
change SHALL apply to agents seated with the role afterwards, and agents already seated keep their own enabled set
(REQ-006). A name in the file that the catalog doesn't hold SHALL NOT stop startup: it is listed as missing, and the
agent goes without it.

A shipped role with no `skills` key SHALL get the defaults of the running version (REQ-001), so a later version's new
default reaches it. Once a team member changes a shipped role's skills, the file holds its full list, which an upgrade
SHALL NOT change; `roles.restore` SHALL remove the key, bringing the version's defaults back.

#### AC-005.1 — Enable for a role

- **Given:** a search path holding `code-review`
- **When:** a team member runs `bob skills enable code-review --role gp`, then `gp` is seated in a new conversation
- **Then:** the file lists `code-review` for `gp`, and the new agent's prompt lists `code-review`

**Verification:** test — `test/service/skill_operations.test.ts`.

#### AC-005.2 — A name that is gone

- **Given:** `gp` enables `code-review`, and its folder is deleted while the daemon is stopped
- **When:** the daemon starts and a `gp` agent is seated
- **Then:** the daemon reports ready, `bob skills list --role gp` marks `code-review` missing, and the agent runs
  without it

**Verification:** test — `test/service/skill_catalog.test.ts`.

### REQ-006 — The skills of a running agent

Each agent SHALL have its own enabled set, starting from its role's defaults when it is seated. The enabled set is not
part of the seat: changing it records no seat change. `skills.enable` and `skills.disable` with a `conversation` SHALL
change that agent's set, from its next model request, whoever calls them: a team member through a way in, or an agent
through `bob`. Each change SHALL be recorded as an `intern.skills` entry with its actor, the skill and the new set,
outside the model's context, and published as `skills_changed`. An unknown conversation or skill name SHALL be refused
`not_found`, and a closed conversation `conflict`, naming it as closed (S-001 REQ-026). A workspace's skills SHALL
always be enabled; disabling a name the agent's workspace supplies is refused `invalid_input`.

The set SHALL survive a daemon restart, a reset (S-001 REQ-011) and a compaction. It SHALL reset to the new role's
defaults on any seat change (S-001 REQ-004, REQ-006), in the same durable step as the seat change, so that after a crash
the conversation never holds the new seat with the old set. The reset SHALL be published as a `skills_changed` delta
after the `seat_changed` delta, and records no `intern.skills` entry, because the seat record already shows it.

#### AC-006.1 — Enable for a working agent

- **Given:** job W-12's lead agent is running as `bob`
- **When:** a team member enables `code-review` for its conversation
- **Then:** its next model request lists `code-review`, `skill` returns its text, and `bob` agents seated elsewhere are
  unaffected

**Verification:** test — `test/service/agent_skills.test.ts`.

#### AC-006.2 — A seat change resets

- **Given:** the agent of AC-006.1, with `code-review` enabled
- **When:** it hands off to `gp`
- **Then:** its enabled set is `gp`'s defaults, without `code-review`

**Verification:** test — `test/service/agent_skills.test.ts`.

#### AC-006.3 — Kept across a restart

- **Given:** an agent with a skill enabled for it
- **When:** the daemon is killed with `kill -9` and restarted
- **Then:** the agent's enabled set still holds the skill

**Verification:** test — `test/service/agent_skills.test.ts`.

#### AC-006.4 — A crash during a handoff

- **Given:** an agent with `code-review` enabled that hands off to `gp`
- **When:** the daemon is killed with `kill -9` at each point of the handoff and restarted
- **Then:** the conversation holds either the old seat with `code-review` or `gp`'s seat with `gp`'s defaults, never a
  mix

**Verification:** test — `test/service/agent_skills_crash.test.ts`.

#### AC-006.5 — Refusals and the record

- **Given:** a closed conversation, an open one in a workspace whose `.pi/skills` holds `lint`, and an unknown id
- **When:** a team member enables a skill for each, then disables `lint` for the open one
- **Then:** the closed one is refused `conflict` naming it as closed, the unknown one `not_found`, and disabling `lint`
  `invalid_input`; the successful enable is in the open conversation's entries with the team member as actor, and a
  `skills_changed` delta carries it

**Verification:** test — `test/service/agent_skills.test.ts`.

### REQ-007 — Instruction files and the system prompt

An agent's system prompt SHALL be built, in this order, from the common prompt, its role's instruction file, its
workspace's context files, and the listing of its enabled skills (REQ-008), with the parts S-001, S-004 and S-007 add.
Those added parts, such as the lead's first duty (S-004 REQ-008), the scheduled run notice (S-007 REQ-010), the
workspace line and the wording of the skill listing, are not instruction files: an edit to `common.md` can't remove
them. Each instruction file SHALL be read again before each model request, so that an edit to it, an enabled-set change
or a skill folder added or removed reaches every running agent it touches from its next model request.

A team role is defined by its `[roles.<name>]` table. An instruction file with no table is not a role and is not
listed. `roles.create` SHALL write the instructions it is given to the role's instruction file in the internal folder,
replacing a file left there without a table. `roles.change` SHALL write new instructions only with the version token
from `roles.list`, and SHALL refuse `conflict` when the file changed since that token, so a hand edit is never
overwritten (S-002 REQ-022). `roles.restore` SHALL also restore a shipped role's file (REQ-003). `roles.remove` SHALL be
refused `conflict`, naming the conversations, while an open conversation has an agent seated with the role, and
otherwise SHALL delete the file.

A missing common prompt, or a missing shipped role's file, SHALL leave that part out with a diagnostic, and agents carry
on. A team role whose file is missing or empty SHALL NOT be seated, and the refusal names the file: `conversations.seat`
is refused `invalid_input`, a handoff or invocation returns an error result to the calling agent, `jobs.create` is
refused `invalid_input` and creates nothing (S-001 REQ-012), a schedule fire is skipped with that reason (S-007
REQ-006), and `schedules.run` is refused `invalid_input` naming the file (S-007 REQ-008). An agent already seated
with it goes without that part, with a diagnostic.

#### AC-007.1 — A live edit

- **Given:** two running agents of different roles
- **When:** `instructions/common.md` is edited by hand
- **Then:** the next model request of each agent holds the new text, and neither was reseated

**Verification:** test — `test/service/instruction_files.test.ts`.

#### AC-007.2 — Role operations write the file

- **Given:** a running daemon
- **When:** a team member creates role `reviewer` with instructions, changes them, then removes the role
- **Then:** `instructions/roles/reviewer.md` holds the first text, then the second, then is gone, and `config.toml`
  holds no instruction text

**Verification:** test — `test/service/role_operations.test.ts`.

#### AC-007.3 — Missing files

- **Given:** a deleted `instructions/common.md`, and a team role `reviewer` whose file is deleted
- **When:** a `bob` agent makes a model request, and a team member seats `reviewer` in a conversation
- **Then:** the `bob` prompt goes without the common prompt and the daemon logs a diagnostic; the seat is refused
  `invalid_input` naming `instructions/roles/reviewer.md`

**Verification:** test — `test/service/instruction_files.test.ts`.

#### AC-007.4 — A hand edit and a seated agent protect the file

- **Given:** team role `reviewer`, read with `roles.list`, then its file edited by hand, and a running agent seated as
  `reviewer`
- **When:** a team member calls `roles.change` with new instructions and the old token, then `roles.remove`
- **Then:** both are refused `conflict`, the change naming the file and the removal naming the conversation, and the
  file keeps the hand edit

**Verification:** test — `test/service/role_operations.test.ts`.

#### AC-007.5 — Every way of seating a role whose file is missing

- **Given:** team role `reviewer` whose instruction file is deleted
- **When:** a team member calls `jobs.create` naming `reviewer`, and a running agent hands off to `reviewer`, then
  invokes a `reviewer` agent
- **Then:** `jobs.create` is refused `invalid_input` naming the file and creates no job; the handoff and the invocation
  each return an error result naming the file, and the calling agent keeps its seat

**Verification:** test — `test/service/instruction_files.test.ts`.

### REQ-008 — The `skill` tool

Every agent, the front desk included, SHALL be offered `skill`, whatever its role's tool set. Given the name of a skill
enabled for that agent, it SHALL return the text of its `SKILL.md`; given also a `file` path relative to the skill
folder, the text of that file. It SHALL refuse a skill that isn't enabled for the agent, a path that, as written,
leaves the skill folder, and a file that is missing, each with an error the agent sees. A symbolic link inside the
skill folder is followed wherever it leads (REQ-016). It SHALL return text within the same size limit
as pi agent's `read` tool. The system prompt's skill listing SHALL tell the agent to load skills with `skill`.
Frontmatter fields other than `name` and `description` SHALL be ignored.

#### AC-008.1 — The front desk reads a skill

- **Given:** the front desk with its default `about-the-intern` skill and no file tools
- **When:** the fake model calls `skill` with `about-the-intern`
- **Then:** the result is the skill's `SKILL.md` text

**Verification:** test — `test/service/skill_tool.test.ts`.

#### AC-008.2 — Refusals

- **Given:** a `gp` agent
- **When:** it calls `skill` with `about-the-intern` (not enabled for it), then with `carry-out-a-part` and file
  `../../instructions/common.md`, then with a file that doesn't exist
- **Then:** each call returns an error naming the reason, and no file text

**Verification:** test — `test/service/skill_tool.test.ts`.

#### AC-008.3 — A real model uses skills

- **Given:** a daemon with a real low-cost model over the service account's pi agent login
- **When:** `npm run test:live:skills -- --model <provider/id>` asks the front desk how to add a skill search path, then
  starts a `gp` job asked to enable a search-path skill `lint` for itself through `bob` and use it
- **Then:** it exits 0; the front desk's transcript shows a `skill` call for `about-the-intern` and an answer naming
  `bob skills add-path`; the job's transcript shows the `bob skills enable` command and a later `skill` call for `lint`

**Verification:** demonstration — the command above, its output recorded in the task's Work Log.

### REQ-009 — Listing skills and instructions

`skills.list` SHALL return, for a role (its role catalog) or a conversation (its agent's catalog), every skill with its
name, description, source (internal, a search path, or the workspace), path, whether it is enabled for that role or
agent, and for a shipped skill whether it is edited; the shadowed copies with their paths; the enabled names the catalog
doesn't hold, marked missing; and the skills left out, with the reason. For a conversation it SHALL also return the
agent's seat. `instructions.list` SHALL return the instruction files that build that prompt in REQ-007's order, the
workspace's parent folders included, each with its kind, path and whether it is shipped, edited or missing. Neither
SHALL return file text.

#### AC-009.1 — An agent's view

- **Given:** a `bob` agent in a registered workspace that holds an `AGENTS.md`, with `code-review` enabled for it
- **When:** a team member calls `skills.list` and `instructions.list` for its conversation
- **Then:** the skills show `about-the-intern`, `bob-command-line` and `code-review` enabled with their paths, and the
  instructions list the common prompt, `bob`'s file and the workspace's `AGENTS.md`, in that order

**Verification:** test — `test/service/skill_operations.test.ts`.

### REQ-010 — Editing file text through the service

`files.read` SHALL return the text of one of the files below with a version token, and `files.write` SHALL replace it
when the token still matches the file on disk, writing atomically and keeping the file's permissions. A file changed
since the token was read SHALL be refused `conflict`. Both SHALL accept only paths that name these files:

- a file inside a skill folder found in the internal folder, a search path, or a registered workspace's `.pi/skills`
- a file in the internal folder's `instructions` folder
- a context file of a registered workspace: a file directly inside the workspace or one of its parent folders named as
  pi agent names its context files (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` or `CLAUDE.MD`),
  whether or not pi agent reads it there in place of another; `instructions.list` lists only the one it reads

A path that names one of these files SHALL be accepted wherever its symbolic links lead, inside or outside the
workspace, skill folder or internal folder; the file is read and written at the link's target. The operating system's
permissions for the service account decide whether that target can be read or written, and the service SHALL make no
check of its own on where a link leads (REQ-016). Any other path SHALL be refused `invalid_input`, a file that doesn't
exist, a link whose target doesn't exist included, `not_found`, a file the operating system refuses to read or write
`invalid_input` naming the system's reason, and a file that isn't UTF-8 text or is larger than 1 MiB `invalid_input`.
Neither SHALL create or delete a file. An edit SHALL take effect as REQ-007 states, and SHALL be published as
`files_changed`.

#### AC-010.1 — A write after a hand edit

- **Given:** a team member read `instructions/common.md` with `files.read`
- **When:** the file is edited by hand, then `files.write` is called with the old token
- **Then:** the call is refused `conflict`, and the file keeps the hand edit

**Verification:** test — `test/service/file_operations.test.ts`.

#### AC-010.2 — Paths outside the allowed files

- **Given:** a running daemon
- **When:** `files.read` is called for `/etc/passwd`, for `config.toml`, and for a skill file that doesn't exist
- **Then:** the first two are refused `invalid_input`, the third `not_found`

**Verification:** test — `test/service/file_operations.test.ts`.

#### AC-010.3 — A write is announced

- **Given:** a team member subscribed to the instance feed
- **When:** `files.write` saves `instructions/roles/gp.md`, and `instructions.restore gp` runs after it
- **Then:** two `files_changed` deltas arrive, each naming the file and its kind; a hand edit of the same file sends
  none

**Verification:** test — `test/service/file_operations.test.ts`.

#### AC-010.4 — A parent folder's file and a link out of the workspace

- **Given:** a registered workspace `/srv/work/app` whose `AGENTS.md` is a symbolic link to `/srv/notes/app.md`
  outside the workspace, and a parent folder file `/srv/work/AGENTS.md`, both readable and writable by the service
  account
- **When:** a team member reads each file with `files.read` and saves it with `files.write`
- **Then:** each call succeeds; the save of the workspace's `AGENTS.md` changes `/srv/notes/app.md` and leaves the link
  in place, and each save is published as `files_changed`

**Verification:** test — `test/service/file_operations.test.ts`.

### REQ-011 — Reading an older configuration

S-002 REQ-002 step 1 SHALL accept the two older forms below and check them as before. Right after the internal folder
is seeded (REQ-002), the daemon SHALL convert them:

- A role's `instructions` value is written to that role's instruction file, and the key is removed. For a shipped role
  the file then counts as edited, because it holds the team's text.
- An absolute path in a role's `skills` is replaced by the skill's name, and the skill's own folder is added as a
  search path, after the existing ones, if not already one. Only that skill joins the catalog, not its siblings.

The file SHALL be rewritten once, atomically, before the daemon reports ready, and the role SHALL get the same
instructions and skills as before. The daemon SHALL stop startup with an error naming the role and the path, before it
rewrites anything, when a path holds no valid skill, when two migrated paths give the same skill name, or when a path
fails REQ-004's check for a search path; the error says that the folder must be accessible only to the service account.

#### AC-011.1 — An instance from S-007's version

- **Given:** a `config.toml` with `[roles.reviewer]` holding `instructions = "..."` and `skills =
  ["/home/you/skills/code-review"]`, where `/home/you/skills` also holds `carry-out-a-part` and both folders are `0700`
- **When:** this version starts
- **Then:** `instructions/roles/reviewer.md` holds the text, `[skills] paths` holds `/home/you/skills/code-review`, the
  role's `skills` is `["code-review"]`, a `reviewer` agent's prompt holds the same instructions and skill as before,
  and `gp` still uses the internal `carry-out-a-part`

**Verification:** test — `test/service/config_migration.test.ts`.

#### AC-011.2 — A migration that can't keep behaviour stops

- **Given:** in turn, a role skill path whose folder other accounts can read, and two roles whose paths give the same
  skill name from different folders
- **When:** this version starts
- **Then:** startup stops with an error naming the role and the path, and `config.toml` is unchanged

**Verification:** test — `test/service/config_migration.test.ts`.

### REQ-012 — The `bob skills` and `bob instructions` commands

The commands in Interfaces SHALL call the operations named there, follow S-005's conventions, and print names, paths,
sources and marks, never file text. `list` SHALL show shadowed copies under the copy in use, and mark enabled, missing,
edited and left-out skills. Exactly one of `--role` or `--conversation` SHALL be required where both are offered; none
or both is a usage error.

#### AC-012.1 — List, enable and restore

- **Given:** a running daemon
- **When:** a team member runs `bob skills enable code-review --conversation 5`, `bob skills list --conversation 5`
  and `bob skills restore carry-out-a-part`
- **Then:** each exits 0, the list shows `code-review` enabled with its path, and `--json` prints what the operation
  returned

**Verification:** test — `test/service/skills_commands.test.ts`.

#### AC-012.2 — A usage error

- **Given:** any instance
- **When:** a team member runs `bob skills list` with no flag, and with both flags
- **Then:** each prints usage on standard error and exits 2

**Verification:** test — `test/unit/skills_commands.test.ts`.

### REQ-013 — The Skills panel and file editing on the web

The web interface SHALL offer a Skills panel for a role, from the Roles page and from a Schedules page entry (the
entry's role, or `bob` when the entry names none, S-001 REQ-012), and for an agent, from each conversation on a Job
page, To do and In progress jobs included. The panel SHALL show what `skills.list` returns, with a check box per skill
that calls `skills.enable` or `skills.disable`, and SHALL open any listed skill file and any instruction file in
`instructions.list` to show and edit its text through `files.read` and `files.write`. A refused save SHALL show the
reason and keep what the team member typed (S-006 REQ-013); on a `conflict` the page SHALL also offer the current text
from disk to load in its place. The Roles page SHALL offer the common prompt for editing, the search paths with add and
remove, and restore for each shipped file. The Job page SHALL show each `intern.skills` entry in the conversation's
activity, in order with its other entries, with its actor, the skill and whether it was enabled or disabled. The web
interface SHALL NOT create or delete skill folders. The pages SHALL meet S-006's style, words, accessibility and browser
requirements.

#### AC-013.1 — Switch a skill for a working agent

- **Given:** job W-12 In progress, its lead running as `bob`
- **When:** a team member opens its Skills panel on the Job page and checks `code-review`
- **Then:** the panel shows `code-review` enabled, and `skills.list` for the conversation agrees

**Verification:** test — `test/web/skills_panel.test.ts`.

#### AC-013.2 — Edit and conflict

- **Given:** the common prompt open in the editor
- **When:** the file is edited by hand, then the team member saves
- **Then:** the page shows the conflict, keeps the typed text, and loads the hand-edited text when the team member
  chooses it

**Verification:** test — `test/web/skills_panel.test.ts`.

#### AC-013.3 — A skill change in the activity

- **Given:** a Job page open on job W-12
- **When:** a team member enables `code-review` for its lead through `bob skills enable`
- **Then:** the lead conversation's activity shows the change at once, naming the team member, `code-review` and
  enabled

**Verification:** test — `test/web/skills_panel.test.ts`.

### REQ-014 — Agents use `bob`

An agent with the `bash` tool SHALL be able to run every `bob` command of this spec against its own instance over the
local socket, as the service account (ADR-002, S-003), and an enabled-set change it makes for its own conversation
SHALL apply from its next model request (REQ-006). The `bob-command-line` skill SHALL tell the agent how to find its own
conversation id.

#### AC-014.1 — An agent enables a skill for itself

- **Given:** a `gp` agent with `bob-command-line` enabled and a search path holding `lint`
- **When:** the fake model runs `bob skills enable lint --conversation <its id>` through `bash`
- **Then:** its next model request lists `lint`

**Verification:** test — `test/service/agent_skills.test.ts`.

## Quality Requirements

### REQ-015 — A stable prompt

When no instruction file, enabled set or skill folder an agent uses has changed, its system prompt SHALL be
byte-identical from one model request to the next, so the provider's prompt cache holds. A change SHALL alter only the
parts it touches.

#### AC-015.1 — No change, same bytes

- **Given:** an agent making three model requests with nothing changed
- **When:** the prompts are compared
- **Then:** they are byte-identical; after a skill is enabled, only the skill listing differs

**Verification:** test — `test/unit/role_prompt.test.ts`.

### REQ-016 — Trusted input

The internal folder, search paths and workspaces are trusted input: owner-only, checked when added (REQ-002, REQ-004).
`files.read`, `files.write` and the `skill` tool SHALL accept a path by the file it names (REQ-008, REQ-010) and SHALL
follow its symbolic links wherever they lead, with no check of their own on where the target is. The operating
system's permissions for the service account SHALL decide whether the target can be read or written: The Intern
doesn't confine file operations by design. A target the system refuses SHALL give an error naming the system's reason.

#### AC-016.1 — A link out of the skill folder

- **Given:** an enabled skill whose folder holds a symbolic link `notes.md` to a file outside the folder that the
  service account can read, and a link `secret.md` to a file outside the folder that it can't read
- **When:** an agent calls `skill` with each file, and a team member calls `files.read` for each
- **Then:** for `notes.md` both return the target's text; for `secret.md` the `skill` call returns an error naming the
  system's reason, such as permission denied, and `files.read` is refused `invalid_input` naming it

**Verification:** test — `test/service/skill_tool.test.ts`.

### REQ-017 — Documentation

The user manual SHALL describe the internal folder, the search paths and priority, enabling skills, the `skill` tool,
editing and restoring, upgrades and the commands and panel. The `about-the-intern` skill SHALL be drawn from the
manual, and a check in `npm run check` SHALL fail when the skill and the manual pages it draws from disagree.

#### AC-017.1 — The manual and the skill agree

- **Given:** a change to a manual page the skill draws from, without updating the skill
- **When:** `npm run check` runs
- **Then:** it fails naming the page

**Verification:** test — `test/unit/about_the_intern_skill.test.ts`, run by `npm run check`.

## Configuration Requirements

- **Skill search paths.**
  - **What:** the folders, besides the internal folder, that skills come from (REQ-004).
  - **Where:** `[skills] paths` in `config.toml`, changeable while the daemon runs (S-002 REQ-022).
  - **Constraints:** absolute, existing folders accessible only to the service account; no duplicates; order is
    priority, a later path winning over an earlier one (REQ-004).
  - **Missing:** only the internal folder and workspaces. An invalid path in the file stops startup with an error
    naming it.
- **A role's skills.**
  - **What:** the skill names a role enables by default (REQ-005).
  - **Where:** `skills` in `[roles.<name>]`.
  - **Constraints:** names; an absolute path is read as REQ-011 states.
  - **Missing:** an empty list for a team role; the running version's defaults for a shipped role (REQ-001, REQ-005). A
    name the catalog doesn't hold is listed missing and doesn't stop startup.
- **Instruction files.**
  - **What:** the common prompt and each role's instructions (REQ-007).
  - **Where:** the internal folder (Interfaces).
  - **Constraints:** UTF-8 text; a team role's file must exist and be non-empty to seat it.
  - **Missing:** seeded from the shipped content (REQ-002); a missing shipped file is left out with a diagnostic.

## Assumptions and Dependencies

- Skills follow the Agent Skills format that Claude, Codex and pi agent share: a folder with `SKILL.md` whose
  frontmatter gives `name` and `description`. pi agent's skill loader reads this format (confirmed in
  `@earendil-works/pi-coding-agent`, `dist/core/skills.js`).
- pi-durable resolves a conversation's agent before every model request (S-001 Definitions), so prompt parts can be
  read again per request.
- Agents reach `bob` from `bash` on the machine as the service account, without authentication (ADR-002, S-003).
- The user manual exists and is built by `npm run docs:build` (S-000 User manual).

## Success Criteria

1. A fresh instance holds the shipped content in `<data dir>/instructions` and `<data dir>/skills`, and `bob skills
   list --role <role>` shows REQ-001's defaults for each shipped role (REQ-001, REQ-002).
2. An edit to `instructions/common.md` appears in a running agent's next model request, checked by the service test
   (REQ-007).
3. An upgrade test shows unedited shipped files replaced and edited ones kept (REQ-003).
4. `bob skills list --conversation <id>` shows the source path of every enabled skill and each shadowed copy
   (REQ-004, REQ-009, REQ-012).
5. A team member enables a skill for a running agent from the web and from `bob`, and the next model request lists it
   (REQ-006, REQ-012, REQ-013).
6. `npm run test:live:skills` exits 0 with a real model: the front desk answers from `about-the-intern` through
   `skill`, and a `gp` agent enables a skill for itself through `bob` (AC-008.3; REQ-001, REQ-008, REQ-014).
7. An instance whose configuration has role instructions and skill paths starts with the same prompts as before
   (REQ-011).
8. `npm run check` passes with the manual-and-skill check in place (REQ-017).

## Implementation Order

1. **The internal folder and instruction files.** Seeding, the upgrade rule, restore, instructions read per request,
   role operations writing files, and the migration of `instructions`. Outcome: the common prompt and role files are
   edited in place and live. Depends on nothing new.
2. **The skill catalog and the `skill` tool.** Search paths, priority, roles naming skills, the path migration, the
   per-agent enabled set and `skill`. Outcome: agents get skills by name and switch them while running. Depends on 1.
3. **Operations and commands.** `skills.*`, `instructions.*`, `files.*` and the `bob skills` and `bob instructions`
   commands. Outcome: the command line inspects and changes everything above. Depends on 2.
4. **Web interface.** The Skills panel, file editing, the Roles page section. Outcome: the same from the browser.
   Depends on 3.
5. **Shipped skills and documentation.** `about-the-intern`, `bob-command-line`, the manual, the sync check, and the
   live test `npm run test:live:skills`. Depends on 3; the manual covers 4.

## Open Questions

- **Frontmatter that changes the agent** (model, thinking level, tools). Owner: product owner. Resolution condition: a
  later spec or change request; in this version such fields are ignored (REQ-008), so no behaviour here depends on it.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-15 | spec-truth reconciliation — FAIL | v0.1 confirmed against T-327 to T-387 and B-036 to B-039, except: REQ-013 panel and editor layout (B-040, open); REQ-010 and REQ-016, files.read and files.write follow a workspace AGENTS.md or CLAUDE.md link out of the workspace (resolved by v0.2, product owner decision, tasks T-392 to T-394); REQ-007, the Roles page and manual say a save rewrites a missing role file that roles.change refuses (follow-up tasks T-389 to T-391) | none |
| 2026-11-15 | v0.2. REQ-010: `files.read` and `files.write` accept only skill files, files in the internal folder's `instructions` folder, and the context files of a registered workspace: a file directly inside the workspace or one of its parent folders named as pi agent names its context files (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` or `CLAUDE.MD`), whether or not pi agent reads it there in place of another, while `instructions.list` lists only the one it reads; and follow symbolic links wherever they lead, with no check on the target; a file the operating system refuses is refused `invalid_input` naming the system's reason; new AC-010.4. REQ-016 and AC-016.1: the link checks are dropped; `files.read`, `files.write` and `skill` follow links, and the operating system's permissions decide. REQ-008 and Workflow: `skill` refuses a path that leaves the skill folder as written, and follows a link inside it. Definitions, Instruction file: a workspace's context file, of the workspace and its parent folders. Exclusions: "Confining file operations". Alternatives Considered: refusing links out of a folder and parent folders' context files. REQ-004's owner-only check of search paths is unchanged. No identifier changed or retired. S-006 v0.8 widens its exclusion's exception to any file named as pi agent names its context files in the workspace and its parent folders. | Product owner decision of 2026-11-15, after the S-008 spec-truth reconciliation: "We don't stop any filesystem operations, the OS user permissions are the deciding rules." Architecture consistency review of v0.2: finding F1, REQ-010 named only `AGENTS.md` and `CLAUDE.md`, so a listed `AGENTS.override.md` would have been refused; finding F2, REQ-010 accepted only the file `instructions.list` lists, so a context file pi agent reads in place of another one shadows, such as an `AGENTS.md` beside an `AGENTS.override.md`, couldn't be opened, and "a skill file or an instruction file" didn't cover every accepted file. | T-392, T-393, T-394 |
| 2026-11-15 | spec-truth reconciliation — FAIL | v0.2 confirmed against B-040 and T-389 to T-394 (REQ-008, REQ-010, AC-010.4, REQ-013, REQ-016, AC-016.1, REQ-017), except REQ-007: roles.change with the token roles.list returned, for a file deleted since, is refused invalid_input, not conflict (follow-up task T-395) | none |
| 2026-11-16 | spec-truth reconciliation — PASS | v0.2 confirmed: REQ-007 roles.change with a token for a role instruction file deleted since is refused conflict naming the file and the remedy, invalid_input without a token (T-395); no other S-008, S-001, S-002, S-005 or S-006 statement changed by the delta | none |
| 2026-11-18 | v0.3. Email (S-009). REQ-001: The Intern ships the `triage` role's instructions (S-009 REQ-019); the shipped skills table enables `about-the-intern` by default for `triage` too, and `bob-command-line` teaches `bob mail`; the common prompt tells agents that mail texts and the mail they send show no internals (short numbers, job, conversation and request IDs, role and tool names, saved-mail paths) unless the person asked (S-009 REQ-016). AC-001.2: the common prompt's topics include mail without internals, and `bob-command-line` names commands of S-009 too, `bob mail` among them. No identifier added or retired. | Cross-spec amendment carried by S-009 Email; approved by the product owner at Gate 1 with S-009, 2026-11-18. | S-009's tasks |
| 2026-11-21 | spec-truth reconciliation — PASS | v0.3 confirmed after B-053: the shipped triage instructions and the `about-the-intern` manual copy changed as REQ-001 allows, the copy identical to docs/manual/email.md; no common prompt, prompt part or REQ-007 rule changed | none |
