# Developer documentation

This folder holds what a developer needs to start on The Intern. It holds no requirements: the specs and the accepted
decision records do. Read [S-000](../ai-team/specs/S-000-system-overview.md) first, because it is the source of truth
for scope.

## Documents in this folder

| Document | What it is for | Read it when |
|---|---|---|
| [architecture.md](architecture.md) | A high-level map of how The Intern fits together at runtime and which spec owns each part. | You are new to the code base, or you need to know which spec owns a part. |
| [tech_stack.md](tech_stack.md) | The recorded answers to the "Decisions needed" of the development infrastructure components in S-000: language, tools, checks, tests, continuous integration, release, manual. | You need to know which tool or setting is in use, or whether a question is still open. |
| [coding_guidelines.md](coding_guidelines.md) | The project-specific rules for writing code. | You write or review code. |
| [writing_style.md](writing_style.md) | How to write documents, tasks, reviews and commit messages: words, sentences, layout and the manual's tone. | You write or review any text. |
| [release_form.md](release_form.md) | The comparison of the ways to release The Intern, with a recommendation for the product owner. | You work on installation, the boot-time service or upgrades. |
| [local_runs.md](local_runs.md) | How to run your own instance, apart from a team's, and how to inspect it. | You want to run the service by hand against a real model. |
| [brand/](brand/) | The Aurora Firmware brand manual and the logo variants, for the style review of the web interface (S-006 AC-016.1). The web interface serves only `web/ui/assets/brand/`. | You review a page against the brand. |

## Where else to look

- [docs/AGENTS.md](../AGENTS.md): the map of the `docs/` folder and who updates what.
- [S-000](../ai-team/specs/S-000-system-overview.md) and the other specs in `docs/ai-team/specs/`: the requirements.
- `docs/ai-team/decisions/`: the accepted decision records, such as
  [ADR-001](../ai-team/decisions/ADR-001-one-daemon-process-owns-one-pi-durable-database.md) and
  [ADR-002](../ai-team/decisions/ADR-002-equal-team-members-bounded-by-the-service-account.md).
- [system_overview.html](../system_overview.html): the shared vocabulary (section 4) and the spec map (section 5).
- [pi-durable-knowledge.md](../research/pi-durable-knowledge.md): what is known about pi-durable and the pi agent SDK,
  the prototype results and the API footguns.
