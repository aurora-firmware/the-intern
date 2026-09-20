# Skills Coding Guidelines

These conventions apply to skill content shipped to users and agents:
`the-intern/bob-skills/skills/` (and its generated `.pi/skills/` mirror — never
hand-edit that copy; regenerate it with `bob-skills/package-pi-skills.sh`), the
`the-intern/bob-companion/claude/` plugin skills, and `the-intern/docs/` (the
mdBook user manual). A skill or user doc is content an agent or operator reads
and acts on directly outside this repository's own process, so it must stand
on its own — it cannot assume the reader has, or should have, any visibility
into how this project builds itself.

---

## 1. No references to this project's own tracking IDs

Shipped content must never carry references to this project's internal
task-tracking apparatus — ADR numbers (`ADR-NNN`), task IDs (`T-NNN`), bug IDs
(`B-NNN`), change-request IDs (`CR-NNN`), or spec IDs (`S-NNN`). Nothing under
`docs/ai-team/` is visible to, or relevant for, the person or agent using the
shipped product — it records the process that built the product, not the
product itself. A pitfall or workaround discovered while diagnosing bug B-050
belongs in a skill as a plain, self-contained description of the pitfall
("Observed: ..."), not as "(Observed, B-050)".

The reference is one-directional: a task, bug, spec, or ADR file is free to
cite the shipped file it changed ("fixed in `command-reference.md`'s Deleting
a Message section"), because that file is process state written for this
project's own contributors. Shipped content must never cite back.

This rule does not apply to `docs/ai-team/` itself (specs, ADRs, tasks, bugs,
reports), which is process state, not shipped product content, and is never
read by an end user or a deployed agent session.

## 2. Keep instructions generic to what they describe

A skill or user doc documents a tool, CLI, or workflow (himalaya, the `bob`
CLI, the AI-team process itself) — not one specific deployment or test
environment. Never let a value that only happens to be true in the
environment used to verify the content — an account address, a mailbox or
folder name, a file path under one particular user's home directory, a
hostname, a real person's name — become part of an instruction, a command
template, or a stated default.

Use an explicit placeholder (`<trash-folder>`, `<addr>`, `<id>`) for anything
the reader must resolve for their own setup, and say how to resolve it. Do
not present a value that happens to work in the verification environment as
if it were portable.

Real values are expected, and correct, inside an "Observed" transcript that
records what was actually run during verification — that is evidence of
behavior, not an instruction to copy. Keep the two visually and textually
distinct: a transcript documents what happened once, in one environment; a
recipe documents what any reader should type, and must not assume the
reader's environment matches the one that produced the transcript.
