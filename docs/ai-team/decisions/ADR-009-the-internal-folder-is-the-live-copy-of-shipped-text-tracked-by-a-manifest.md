---
id: ADR-009
title: The internal folder is the live copy of shipped text, tracked by a manifest
status: accepted
created: '2026-11-13'
---

# ADR-009: The internal folder is the live copy of shipped text, tracked by a manifest

## Context

S-008 moves every text that steers agents into files the team edits in place: the common prompt, each role's
instructions and the shipped skills live in the internal folder under the instance's data directory (S-008 REQ-002,
S-002 REQ-006). The installed package keeps the shipped versions and is never written (S-000, S-008 REQ-002). Three
needs follow, and each outlives this feature, because every later version ships text through the same folder:

- **Upgrades keep edits.** A version that ships new text replaces a shipped file only where nobody edited it, adds new
  shipped files, removes the ones it no longer ships unless edited, and leaves edited and deleted files as they are
  (S-008 REQ-003). "Edited" means the file differs from what The Intern last copied there, or was deleted (S-008
  Definitions). So the daemon must know, at each start, what it last copied, by any means a team member edits.
- **Writes through the service never overwrite a hand edit.** `files.write` and `roles.change` replace a file only when
  it still matches the version token the caller read, and refuse `conflict` otherwise (S-008 REQ-007, REQ-010). A hand
  edit is never announced (S-008 Interfaces).
- **Edits reach running agents.** Each instruction file, the skill catalog and the agent's enabled set are read again
  before each model request, and the prompt stays byte-identical while none of them changes (S-008 REQ-007, REQ-015).
  Today `src/prompt/workspace_context.ts` caches a seat's context files and skills for the life of the process, keyed
  by workspace and skill paths, and the role's instructions are a string copied into the seat when it is made.

The seeding runs in S-002 REQ-002 step 3, after single ownership and before step 4 opens the database, so what the
daemon records about the folder can't live in the database. The data directory travels apart from the database: an
export leaves it out (S-004 REQ-016), and a team can wipe or restore it on its own.

Sources: S-008 REQ-002, REQ-003, REQ-007, REQ-010, REQ-015, Definitions and Interfaces; S-002 REQ-002, REQ-006 and
REQ-022; S-004 REQ-016; ADR-002; `src/config/config_file.ts` (`fingerprintOf`), `src/config/config_writer.ts`
(`replaceFile`, the serial queue); `src/prompt/workspace_context.ts`.

## Decision

The internal folder is the only live copy of the shipped text. A manifest beside it records the content hash of each
shipped file as last copied, and that hash is the only evidence of an edit. Writes through the service are guarded by
the same kind of hash, and every model request reads the files as they are.

1. **One layout in the package and on disk.** The package carries the shipped text in `src/shipped/`, laid out as the
   internal folder is: `instructions/common.md`, `instructions/roles/<role>.md` and `skills/<name>/…`. A shipped file is
   named by its path relative to that root, the same relative path in both places. The daemon only reads the package.
2. **The manifest.** `<data dir>/shipped-files.json` holds `{ "version": 1, "files": { "<relative path>": "<hash>" } }`,
   where the hash is the SHA-256 hex of the bytes last copied (`fingerprintOf`). It sits in the data directory beside
   `instructions/` and `skills/`, not inside them, so it travels and is wiped with them, and a skill catalog walk never
   meets it. The daemon writes it owner-only (`0600`), atomically, through a temporary file in the same folder and a
   rename, and nothing else writes it. A shipped file is **edited** when the manifest records it and the file is
   missing, or its hash differs from the recorded one. A shipped skill is edited when any of its shipped files is.
3. **The start rule.** At step 3, after ownership, the daemon creates the missing folders of the internal folder
   (`0700`), then goes through the package's shipped files and the manifest:
   - A shipped file the manifest doesn't record is copied, unless a file already exists at its path: The Intern never
     overwrites a file it didn't write. Either way the manifest records the shipped hash, so a file that was there
     before counts as edited when it differs.
   - A recorded file that isn't edited is replaced with the shipped bytes when they differ, and the manifest takes the
     new hash. An edited file, deleted ones included, is left alone and keeps its recorded hash; one whose content
     already equals the new shipped bytes takes the new hash, so it no longer counts as edited.
   - A recorded file the version no longer ships is removed when it isn't edited, with any skill folder it leaves empty,
     and left alone when edited. Either way the manifest drops it, so it is then a team file.
   - The manifest is written once, after the files. A crash before that write repeats the rule at the next start:
     every copy is of bytes the manifest will record, so a repeat changes nothing a team member did.
   A failed write stops startup with an error naming the path (S-008 REQ-002).
