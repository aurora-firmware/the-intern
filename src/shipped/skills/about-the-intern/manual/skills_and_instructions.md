# Skills and instructions

The text that steers an agent lives in files you can read and edit: the common prompt, each role's instructions and
the skills. This page describes where the files are, how skills are found and enabled, how you change them and how
upgrades treat your changes.

An agent's system prompt is built from these parts, in this order:

1. the common prompt, the same for every agent;
2. the instructions of the agent's role;
3. the `AGENTS.md` or `CLAUDE.md` files of the agent's workspace and its parent folders;
4. the list of the agent's enabled skills, which tells the agent to load a skill with the `skill` tool.

The Intern adds a few lines of its own to the prompt, such as the agent's first duty as a job's lead and the notice of
a scheduled run. Those lines are not in any file, so an edit can't remove them.

## The internal folder

The Intern keeps the text it ships in one folder of its own, under the data directory (see
[Where The Intern keeps its files](running_the_intern.md#where-the-intern-keeps-its-files)). It has three paths:

| Path | Holds |
| ---- | ----- |
| `<data dir>/instructions/common.md` | The common prompt. |
| `<data dir>/instructions/roles/<role>.md` | A role's instructions, for the shipped roles and for your own. |
| `<data dir>/skills/<name>/SKILL.md` | A shipped skill, with its bundled files beside it. |

The folder is the only live copy. The service copies each shipped file into it the first time it starts and never
writes to the installed package, so your edits stay when you reinstall. Only the service account can use the folder
and its files.

The shipped skills are:

| Skill | What it teaches | Enabled by default for |
| ----- | --------------- | ---------------------- |
| `carry-out-a-part` | How to carry out a part of a job to completion and report back. | `gp` |
| `about-the-intern` | How The Intern works and how you use and configure it. | `bob`, `desk` |
| `bob-command-line` | How an agent uses the `bob` commands from `bash`. | `bob`, `gp` |

## Edit the text

You change a file in place, by any of these means:

- **By hand.** Open the file with your own editor.
- **On the web.** Select **Edit** beside a file in the [Skills panel](web_interface.md#the-skills-panel), or beside the
  common prompt on the Roles page. See [Edit a file](web_interface.md#edit-a-file).
- **Through an agent.** An agent with file tools edits the same files. Ask it, for example, to improve a skill.

Every file is read again before each model request, so an edit reaches every running agent it touches from the
agent's next request. No restart and no reseating is needed. The same holds for a skill folder you add or remove, and
for a change to the skills an agent has enabled.

The web page and `bob roles change` write a file only if it is as they last read it. If you edited the file by hand in
the meantime, the save is refused as a conflict, and the web page keeps your typing and offers the text now on disk.
A hand edit is never overwritten.

If the common prompt, or a shipped role's file, is deleted, agents go without that part and the service logs why. A
role of your own whose file is missing or empty can't be seated, and the refusal names the file.

## Where skills come from

A skill is a folder holding a `SKILL.md` file, in the shared Agent Skills format. The file starts with a `name` and a
`description`; other frontmatter fields are ignored. An agent sees the skills in its catalog, which the service builds
from three sources. From lowest to highest priority:

1. the internal folder's `skills` folder;
2. each skill search path, in the order of `[skills] paths` in `config.toml`;
3. the agent's workspace, in `<workspace>/.pi/skills`.

When two sources hold a skill with the same name, the one from the higher source is used and the other is shadowed.
A later search path therefore wins over an earlier one, and the workspace wins over all. Inside one source, the copy
whose folder path sorts first is used, and the others are shadowed. `bob skills list` shows each shadowed copy under
the copy in use.

A search path is a folder that is itself a skill, or a folder holding skills at any depth below it. Keep it for skills:
the service walks it before each model request, so a large folder slows every request.

```toml
[skills]
paths = ["/srv/team-skills", "/home/intern/more-skills"]
```

A search path must be an absolute path to an existing folder that only the service account can use. Add one with
`bob skills add-path <path>` or on the Roles page. The service refuses a path that fails this check and changes
nothing. A path that fails it in `config.toml` stops startup with an error that names it. A skill folder you add to a
search path or remove from it is seen at the next model request.

A skill whose `SKILL.md` can't be read, or has no description, is left out, and `bob skills list` and the Skills panel
say why. The other skills are not affected.

## Enable skills

A skill reaches an agent only when it is enabled for that agent. Each agent has its own enabled set:

- **A role's default skills.** The `skills` list of a role names skills, not folders. An agent seated with the role
  starts with that list.
- **An agent's own set.** After that, you or the agent change the set for that one agent, and it applies from the
  agent's next model request.

```toml
[roles.reviewer]
skills = ["code-review", "about-the-intern"]
```

Changing a role's list affects only agents seated with the role afterwards. Agents already working keep their own
set. A shipped role with no `skills` key gets the defaults of the running version. Once you change a shipped role's
skills, its list is yours, and an upgrade doesn't change it. A name in the list that no skill matches doesn't stop
startup: `bob skills list` shows it as `missing:` and the agent goes without it.

The skills of an agent's workspace are always enabled, and you can't disable them.

An agent's enabled set survives a restart, a reset and a compaction. A change of the agent's seat, by a handoff or
`bob conversations seat`, resets it to the new role's defaults. Enable a skill again after a seat change if the agent
still needs it. Each change you or an agent make to an agent's set shows in the job's activity as a **Skill changed**
entry that names who made it.

Enable and disable skills with:

```
bob skills enable code-review --role gp
bob skills enable code-review --conversation 5
bob skills disable code-review --conversation 5
```

## The `skill` tool

Every agent, the front desk included, has the `skill` tool, whatever its role's tools are. The agent gives it the name
of an enabled skill and gets the text of that skill's `SKILL.md`. It can also give a path inside the skill's folder
and get that file. The tool refuses a skill that isn't enabled for the agent, a path written to leave the skill's
folder, such as `../other.md`, and a file that doesn't exist. It follows a symbolic link inside the skill's folder
wherever it leads. Whether the target can be read depends on the permissions of the account The Intern runs as, and a
refusal shows the system's reason. The agent sees the error and carries on. Run scripts that a skill bundles with the
agent's `bash` tool; `skill` only reads.

## Restore a shipped file

Restore copies the installed version of a shipped file back, over your edits or in place of a deleted copy:

```
bob skills restore carry-out-a-part
bob instructions restore common
bob instructions restore reviewer
```

The last command works for a shipped role only; for a role of your own it is refused, because The Intern has no
installed version of it. A restore of a skill replaces the whole skill folder, so files you added to it go too. The
Roles page has **Restore** beside the common prompt, each shipped role and each shipped skill. A restored file counts
as unedited again.

## Upgrades keep your edits

When a new version ships new text, the service updates each shipped file you haven't edited, adds the files that are
new and leaves your edited files as they are. A shipped file you deleted stays deleted. A file the version no longer
ships is removed if you haven't edited it, and kept if you have.

`bob skills list` and `bob instructions list` mark a changed shipped file `edited`, and a deleted skill `deleted`. To
get the new text of an edited file, restore it. That replaces your edit, so copy what you want to keep first.

The service never overwrites a file it didn't write. If you put a file at a path that a later version starts to ship,
your file stays and counts as edited.

### The record of shipped files

`<data dir>/shipped-files.json` is the daemon's own record of the shipped files it last copied. The service compares
each file against it to decide what you edited. Don't edit, move or delete it. Changing it changes what counts as
edited, so an upgrade can overwrite an edit or keep text you meant to replace. A data directory that you wipe takes
the record with it, and the service then copies the shipped files again.

## Configuration files from an earlier version

An earlier version kept a role's instructions as an `instructions` string in `config.toml`, and a role's skills as
absolute folder paths. At the first start of this version the service converts both, rewrites `config.toml` once and
keeps each role's instructions and skills as they were:

- The `instructions` text moves to the role's file, `instructions/roles/<role>.md`, and the key is removed. For a
  shipped role the file then counts as edited, because it holds your text.
- Each path in a role's `skills` becomes the skill's name. The skill's folder is added to `[skills] paths`, after the
  existing paths, and only that skill joins the catalog, not its siblings.

The service stops startup, with an error that names the role and the path, and changes nothing, when:

- a path holds no valid skill, or holds more than one;
- two paths give the same skill name;
- a folder is reachable by other accounts. Run `chmod 700` on it, or use another folder.

::: warning A role skill path into the previous package stops startup
An earlier version shipped the `gp` skill inside its package, in `src/roles/shipped/skills/`, and a role could name
that folder, for example `<package>/src/roles/shipped/skills/carry-out-a-part`. This version no longer ships that
folder, and a package folder is usually reachable by other accounts. A role whose `skills` still holds such a path
stops startup, because the folder is gone or other accounts can reach it. Before you start the new version, open
`config.toml` and replace the path with the skill's name, for example `skills = ["carry-out-a-part"]`. The shipped
skills are already in the internal folder, so they need no search path.
:::

## The commands and the panel

The commands are in the [Command reference](commands.md#skills):

| Command | What it does |
| ------- | ------------ |
| `bob skills list` | Lists the skills of a role or of a conversation's agent, with their source, path and marks. |
| `bob skills enable`, `bob skills disable` | Change the enabled skills of a role or of one agent. |
| `bob skills paths`, `add-path`, `remove-path` | List and change the search paths. |
| `bob skills restore` | Restores a shipped skill. |
| `bob instructions list` | Lists the files that build a prompt, in order. |
| `bob instructions restore` | Restores the common prompt or a shipped role's instructions. |

No command prints a file's text or changes it: read and edit files with your own tools, or on the web.

[The web interface](web_interface.md#the-skills-panel) has the same views and changes in the Skills panel, which opens
from a role on the Roles page, from each conversation on a Job page and from a schedule entry. It adds editing for the
files. The Roles page also holds the common prompt, the search paths and the restore buttons. The web interface can't
create or delete a skill folder: put the folder in a search path or in a workspace's `.pi/skills`.
