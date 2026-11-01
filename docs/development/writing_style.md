# Writing style

These rules apply to every document in the repository: specs, ADRs, developer docs, the user manual, the READMEs and
`AGENTS.md` files. They also apply to task and bug files, reviews, commit messages and pull request descriptions.
Code comments follow [coding_guidelines.md](coding_guidelines.md).

## Words

- Use the shared vocabulary in [system_overview.html](../system_overview.html) (section 4). The short list is in the
  root [AGENTS.md](../../AGENTS.md): team member, job, invokes, "pi-durable X" or "pi agent X", never "sandbox".
- Use one term for one thing. Don't switch to a synonym for variety.
- Prefer plain words: "use", not "leverage" or "utilize"; "start", not "initiate".
- Write out a term the first time you use an abbreviation in a document, unless the vocabulary defines it.
- Name things exactly: give the file path, command, flag, requirement ID (S-002 REQ-008) or ADR decision number.

## Sentences

- Keep sentences short, and put the subject and the verb first. Use the active voice: "the daemon opens the
  database", not "the database is opened".
- State things directly. Cut filler ("it is important to note that", "basically") and hedges ("might possibly").
  Where something is uncertain, say what is unknown and where it will be decided.
- Use "must" or "shall" only for requirements in specs and acceptance criteria. Elsewhere, describe what happens.
- Say each thing once, in the document that owns it, and link to it from the others.

## Layout

- Keep lines to 120 columns at most, wrapping prose by hand. Tables and long links may exceed it.
- Use sentence-case headings that name the topic, not the question.
- Use a list for three or more parallel items and a table to compare items on the same attributes. Keep reasoning in
  prose.
- Put commands, paths, identifiers and literal values in backticks, and multi-line commands in fenced code blocks.
- Use relative links between documents in the repository.

## The user manual

The manual in `docs/manual/` is written for team members, not developers:

- Address the reader as "you" and use the imperative for steps: "Run `bob status`."
- Describe what the team member sees and does. Leave out internals such as pi-durable tasks, harnesses or databases,
  unless the team member has to act on them.
- Show the exact command or page, then the result to expect.

## Commit messages and reviews

- Commit messages follow the format in the `git-conventions` skill. The body says why, not what the diff shows.
- In reviews and Work Logs, state the finding, the rule or requirement it is measured against, and the evidence.