4. **Restore.** `skills.restore`, `instructions.restore` and `roles.restore` copy the installed version over what is
   there, then record its hash. A skill's whole folder is replaced: the daemon copies the shipped folder to a temporary
   sibling, removes the old folder and renames the copy in, so files a team member added to it go too. A file is
   replaced atomically. The manifest write comes last, so a crash in between leaves restored text that the next start
   or restore records.
5. **The version token.** The token of a file is the `fingerprintOf` hash of its bytes, for every file `files.read`
   returns and for a role's instruction file in `roles.list`. Every write the daemon makes to an instruction file or
   a skill file — `files.write`, `roles.create`, `roles.change`, `roles.remove`, a restore and the step 3 rule — runs in
   one in-process serial queue. `files.write` and `roles.change` read the file's hash inside that queue, refuse
   `conflict` when it differs from the token, and otherwise write to a temporary file in the same folder with the old
   file's mode and rename it over the file's real path, symbolic links resolved first. A hand edit between the check
   and the rename is the one edit the guard can't see, as in the configuration file writer (S-002 REQ-022).
6. **Every model request reads the files.** The role prompt keeps no instruction text, context file or skill listing
   between requests. Before each model request it reads the common prompt, the seat's role file, the workspace's
   context files, the conversation's enabled set and the skill catalog, and renders each prompt section as a pure
   function of what it read. Equal bytes in give equal bytes out, so the provider's prompt cache holds while nothing
   changes, and a change alters only its own section (S-008 REQ-015). A seat no longer carries the role's instruction
   text: the role file is read by the seat's role name.

## Consequences

### Positive

- Upgrades and restores need no history beyond one hash per shipped file, and a team member may edit by any means.
- One rule covers the first start, an upgrade, a crash during either and an internal folder wiped by hand: whatever the
  manifest lacks is copied, unless a file is in the way.
- A version token needs no stored state: the hash of the file is the token, so a token survives a restart.
- An edit, an enabled-set change or a new skill folder reaches a running agent with no watcher and no cache to clear.

### Negative

- Every model request reads a few files and walks the skill sources. The walk grows with the size of the search paths
  the team adds; a search path should hold skills, not a home folder.
- A team member who edits `shipped-files.json` changes what counts as edited. The file is the daemon's own record, and
  the user manual says so.
- A hand edit that lands between the queue's hash check and its rename is overwritten. The window is one read and one
  rename long.
- A file a team member placed at a path a later version starts to ship keeps the team's text and counts as edited, so
  that version's text arrives only through a restore.

### Neutral

- The manifest is outside the database, so an export doesn't carry it, as it doesn't carry the internal folder (S-004
  REQ-016). An imported database starts with the instance's own folder and manifest.
- The shipped text may change in any version without amending a spec (S-008 REQ-001); this record fixes how it
  arrives, not what it says.

## Alternatives Considered

### Alternative A: Modification times instead of content hashes

**Description:** Record each file's modification time and size when copied, and count a newer time as an edit.
**Rejected because:** A copy, a restore from a backup or an editor that keeps the time changes a file without changing
its time, and a save of the same bytes changes the time without an edit. The hash answers the definition directly.

### Alternative B: The manifest in the database

**Description:** Keep the copied hashes in a daemon document or an `intern_` table.
**Rejected because:** Step 3 runs before step 4 opens the database, and the record would part from the folder it
describes: an export, an import or a wiped data directory would leave them out of step.

### Alternative C: The manifest in the state directory

**Description:** Keep `shipped-files.json` beside the database.
**Rejected because:** A data directory wiped by hand would read as every shipped file deleted, so nothing would be
seeded again and agents would run with no common prompt.

### Alternative D: Cache the prompt parts and watch the files

**Description:** Keep today's cache and clear it from file system watches of the instruction files and skill sources.
**Rejected because:** A watch misses changes on some file systems, needs one watch per folder of every source, and
fails differently on Linux and macOS. A missed change would leave an agent on old text with nothing to show it.

### Alternative E: An opaque counter as the version token

**Description:** Hand out a number that the daemon increments on each write it makes.
**Rejected because:** It doesn't see a hand edit, which is the case the token is for (S-008 AC-010.1).
