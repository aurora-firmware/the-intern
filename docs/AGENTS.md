# docs/AGENTS.md

This file maps the `docs/` folder: what each part holds, which documents bind the work, who changes them and when,
and when to read them. Every document here follows [writing_style.md](development/writing_style.md).

## Order of authority

When two documents disagree, the higher one wins and the lower one is wrong:

1. [S-000](ai-team/specs/S-000-system-overview.md), the system overview: the source of truth for scope.
2. The other approved specs in `ai-team/specs/`.
3. The accepted ADRs in `ai-team/decisions/`.
4. Everything else in `docs/`.

Fix a lower document to match a higher one. Never change a spec or ADR to match a lower document; raise the conflict
instead (see "Fixes follow the specs" in the root [AGENTS.md](../AGENTS.md)).

## Folders and files

| Path | Holds | Binding | Changed by, and when | Read it when |
|---|---|---|---|---|
| `ai-team/specs/` | Approved specs, S-000 first. | Yes | The Planner, only through a new spec, a spec amendment or a change-request that the product owner approves. | Before you design, plan, build or review anything. |
| `ai-team/decisions/` | Accepted ADRs and their amendments. | Yes | The Architect, when an architecture decision is made or changes. | Before you design, and in every review. |
| `ai-team/AGENTS.md`, `ai-team/.gitignore`, `ai-team/docs/` | Files installed by the ai-team tool. `ai-team/docs/reports/` holds on-demand status reports and is git-ignored. | No | The ai-team tool. Don't edit them by hand; report problems at the-ai-team's issue tracker. | You need to know how ai-team lays out its files. |
| `development/` | Developer documentation: architecture, tech stack, coding guidelines, writing style, local runs, release form. Indexed by [development/README.md](development/README.md). | No, but it records decisions taken under the specs | The task that changes what a document describes, in the same change. Convention changes need the product owner's approval. | While you build. |
| `manual/` | The user manual for team members, published to GitHub Pages. | No | The task that changes a command, a web interface page or a setting, in the same change. | You change anything a team member sees. |
| `research/` | Background research: the pi-durable knowledge base and the feature review from before S-000. Tracked in git. Not the ai-team status reports, which live in `ai-team/docs/reports/`. | No; S-000 wins where they differ | A deliberate task, such as a pi upgrade, which updates the knowledge base for the new version. | You need pi-durable or pi agent API details, or the history behind a direction. |
| `system_overview.html` | The shared vocabulary (section 4) and the spec map (section 5). | Yes for terms | The task that adds or changes a shared term, or adds a spec. | Every time you use a product term. |

Work items (tasks, bugs and change-requests) aren't stored in `docs/`. They live in the local tracker
(`ai-team tracker path`), outside version control, and change only through `ai-team` commands.

## Keeping docs current

- Update a document in the same change as the thing it describes. A change that leaves a document wrong isn't done,
  and the reviewer checks this.
- Each fact has one home. Other documents link to it instead of repeating it.
- When you move or rename a document, update every link to it in the same change:
  `git grep -n '<old path>'` must print nothing outside `ai-team/decisions/`. ADR links are the Architect's to update.
