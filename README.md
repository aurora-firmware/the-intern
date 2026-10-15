# the-intern

The Intern is an AI office-assistant project. Its service, `bob`, is being rebuilt from a clean slate as one
TypeScript package that embeds pi as a library on `@earendil-works/pi-durable`, in place of the previous Rust service
that supervised `pi` child processes. The previous implementation, specs and ADRs are in git history before the
clean-slate commit.

Nothing is implemented yet.

## Start here

- [pi-durable and pi SDK knowledge base](docs/pi-durable-knowledge.md): what pi-durable and the
  coding-agent SDK provide, how they fit together, the proof-of-concept results and the API footguns.
- [Feature review](docs/feature-review.md): every feature of the previous bob with its verdict for the
  new version, and the open design decisions.

## pi version compatibility

This README is the canonical record of the pi versions the project is tested against. No backwards compatibility is
guaranteed. When the pi version in use changes, update this section; specs and ADRs don't pin pi versions.

- No version is recorded yet. The proof of concept ran on `@earendil-works/pi-durable`, `pi-ai`, `chord` and
  `pi-coding-agent` 1.2.0 (exact pins) with Node 24.
