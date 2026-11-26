---
id: ADR-013
title: Installed versions share one versioned layout and resume each other's operations
status: accepted
created: '2026-11-22'
---

# ADR-013: Installed versions share one versioned layout and resume each other's operations

## Context

S-010 keeps two versions on the machine and moves between them. `bob upgrade` runs the old version's code, `bob
rollback` the new one's, and either may meet what the other left: a pre-upgrade copy, a set-aside database, or an
operation a kill or a power loss cut off (S-010 REQ-006 to REQ-009, REQ-012). A switch-back and a rollback restore the
database with the previous version's import step, while the instance stays under single ownership (S-010 REQ-006;
S-004 REQ-017; ADR-001 decision 1), and the import step refuses to run while another process owns the instance.
`bob upgrade` must tell an unreadable database (REQ-008) from any other failure (REQ-007), know whether the new version
opened the database, and name the reason the daemon logged, on both platforms, without reading journald or launchd.
Only one installation command may run at a time (REQ-011). Whatever one version writes here, a later or earlier
version reads, so the layout is a contract between releases.

## Decision

Every installed version reads and writes the same program folder, operation journal, startup report and upgrades
folder layout, each file carrying a format number, and each step of an operation is atomic and safe to repeat.

1. **The program folder.** `~/.local/lib/the-intern/`, on both platforms, holds `versions/<X.Y.Z>/` (an unpacked
   bundle: `bin/bob`, `node/`, `app/`), the relative symbolic links `current` and `previous`, `service.json`
   (ADR-012 decision 5), `service.hold`, `install.lock`, `operation.json` and `.staging-*` folders. `bob` is the link
   `~/.local/bin/bob` to `<program folder>/current/bin/bob`. Every folder and file is owner-only (ADR-002 decision 6),
   no path holds a `node_modules` segment (Node refuses to strip types there), and the folder never lies inside an
   instance directory or holds one. `bin/bob` runs its own version's `node` on its own version's `app/src/cli/bob.ts`,
   found through its real path, so a running command keeps the code of the version it started from.
2. **Atomic switch.** A version folder appears only complete: it is unpacked into a `.staging-*` folder and renamed
   into `versions/`. A link changes by creating a new link and renaming it over the old one. An upgrade sets
   `previous` before `current`; a switch-back sets them back in the opposite order. A version folder is removed only
   after no link names it, as the operation's last step. At every moment `current` names one complete version.
3. **One installation command at a time.** `install.lock` uses the owner lock's mechanism (`src/daemon/ownership.ts`:
   pid, boot time and token, written whole by a link, taken over when stale) and adds the command's name, which the
   refusal names (S-010 REQ-011). The mechanism counts a lock that holds the checker's own pid as stale, for both
   locks, unless the checking process holds that lock itself through a handle it has not released, which it knows by
   the lock's token (bug B-056). A restarted process under a dead holder's pid holds no handle, so it takes the lock
   over; a process that holds the lock is refused by it as by any live holder.
4. **The operation journal.** `bob upgrade` and `bob rollback` write `operation.json` (the operation, the versions, the
   copy's and set-aside folders' names, the targets `current` and `previous` had before, and the last step done)
   after the confirmation and before their first change, rewrite it atomically after each step, and remove it last.
   Every installation command that changes anything first finishes an operation it finds there: it resumes from the
   step after the last one done, to that operation's own end, its REQ-007 and REQ-008 handling included, and then does
   its own work. `bob service status` only reports it.
5. **The owner lock passes to the import step.** From stopping the service until it starts a version, the command
   holds the instance's owner lock. It restores a database by running the previous version's
   `<program folder>/versions/<X.Y.Z>/bin/bob import --state-dir <state dir> <copy>/database.sqlite` as a child
   process, with the lock's token in `BOB_OWNER_LOCK_TOKEN`. The import step, and nothing else, accepts a lock that
   holds that token and a live pid as its own, and leaves it held when it ends. It releases the lock just before it
   starts a version, so a daemon started by hand meanwhile is refused at startup step 3 (S-010 AC-006.4).
6. **The startup report.** The daemon writes `<state dir>/startup.json`, owner-only and atomically, when it starts
   each startup step and when it fails or reports ready: its version, pid, `BOB_SERVICE_LABEL` (ADR-012 decision 6),
   the furthest step this version reached since the file was last removed, the failed step with the reason it logged,
   whether the database was refused as unreadable (a newer job schema, or pi-durable data it can't read, S-002 REQ-002
   step 4), whether it is ready, and with the ready write `noDefaultModel`, whether pi agent's settings named no default
   model at that moment (CR-002, ADR-014 decision 6). A report without the field reads as `false`. An installation
   command removes the file before it starts a version, and reads it while it waits: an unreadable refusal is REQ-008;
   any other failure is REQ-007; a furthest step of 4 or more without an unreadable refusal means the database was
   opened. `bob service install` prints the no-default-model
   notice when the ready report says `noDefaultModel` (S-010 REQ-004). The field is optional, so the report stays format
   1 and earlier versions read it (decision 8).
7. **The upgrades folder.** `<state dir>/upgrades/`, owner-only. A pre-upgrade copy is the folder
   `<UTC time>-<from>-to-<to>/` holding `copy.json` (format, versions, time, the parts it holds, and whether REQ-008's
   "no" keeps it), `database.sqlite`, `config.toml` when the instance had one, and `internal/` with `instructions/`,
   `skills/` and `shipped-files.json` (ADR-009 decisions 1 and 2). It is written into a `.partial-*` folder and renamed
   when complete. The database copy is SQLite's backup through `node:sqlite` of the stopped database, so it is in the
   export format the import step reads (ADR-001 decision 1). A set-aside database is the folder
   `<UTC time>-<version>-<reason>/` holding the database file with its `-wal` and `-shm` files, moved by rename.
   The secrets store is never copied (S-010 REQ-006).
8. **Formats.** Each JSON file above carries `"format": 1`. A version reads every format up to its own and refuses a
   newer one, naming the file. A change stays readable by the versions before it; a change that can't needs a new
   ADR. `bob import --state-dir <dir> <file>` and `BOB_OWNER_LOCK_TOKEN` stay as they are in every release.

## Consequences

- A kill or power loss at any step leaves one complete current version and a database that is untouched, set aside or
  covered by a copy, and the next upgrade or rollback finishes the cut-off operation first (S-010 REQ-012).
- The daemon writes one more file, the startup report. It is diagnostic: no step reads it back.
- The first release that carries this layout can be the previous version of every later one; nothing before it was
  installed this way.
- A switch-back after the new version opened the database takes a restore, so it is slower than one after a crash
  before step 4. S-010 sets no time for either (v0.3); the 60-second ready wait (S-010 REQ-015) starts only once the
  previous version is started, so the restore doesn't count against it.
- A team member who deletes `operation.json` by hand takes the recovery on themselves; the manual says to leave it.

## Alternatives Considered

- **Release the owner lock for the import step and take it back:** rejected because a daemon started in the gap would
  open the database the copy is being restored into.
- **Place the copy with the running command's own code:** rejected because the import step must be the previous
  version's (S-010 REQ-007, REQ-009), which knows the schemas that version reads, and because loading the import step
  in-process loads the host and pi-durable into an installation command (ADR-005).
- **Tell failures apart by exit status and log text:** rejected because a supervisor's exit status needs a platform
  query, launchd's needs root on the system domain, and log text is no contract between versions.
- **Undo a cut-off operation instead of finishing it:** rejected because a copy taken for the upgrade is then the
  latest one and may not be deleted (S-010 REQ-012), and the team member already confirmed the operation.
- **The program folder under `~/.local/share/the-intern`:** rejected because that is the default data directory, and
  S-010 keeps the program apart from the instance directories.
