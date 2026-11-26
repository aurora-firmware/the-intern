# The Intern user manual

This manual is for team members who install, configure and work with The Intern. Each section below is written
together with the feature it describes.

## Running The Intern

See [Running The Intern](running_the_intern.md): start the service, set its directories and configuration file,
and see which pi agent settings take effect.

## Installing and upgrading

See [Installing and upgrading](installing.md): the install script, signing in to pi, registering the
service, upgrading, rolling back, uninstalling and the upgrades folder.

## Giving The Intern access and accounts

This page comes with its feature.

## Giving The Intern email

See [Email](email.md): the owned and monitored kinds of account, the `[[mail_account]]` and `[mail]` sections and the
`bob mail` commands, signing in with a password, Google or Microsoft, the allowlist and the notice address, triage and
the request mark, the mail The Intern sends, the connection security choices and what an export leaves out.

## Configuring roles

See [Roles, workspaces and agents sharing a job](roles_and_agents.md): the shipped roles, the `roles` and
`workspaces` sections of the configuration file, and how agents hand off, invoke each other and report.

## Configuring skills

See [Skills and instructions](skills_and_instructions.md): the internal folder, skill search paths and their
priority, enabling skills for a role or one agent, the `skill` tool, restoring shipped files and how upgrades keep
your edits.

## Configuring instructions

See [Skills and instructions](skills_and_instructions.md#edit-the-text): edit the common prompt and a role's
instructions in place by hand, on the web or through an agent; an edit reaches running agents from their next model
request.

## Configuring knowledge sources

This page comes with its feature.

## Configuring schedules

See [Schedules](schedules.md): the `[[schedule]]` section and its keys, the `bob schedules` commands, the Schedules
page, run now, the skip rules, how time works, and how to read a schedule's run history.

## Giving and following jobs

See [Giving, following and answering jobs](jobs.md): what a job is, its short number, statuses and actions, and how
to create, follow, edit, complete, cancel and export a job.

## Answering questions

See [Giving, following and answering jobs](jobs.md#a-blocked-job): a Blocked job waits for your answer, and any
message to its lead resumes it.

## Using the web interface

See [The web interface](web_interface.md): the Board, Job page, Front desk, Roles, Workspaces, Schedules and
Status pages, how to share a job's address and download a backup, and why anyone who can reach the page can act and
download everything.
