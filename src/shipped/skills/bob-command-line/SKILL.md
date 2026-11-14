---
name: bob-command-line
description: Use the `bob` commands from bash to read and manage The Intern: jobs, conversations, roles, workspaces, schedules, skills and instructions. Use it when you need to look at or change something in The Intern itself.
---

# The `bob` command line

`bob` is the command line of The Intern. Run it from your `bash` tool: it reaches your own instance, as the same version
of The Intern that runs you. You need no setup, and `$BOB_RUNTIME_DIR` already points at the instance.

## Your conversation id

Your conversation id is in the environment variable `$BOB_CONVERSATION_ID`. Use it wherever a command takes
`--conversation <id>` or `<id>` and the conversation is yours. Don't guess an id and don't read one from another source.

```
bob skills list --conversation $BOB_CONVERSATION_ID
bob skills enable code-review --conversation $BOB_CONVERSATION_ID
```

## How the commands behave

- Add `--json` to any command to get its answer as JSON. Prefer it when you read the output with a script.
- Data goes to standard output. Errors go to standard error. The exit code is 0 for success, 1 when The Intern refused
  or failed (standard error holds the reason), 2 for a usage error and 3 when no daemon answers.
- `bob <group> --help` and `bob <group> <command> --help` list the commands and options at each level.
- Commands act at once and in the name of the service account, so check the id or name before you change anything.

## Skills

Change what skills you have, from your next model request on.

- `bob skills list --conversation $BOB_CONVERSATION_ID` lists the skills you can enable, where each one comes from, and
  which are enabled. It prints names and paths, never a skill's text. Load a skill's text with the `skill` tool.
- `bob skills enable <name> --conversation $BOB_CONVERSATION_ID` and
  `bob skills disable <name> --conversation $BOB_CONVERSATION_ID` change your own set. A name The Intern doesn't know is
  refused.
- `bob skills list --role <role>`, `bob skills enable <name> --role <role>` and
  `bob skills disable <name> --role <role>` read and change the defaults of a role, which apply to agents seated
  afterwards.
- `bob skills paths`, `bob skills add-path <path>` and `bob skills remove-path <path>` manage the folders skills are
  searched in. A path is absolute.
- `bob skills restore <name>` brings a shipped skill back to its installed version.

Changing your seat resets your enabled skills to the new role's defaults.

## Instructions

- `bob instructions list --role <role>` and `bob instructions list --conversation $BOB_CONVERSATION_ID` list the files
  that build a prompt. It never prints their text.
- `bob instructions restore common` and `bob instructions restore <role>` bring the common prompt or a shipped role's
  instructions back to the installed version.

## Jobs

`<job>` is a job's short number, such as `C-14`, or its id.

- `bob jobs list` lists jobs, newest first. Narrow it with `--status` (`to_do`, `in_progress`, `blocked` or `done`),
  `--letter`, `--related <job>`, `--schedule <name>` and `--limit`.
- `bob jobs show <job>` shows a job, its latest worklog entries and its history.
- `bob jobs create <text>` creates a job from a request. It takes `--title`, `--role`, `--model`, `--thinking`,
  `--workspace` and `--stated-by`.
- `bob jobs update <job>` changes a job's `--title`, `--description` or `--definition-of-done`.
- `bob jobs relate <job> <other>` and `bob jobs unrelate <job> <other>` relate two jobs or remove the relation.
- `bob jobs answer <job> <text>` sends text to a job's lead, which resumes a Blocked job.
- `bob jobs complete <job> <justification>` completes an In-progress job, and
  `bob jobs cancel <job> <justification>` cancels a job. Each needs a justification.

## Conversations

- `bob conversations list` lists conversations, and `--job <job>` narrows it to one job.
- `bob conversations show <id>` shows a conversation's transcript and the conversations it invoked.
- `bob conversations send <id> <text>` sends text to a conversation. While it runs, the text steers it. `--follow-up`
  delivers it after the current run, and `--reject` refuses it while the conversation runs.
- `bob conversations stop <id>`, `bob conversations reset <id>` and `bob conversations compact <id>` abort the current
  run, empty the context, and compact it (`--instructions` says what to keep).
- `bob conversations seat <id>` seats a conversation in another role. It takes `--role`, `--model`, `--thinking`,
  `--workspace`, `--reset` and `--note`.

A conversation of a Done job is closed, and these commands refuse it. Don't stop or reset your own conversation unless
the job calls for it.

## Roles, workspaces and models

- `bob roles list` and `bob roles show <name>` read roles.
- `bob roles create <name>` and `bob roles change <name>` write a role with `--instructions`, `--tool`, `--skill`,
  `--model`, `--thinking` and `--workspace`; repeat `--tool` and `--skill` for several. `bob roles remove <name>` removes
  a team role, and `bob roles restore <name>` brings a shipped role back to its shipped definition.
- `bob workspaces list`, `bob workspaces register <path>` and `bob workspaces unregister <path>` manage workspaces.
- `bob models list` lists models and their thinking levels.

## Schedules

- `bob schedules list` and `bob schedules show <name>` read the entries and their recent runs.
- `bob schedules create <name>` and `bob schedules change <name>` write an entry with `--cron`, `--request`, `--role`,
  `--model`, `--thinking-level` and `--workspace`. `create` needs `--cron` and `--request`.
- `bob schedules remove <name>` removes an entry, and `bob schedules run <name>` starts its scheduled run now.

## The instance

- `bob status` shows the daemon's state, and `bob usage` shows usage per conversation and in total.
