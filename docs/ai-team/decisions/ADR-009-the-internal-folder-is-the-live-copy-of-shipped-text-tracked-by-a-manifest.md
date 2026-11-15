---
id: ADR-009
title: The internal folder is the live copy of shipped text, tracked by a manifest
status: accepted
created: '2026-11-13'
---

# ADR-009: The internal folder is the live copy of shipped text, tracked by a manifest

## Context

S-008 moves every text that steers agents into the internal folder under the data directory, which the team edits in
place, while the installed package keeps the shipped versions (S-008 REQ-002). An upgrade replaces a shipped file only
where nobody edited it, by any means (S-008 REQ-003). Writes through the service must never overwrite a hand edit
(S-008 REQ-007, REQ-010), and every edit must reach running agents with a byte-stable prompt (S-008 REQ-015). The
seeding runs at startup step 3, before the database opens, and the data directory travels apart from the database, so
the record of what was copied can't live in the database.

## Decision

The internal folder is the only live copy of the shipped text. A manifest beside it records the content hash of each
shipped file as last copied, and that hash is the only evidence of an edit. Every model request reads the files as
they are.

1. **One layout in the package and on disk.** `src/shipped/` holds `instructions/common.md`,
   `instructions/roles/<role>.md` and `skills/<name>/…`, laid out as the internal folder is, and a shipped file is named
   by that relative path. The daemon only reads the package.
2. **The manifest.** `<data dir>/shipped-files.json` maps each relative path to the SHA-256 of the bytes last copied
   (`fingerprintOf`). It sits beside `instructions/` and `skills/`, so it travels and is wiped with them, and only the
   daemon writes it, owner-only and atomically. A shipped file is **edited** when the manifest records it and it is
   missing or its hash differs; a skill is edited when any of its shipped files is.
3. **The start rule.** At step 3 the daemon creates the missing folders, then:
   - copies each shipped file the manifest doesn't record, unless a file is already at its path, and records the
     shipped hash either way;
   - replaces each recorded file that isn't edited when the shipped bytes differ, and leaves an edited one alone, unless
     it already equals the new bytes;
   - removes a recorded file the version no longer ships unless it is edited, and drops it from the manifest either
     way;
   - writes the manifest once, after the files, so a crash repeats the rule harmlessly.

   A failed write stops startup naming the path (S-008 REQ-002).
4. **Restore.** `skills.restore`, `instructions.restore` and `roles.restore` replace what is there with the installed
   version, a skill's whole folder at once, then record its hash.
5. **The version token** is the `fingerprintOf` hash of the file. Every daemon write to an instruction or skill file
   runs in one in-process serial queue. `files.write` and `roles.change` compare the hash with the token inside it,
   refuse `conflict` when they differ, and otherwise replace the file atomically through a temporary file and a rename.
6. **Every model request reads the files.** Before each model request the role prompt reads the common prompt, the
   seat's role file, the workspace's context files, the enabled set and the skill catalog, and renders each section as
   a pure function of what it read, so equal input gives a byte-identical prompt (S-008 REQ-015). A seat no longer
   carries instruction text.

## Consequences

- One hash per shipped file is all the history needed, and a team member may edit by any means.
- One rule covers a first start, an upgrade, a crash and a folder wiped by hand.
- A token needs no stored state and survives a restart, and edits reach agents with no watcher or cache.
- Every model request reads a few files and walks the skill sources, a cost that grows with the search paths.
- Editing `shipped-files.json` changes what counts as edited; the user manual says it is the daemon's own record.
- A hand edit between the queue's check and its rename is overwritten.
- A team file at a path a later version starts to ship counts as edited, so that text arrives only by a restore.
- An export carries neither the folder nor the manifest (S-004 REQ-016).

## Alternatives Considered

- **Modification times instead of hashes:** rejected because copies and editors change files and times independently.
- **The manifest in the database:** rejected because step 3 runs before the database opens, and the two would drift
  apart through export, import or a wiped folder.
- **The manifest in the state directory:** rejected because a data directory wiped by hand would read as every file
  deleted, and nothing would be seeded again.
- **A cache cleared by file watches:** rejected because watches miss changes on some file systems and differ between
  Linux and macOS.
- **An opaque counter as the token:** rejected because it can't see a hand edit (S-008 AC-010.1).
