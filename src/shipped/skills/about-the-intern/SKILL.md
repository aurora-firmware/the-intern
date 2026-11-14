---
name: about-the-intern
description: "Explain how The Intern works and how a team member uses and configures it, from the user manual. Use it to answer questions about jobs, roles, workspaces, schedules, skills and instructions, the front desk, the `bob` commands, the web interface and running the service."
---

# About The Intern

This skill holds the pages of The Intern's user manual. Answer from them rather than from memory, and say so when a
page doesn't cover the question.

## Load a page

Load a page with the `skill` tool: give it the name `about-the-intern` and the path of the page, for example
`manual/jobs.md`. With no path, `skill` returns this file. When you have the `file` tool, you can read the same pages
by their path in the skill's folder. A long page comes back in parts, so ask for the next part when the answer isn't
in the first.

## The pages

- `manual/jobs.md`: what a job is, how it moves from To do to Done, and how a team member creates, follows, edits,
  answers and ends one.
- `manual/roles_and_agents.md`: the roles The Intern ships, how roles and workspaces are configured, and how agents
  share the work of a job.
- `manual/schedules.md`: recurring work: schedule entries, due times and scheduled runs.
- `manual/front_desk.md`: the front desk, what it does and doesn't do, and talking to it with `bob chat`.
- `manual/skills_and_instructions.md`: where the common prompt, role instructions and skills are, how skills are found
  and enabled, how to change them and how upgrades treat the changes.
- `manual/commands.md`: every `bob` command with its arguments, options, JSON output and exit codes.
- `manual/web_interface.md`: the web interface: the board, the job page and the other pages, and the actions they offer.
- `manual/running_the_intern.md`: running the service: starting it, where it keeps its files, backups and restores, the
  configuration file, models and the pi login, reaching it over the network and who can use it.

Pick the page by the question. A question about doing something at the command line usually needs `manual/commands.md`
as well as the page on the topic.
