---
id: S-010
title: Installation and service setup
version: '0.4'
status: approved  # draft | review | approved | superseded
created: '2026-11-22'
author: planner
---

# Installation and service setup

## Purpose

This spec covers S-000's **Installation and service setup** component. Today The Intern runs only from a checkout of the
repository as `node src/cli/bob.ts`, with Node 24 installed by hand, and nothing starts it when the machine starts: the
supervisor registration S-002 REQ-004 relies on doesn't exist, the release workflow is a placeholder, and S-002 live
acceptance test 3 can't be run. S-001 to S-009 are built, so the product now needs a way onto a team's machine. When
this spec is done, a maintainer tags a version and gets a published release, and a team member installs it on a Linux
x64 machine or an Apple silicon Mac with one command, registers it so it starts at boot without anyone logging in and
restarts after a failure, upgrades it with a copy of the saved state taken first, goes back to the previous version, and
removes it, without losing the job record by accident. Success is the whole cycle (install, service setup, upgrade,
failed upgrade, rollback, uninstall) passing in CI against bundles CI built, and a real Linux machine running the
service after a reboot with nobody logged in. The same check on a real Mac waits until one is available.

## Definitions

This spec uses the Definitions of S-001 to S-009 (team member, job, service account, instance, instance directories,
daemon, ready, supervisor, export, import step, internal folder, secrets store) and the shared vocabulary of
`docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Release | One published version of The Intern, named by its version number `X.Y.Z` and its tag `vX.Y.Z` (REQ-001). |
| Bundle | The archive of a release for one platform: The Intern with everything it needs to run, its runtime included, at the versions the release was tested with (REQ-002). |
| Install script | The script published with each release that downloads, checks and installs a bundle (REQ-003). |
| Program folder | The folder under the installing person's home that holds the installed versions. It is apart from the instance directories (REQ-003). |
| Current version | The installed version `bob` and the service run. |
| Previous version | The version that was current before the last upgrade, kept so `bob rollback` can return to it. At most one exists (REQ-006, REQ-009). |
| Service | The registration with the operating system's supervisor that runs `bob serve` for the instance as the service account. It fixes the instance directories and the pi agent folder the service runs with (REQ-004). |
| Pre-upgrade copy | The copy of the instance's saved state that `bob upgrade` takes after it stops the service and before the new version first starts: the database in the export format, the configuration file, and the internal folder with its record of shipped files. It never holds the secrets store (REQ-006). |
| Set-aside database | A database moved out of the state directory and kept, never deleted: one the new version couldn't read (REQ-008), one a failed new version may have changed (REQ-007), or the one a rollback replaces (REQ-009). |
| Unreadable database | A database the new version's startup refuses at S-002 REQ-002 step 4 because it can neither read nor migrate it: a newer job schema, or conversation data its pi-durable can't read (REQ-008). |
| Upgrades folder | The folder `upgrades` in the instance's state directory that holds pre-upgrade copies and set-aside databases. |
| Download location | Where `bob` and the install script fetch releases: the project's GitHub Releases, or a developer's override (Configuration Requirements). |

## Users and Journeys

| Actor | Goal |
|---|---|
| Installing team member | Puts The Intern on a Linux x64 machine or an Apple silicon Mac, makes it start at boot as their own account, upgrades it, goes back after a bad upgrade, removes it. Whoever installs is a team member like any other (S-000). |
| Maintainer | Cuts a release from `main` after Gate 5 and gets it published without manual packaging. |
| Supervisor (systemd, launchd) | Starts the service at machine startup without a login and restarts it after a non-zero exit (S-002 REQ-004). |
| Continuous integration | Builds and publishes releases, and runs the installation cycle against the bundles it built. |
| Developer | Tests installation, upgrade and rollback against local bundles without publishing anything. |

Journeys, in priority order:

1. **Install and set up the service.** The team member runs the install script, then `bob service install`, which asks
   for admin rights once and waits until The Intern is ready. After a reboot with nobody logged in, it is running
   (REQ-003, REQ-004, REQ-014, REQ-015).
2. **Release.** The maintainer pushes a version tag on `main`; CI runs the checks, builds the bundles and publishes both
   on a GitHub Release with their checksums and the install script (REQ-001, REQ-002).
3. **Upgrade.** `bob upgrade` takes a pre-upgrade copy, switches to the new version keeping the previous one, and waits
   until it's ready. Running work resumes on the new version (REQ-006).
4. **Recover from a failed upgrade.** A new version that fails to start is switched back without asking; one that
   can't read the database asks first (REQ-007, REQ-008).
5. **Roll back.** `bob rollback` returns to the previous version and its pre-upgrade copy after saying what will be lost
   (REQ-009).
6. **Remove.** `bob uninstall` removes the service and the program and keeps the data unless the team member says
   otherwise (REQ-010).
7. **Check the service.** `bob service status` and `bob service remove` (REQ-005).

## Exclusions

What this specification explicitly does NOT cover:

- **Verifying macOS on a real Mac in this spec's work.** macOS on Apple silicon is released and supported like Linux,
  but no Mac is available yet. Its behaviour is covered by unit tests and its live check (Success Criteria 5) is pending
  until a Mac is available; the release notes and the manual say so. Product owner decision, 2026-11-22.
- **Automatic updates and version notices.** The Intern never checks for, announces or installs a new version by
  itself. A team member runs `bob upgrade`, which is the only command that looks up the latest release.
- **A dedicated service account.** v1 runs as the installing person's account (S-000; ADR-002).
- **More than one registered instance per machine.** The service covers the one instance with the default instance
  directories. Developers still run more instances by hand with the directory flags (S-002 REQ-006).
- **macOS signing and notarization.**
- **Linux x64 without glibc or without systemd.** S-000 supports Linux on x64; this spec narrows it to systems with
  glibc and systemd, which the bundle and the supervisor contract (S-002 REQ-004) need. The install script refuses
  others.
- **Copying the secrets store.** Upgrade, switch-back and rollback never copy or restore it: secrets live only in the
  secrets store (S-002 REQ-018; S-009 REQ-002, REQ-020). Product owner decision, 2026-11-22.
- **Migrating a database the new version can't read.** S-000 excludes converting saved state between versions. A
  failed upgrade asks to switch back instead (REQ-008). Migrating databases from earlier versions is a later direction.
- **Going back more than one version.** Only the previous version is kept, and `bob rollback` reaches only it.
- **Installing from a local file or without network access.** The install script and `bob upgrade` download from the
  download location. The developer override exists for tests (Configuration Requirements), not as an offline install.
- **System-wide installs.** The program lives under the installing person's home; only the service registration may
  need admin rights.
- **Setting up the pi login and accounts.** Installation doesn't sign in to pi or add mail accounts; the manual points
  to the existing steps.
- **Downgrading with `bob upgrade`.** An older version is refused; `bob rollback` is the way back.
- **Unchanged from S-000:** Windows, Linux on ARM and Intel Macs, and the team's network setup that decides who can
  reach The Intern.

## Alternatives Considered

- **An npm package that needs Node 24 installed beforehand.** Rejected: the team member must provide Node 24, the
  service breaks when that Node moves or changes version, and the Node and SQLite versions vary per machine.
  `docs/development/release_form.md` (form A) has the comparison.
- **OS packages (a `.deb` and a Homebrew formula).** Rejected: two packaging systems to build and maintain, each with
  its own idea of services and upgrades.
- **Everything in the install script** (download, service registration, upgrade and removal as script flags).
  Rejected: shell logic is hard to test across platforms; `bob` commands are tested code and the script stays small.
- **Manual steps in the manual only.** Rejected: error-prone, and upgrades stay manual.
- **Start at login, with no admin rights.** Rejected: The Intern would run only while the person is logged in, which
  contradicts S-000 and S-002 REQ-004.
- **Keep the previous version, take no copy of the saved state.** Rejected: once the new version migrates the database,
  the previous version refuses it (S-004 REQ-001), so going back would fail.
- **Take a copy, go back by hand.** Rejected: the most manual steps at the moment they matter most.
- **Leave the service stopped after a failed upgrade.** Rejected: a failed upgrade would leave The Intern down while
  nobody watches. It switches back instead (REQ-007).
- **Copy the secrets store with the rest, so a rollback restores it too.** Rejected at the architecture consistency
  review: it makes a second copy of every secret, against S-002 REQ-018 and S-009 REQ-002 and REQ-020. A rollback
  instead leaves the secrets store as it is (REQ-009).
- **Pause mail intake and sending after a rollback until a team member resumes them.** Rejected: a new behaviour in
  S-009 and one more step after every rollback. The rollback warning says mail may be taken in or sent again, and
  S-009's guarantees are clarified to hold within one database's history (REQ-009).
- **Delete everything on uninstall after one confirmation.** Rejected: a slip loses the job record and the secrets. The
  data is kept unless the team member asks (REQ-010).
- **Build and upload releases by hand, or publish on every merge to `main`.** Rejected: by hand is slow and error-prone;
  every merge would reach team members' upgrades without a Gate 5 sign-off.

## Interfaces

### Release assets

**Contract:** each GitHub Release, tagged `vX.Y.Z` on `main`, carries exactly these assets:

| Asset | Content |
|---|---|
| `the-intern-X.Y.Z-linux-x64.tar.gz` | The Linux x64 bundle (REQ-002) |
| `the-intern-X.Y.Z-linux-x64.tar.gz.sha256` | Its SHA-256 checksum, in the format `sha256sum -c` and `shasum -a 256 -c` read |
| `the-intern-X.Y.Z-darwin-arm64.tar.gz` | The macOS Apple silicon bundle (REQ-002) |
| `the-intern-X.Y.Z-darwin-arm64.tar.gz.sha256` | Its SHA-256 checksum, in the same format |
| `install.sh` | The install script (REQ-003) |

The repository is public, so the assets download without a login.

### Install script

**Contract:**

```
curl -fsSL https://github.com/aurora-firmware/the-intern/releases/latest/download/install.sh | sh
curl -fsSL https://github.com/aurora-firmware/the-intern/releases/latest/download/install.sh | sh -s -- --version X.Y.Z
```

| Outcome | Message and exit |
|---|---|
| Installed | The version, the program folder, the `bob` path, and the next step: sign in to pi if needed, then `bob service install`. If the folder holding the `bob` link isn't on the `PATH`, the line to add it. Exit 0 |
| Unsupported platform (Linux on ARM, an Intel Mac, a musl libc, Linux without systemd, any other system) or run as root | Names the reason; nothing changes. Exit 1 |
| Already installed | Names the installed version and points to `bob upgrade`; nothing changes. Exit 1 |
| Download fails, the checksum doesn't match, the version doesn't exist | Names the reason; nothing is left behind. Exit 1 |

### Commands

These are the installation commands: the `service` group and the top-level `upgrade`, `rollback` and `uninstall`
(S-000 Command line, Boundary, and S-005, as amended on this branch). Like every `bob` command they take `--help` at
every level and exit 2 on a usage error (S-005 REQ-001). They aren't S-005 data commands: this spec owns their output
and exit codes, as the table states. Notices, questions and errors go to standard error. They call no operation of the
Intern service, except `daemon.status` (S-002 REQ-012): `bob service status` reads the running version with it, and the
ready wait of `bob service install`, `bob upgrade` and `bob rollback` reads the phase and the version with it. Every
command after `bob service install` acts on the instance directories and the pi agent folder the service registration
holds (REQ-004), not on those of its own environment.

| Command | Behaviour | Exit |
|---|---|---|
| `bob service install` | Registers and starts the service, asking for admin rights when the machine needs them, and waits for ready (REQ-004). With no pi login it prints a notice that there is no default model, pointing at signing in to pi. Run again, it points the registration at the current version | 0 ready, with or without a model; 1 not registered or not ready, naming the reason and the command that shows the service's log |
| `bob service remove` | Stops the service and removes its registration. Program and data stay (REQ-005) | 0; 1 on failure |
| `bob service status [--json]` | Whether the service is registered, starts at boot and is running, the version it runs, and the directories it runs with (REQ-005) | 0 |
| `bob upgrade [<version>] [--yes]` | Upgrades to the latest release, or to `<version>` (REQ-006 to REQ-008). Asks before stopping the service unless `--yes` | 0 upgraded, or upgraded with a fresh database by the team member's choice, or already on that version; 1 failed and switched back, refused, or declined |
| `bob rollback [--yes]` | Returns to the previous version and its pre-upgrade copy after saying what will be lost and asking (REQ-009) | 0; 1 refused, declined or failed |
| `bob uninstall [--yes] [--remove-data]` | Removes the service and the program, and asks whether to keep the data, keeping it by default (REQ-010) | 0; 1 on failure |

**Contract:** `bob service status --json` prints one JSON object:

| Field | Value |
|---|---|
| `registered` | `true` or `false` |
| `startsAtBoot` | `true` or `false`; `false` when not registered |
| `running` | `true` when the registered service's daemon answers `daemon.status`, else `false` |
| `version` | the version the running daemon reports, or `null` when it isn't running |
| `configDir`, `stateDir`, `dataDir`, `runtimeDir` | the instance directories the registration holds, or `null` when not registered |
| `piAgentDir` | the pi agent folder the registration holds, or `null` when not registered |

### Files

- **Program folder.** Under the installing person's home, outside the instance directories, holding the current version
  and at most one previous version. `bob` is linked into a folder under the home that is usually on the `PATH`. The
  exact paths are decided in Feature Architecture (Open Questions).
- **Upgrades folder.** `upgrades` in the instance's state directory, owner-only like the state directory (S-002
  REQ-006). It holds the latest pre-upgrade copy, named after its date, the version it was taken from and the version it
  was taken for, any copy kept by REQ-008's "no", and every set-aside database, named after its date, the version
  that used it last and why it was set aside.
- **Instance directories.** Unchanged (S-002 REQ-006). Installation uses the ones the registration holds (REQ-004).

### Consumed

- S-002 REQ-002 to REQ-006 and REQ-020: startup order and its failing step, readiness, the supervision contract, the
  shutdown bound and the version report.
- S-004 REQ-001, REQ-016 and REQ-017: migration forward, the export format and the import step, which refuses when a
  database is present.
- S-002 REQ-001: single ownership of the instance, held while the database is copied, switched or restored.
- S-005 REQ-001: command shape and help.
- GitHub Releases on the public repository; systemd on Linux and launchd on macOS.

## Workflow

```
Maintainer pushes vX.Y.Z on main                                                 ★ Gate 5 signed off  REQ-001
  → CI: tag = package version? no → stop, publish nothing                                                REQ-001
  → checks pass → build both bundles → publish both bundles, checksums, script        REQ-001, REQ-002

Team member runs the install script                                                                      REQ-003
  → unsupported platform / root / already installed → refuse, nothing changes
  → download → checksum mismatch → refuse, nothing left
  → unpack into the program folder → link bob → print next step

bob service install                                                                                      REQ-004
  → admin rights needed and refused → stop, nothing registered
  → register (start at boot, no login, restart on non-zero exit, as the service account) → start → ready?
  → not ready in time → exit 1 naming the reason and the log command
  → ready with no pi login → notice: no default model, sign in to pi → exit 0

bob upgrade [version]                                                                                    REQ-006
  → no service / another daemon owns the instance / another upgrade runs / no terminal and no --yes → refuse
  → same version → "already on X.Y.Z", exit 0; older → refuse, point to bob rollback
  → download and check → confirm → stop service → take pre-upgrade copy → switch → start → ready → done
    → not ready, any other cause → switch back, restore config and internal folder
        (and the database from the copy if the new version opened it), start previous → exit 1   REQ-007
  → not ready, unreadable database → ask "Switch back to X.Y.Z?" (no terminal: yes)                         REQ-008
        yes → as above
        no  → set the database aside, start new version on a new database → exit 0

bob rollback                                                                                             REQ-009
  → no previous version or copy / no terminal and no --yes → refuse
    → state what is lost or may repeat → confirm → stop → set the database aside → previous version
  → import the copy, restore config and internal folder (not the secrets) → start

bob uninstall                                                                                            REQ-010
  → stop and remove the service → remove the program
  → keep data? (default yes; no terminal: yes unless --remove-data)

Any step cut off (Ctrl-C, power loss)                                                            REQ-012
  → one complete version is current; the database is untouched or its copy exists
```

## Behavioral Requirements

### REQ-001 — A release on a version tag

When a tag `vX.Y.Z` is pushed on a commit of `main`, continuous integration SHALL run the project's checks, build the
linux-x64 and darwin-arm64 bundles, and publish a GitHub Release named after the tag with exactly the release assets of
Interfaces. It SHALL publish nothing when the checks fail, when the tag's version differs from the package version, or
when the tagged commit isn't on `main`.

#### AC-001.1 — A tag publishes a release

- **Given:** the package version `0.1.0` on `main`, all checks passing
- **When:** the maintainer pushes `v0.1.0`
- **Then:** a release `v0.1.0` exists with `the-intern-0.1.0-linux-x64.tar.gz`, `the-intern-0.1.0-darwin-arm64.tar.gz`,
  their `.sha256` files and `install.sh`

**Verification:** demonstration — a pre-release tag (for example `v0.1.0-rc.1` with a matching package version) pushed
on `main`, then the release page and the run's artifacts inspected.

#### AC-001.2 — A mismatched or failing tag publishes nothing

- **Given:** a tag `v0.2.0` on a commit whose package version is `0.1.0`; a tag on a commit not on `main`; a tag whose
  checks fail
- **When:** each is pushed
- **Then:** the run fails naming the reason, and no release or asset is published

**Verification:** test — the release workflow's version and branch check, run as a unit test on the check itself;
demonstration of one mismatched tag in CI.

### REQ-002 — The bundle

A bundle SHALL hold everything The Intern needs to run on its platform, its runtime included, with its dependencies at
the versions the release was tested with, and SHALL run `bob` with nothing installed on the machine beforehand except
the system's own libraries and the tools the install script needs (Assumptions). The version `bob` reports (S-002
REQ-020, `bob status`) SHALL be the release's version.

#### AC-002.1 — It runs on a clean machine

- **Given:** a Linux x64 machine with no Node installed; an Apple silicon Mac with no Node installed
- **When:** the bundle is installed and `bob serve` is run with directory flags
- **Then:** the daemon reaches ready, and `bob status` reports the release's version and the pi versions the README
  lists

**Verification:** test — the installation cycle test (REQ-017), in an environment without a Node on the `PATH`, for
Linux; demonstration on a Mac for macOS, pending (Success Criteria 5).

### REQ-003 — The install script

The install script SHALL install the latest release, or the version `--version` names, into the program folder and link
`bob` into a folder under the person's home. It SHALL refuse, changing nothing, on any platform but Linux x64 with glibc
and systemd and macOS on Apple silicon, when run as root, and when The Intern is already installed. It SHALL check the
bundle against its published checksum before unpacking and leave nothing behind when the download or the check fails. It
SHALL end by printing the installed version, the paths, the line to add the link's folder to the `PATH` when it isn't
there, and the next step.

#### AC-003.1 — A fresh install

- **Given:** a Linux x64 machine with glibc and systemd, without The Intern
- **When:** the team member runs the install script as their own account
- **Then:** `bob` runs the release's version from the program folder, and the output names the next step
  `bob service install`

**Verification:** test — the installation cycle test (REQ-017).

#### AC-003.2 — Refusals

- **Given:** the script run on an Intel Mac; on Linux on ARM; on a musl-based Linux; on a machine without systemd; as
  root; with The Intern already installed; with `--version` naming a version that doesn't exist
- **When:** each runs
- **Then:** each exits 1 with a message naming the reason, and the program folder and the `PATH` link are as they
  were

**Verification:** test — unit tests of the script's checks with the platform facts given as input; the installation
cycle test for the already-installed and missing-version cases.

#### AC-003.3 — A bad download

- **Given:** a download location serving a bundle whose checksum doesn't match, and one that fails halfway
- **When:** the script runs against each
- **Then:** it exits 1 naming the reason, and nothing is left in the program folder

**Verification:** test — the installation cycle test with the download location override.

### REQ-004 — Service registration

`bob service install` SHALL register the service so that the supervisor starts `bob serve` for the instance's default
directories as the service account, never as root, when the machine starts and without anyone logging in, and restarts
it after a non-zero exit (S-002 REQ-004), using systemd on Linux and launchd on macOS. It SHALL ask for admin rights
only for the steps the machine requires them for, and stop with nothing registered when they are refused or the machine
doesn't allow the service account's own service to run at boot. It SHALL start the service and wait until the daemon
reports ready. When it isn't ready within the bound of REQ-015, it SHALL exit 1 naming the reason the daemon logged and
the command that shows the service's log. A missing pi login is not such a reason: the daemon reaches ready without one
(S-002 REQ-002), and `bob service install` SHALL then exit 0 and print, on standard error, a notice that there is no
default model, pointing at signing in to pi (product owner, 2026-11-24, CR-002 and its settled details). It learns
that there is no default model from the daemon's ready startup report (ADR-013 decision 6). Run again, it SHALL point
the registration at the current version and leave everything else as it was.

The registration SHALL fix the instance directories and the pi agent folder that `bob service install` resolves from
its environment (S-002 REQ-006; S-002 Configuration Requirements, `PI_CODING_AGENT_DIR`), so the service runs with them
whatever the supervisor's environment holds. `bob service status` SHALL show them, and `bob upgrade`, `bob rollback`
and `bob uninstall` SHALL act on them.

#### AC-004.1 — Registered, started and ready

- **Given:** an installed release and a pi login with a default model
- **When:** the team member runs `bob service install`
- **Then:** it exits 0 once the daemon is ready, `bob service status` shows registered, starts at boot and running,
  and the daemon's process runs as the team member's account

**Verification:** test — the installation cycle test (REQ-017).

#### AC-004.2 — Starts at boot without a login and restarts after a failure

- **Given:** the service registered on a real Linux x64 machine, with a job running
- **When:** the machine reboots and nobody logs in; later the daemon is killed with `kill -9`
- **Then:** `bob status` over SSH answers after the reboot; after the kill the daemon is restarted and the job's run
  resumes (S-002 REQ-008)

**Verification:** demonstration — the live check on a real Linux machine (Success Criteria 3), which closes the Linux
half of S-002 live acceptance test 3; the same on a real Mac (Success Criteria 5), pending until a Mac is available.

#### AC-004.3 — Not ready, or not allowed

- **Given:** the web port already in use; admin rights refused; a machine that doesn't let the service account's own
  service run at boot
- **When:** `bob service install` runs
- **Then:** for the first it exits 1 naming the daemon's reason and the log command; for the last two it exits 1
  naming the reason, with no registration left

**Verification:** test — the installation cycle test for the first; unit tests of the refusal paths for the last
two, on both platforms' registration.

#### AC-004.4 — The registration fixes the instance and the pi login

- **Given:** `bob service install` run in a shell where `XDG_STATE_HOME` and `PI_CODING_AGENT_DIR` name non-default
  folders
- **When:** the service starts at the next boot, and `bob service status --json` and `bob upgrade --yes` run later in a
  shell where neither variable is set
- **Then:** the daemon runs with those folders, the status shows them, and the upgrade's copy is taken from that state
  directory

**Verification:** test — the installation cycle test.

#### AC-004.5 — No pi login

- **Given:** an installed release and no pi agent folder for the service account
- **When:** the team member runs `bob service install`
- **Then:** it exits 0 once the daemon is ready, standard error holds a notice that there is no default model, pointing
  at signing in to pi; `bob service status` shows registered and running, and `bob status` and the web interface's
  `/ui/` answer

**Verification:** test — the installation cycle test.

### REQ-005 — Checking and removing the service

`bob service status` SHALL report whether the service is registered, whether it starts at boot, whether it is running,
the version it runs and the directories it runs with, with `--json` as the contract in Interfaces states, and SHALL
exit 0 in every state. `bob service remove` SHALL stop the service and remove its
registration, leaving the program folder and the instance directories as they were.

#### AC-005.1 — Status in each state

- **Given:** no registration; a registered, stopped service; a running one
- **When:** `bob service status` runs, with and without `--json`
- **Then:** each state is reported, the running one with its version, and the exit status is 0

**Verification:** test — the installation cycle test.

#### AC-005.2 — Remove keeps program and data

- **Given:** a running service with jobs
- **When:** `bob service remove` runs
- **Then:** the service is stopped and unregistered, `bob` still runs, and a later `bob service install` finds every
  job

**Verification:** test — the installation cycle test.

### REQ-006 — Upgrade

`bob upgrade [<version>]` SHALL download the latest release, or `<version>`, and check its checksum, then ask for
confirmation before stopping the service unless `--yes` is given. It SHALL then stop the service (S-002 REQ-005), take
the pre-upgrade copy, install the new version as current while keeping the version it replaces as the previous one,
start the service and wait until the daemon reports ready. The pre-upgrade copy SHALL hold the database with everything
committed before the service stopped, in the format `bob import` reads (S-004 REQ-016), and the configuration file and
the internal folder with its record of shipped files (S-008 REQ-002, REQ-003) as they were at that moment. It SHALL NOT
hold the secrets store (S-002 REQ-018). From stopping the service until it starts a version again, `bob upgrade` SHALL
hold single ownership of the instance (S-002 REQ-001), as the import step does, so no daemon opens the database while it
is copied, switched, set aside or restored; REQ-007 to REQ-009 hold it the same way. It SHALL replace the older
pre-upgrade copy only after the upgrade succeeds, and never a copy kept by REQ-008's "no" (REQ-012). It SHALL print each
step as it runs. It SHALL refuse, changing nothing, when the service isn't registered, when a daemon the service didn't
start owns the instance, when another upgrade or rollback is running, when standard input isn't a terminal and `--yes` isn't
given, and when `<version>` is older than the current version, pointing to `bob rollback`. When the current version is the one asked for, it SHALL say so and exit 0.

#### AC-006.1 — An upgrade with work running

- **Given:** version 0.1.0 running as the service with a job's run in the middle of a tool call
- **When:** `bob upgrade 0.2.0 --yes` runs
- **Then:** the upgrades folder holds a copy from 0.1.0 for 0.2.0 with the database, the configuration file and the
  internal folder, and no secret; the daemon reports 0.2.0 and ready, the job's run
  resumes with an interrupted result (S-002 REQ-005), 0.1.0 is the previous version, and the command exits 0

**Verification:** test — the installation cycle test with two locally built versions on the fake model.

#### AC-006.2 — Nothing to do, or refused

- **Given:** 0.2.0 current; then no registered service; a daemon started by hand on the instance; a second upgrade
  running
- **When:** `bob upgrade 0.2.0`, `bob upgrade 0.1.0`, and `bob upgrade` in each of the other states run
- **Then:** the first says it is already on 0.2.0 and exits 0; the others exit 1 naming the reason (the second points to
  `bob rollback`), and the service, the versions and the database are as they were

**Verification:** test — unit tests of the decisions; the installation cycle test for the first two.

#### AC-006.3 — The team member declines

- **Given:** a terminal and no `--yes`
- **When:** the team member answers no to stopping the service
- **Then:** nothing changes and the command exits 1

**Verification:** test — unit test of the confirmation.

#### AC-006.4 — No daemon starts during the copy

- **Given:** an upgrade stopped by a test hook after it took single ownership and before it starts a version
- **When:** `bob serve` is started for the instance
- **Then:** it is refused at startup step 3, and the upgrade then completes

**Verification:** test — the installation cycle test.

### REQ-007 — A failed upgrade switches back

When the new version doesn't report ready within the bound of REQ-015 for any reason other than an unreadable database,
`bob upgrade` SHALL name the reason the daemon logged, make the previous version current again, and put back the
configuration file and the internal folder from the pre-upgrade copy, because the new version's startup may have
changed them before it failed (S-002 REQ-002 steps 1 and 3). When the new version's startup got as far as opening the
database (step 4), `bob upgrade` SHALL also set that database aside and restore the database from the copy with the
previous version's import step (S-004 REQ-017), because the new version may have migrated it or resumed work in it. It
SHALL then start the previous version, wait until it reports ready, remove the version that failed, and exit 1. It
SHALL NOT ask, and SHALL leave the secrets store as it is.

#### AC-007.1 — The new version crashes at startup

- **Given:** 0.1.0 running and a locally built 0.2.0 that exits non-zero at startup for a reason other than the
  database
- **When:** `bob upgrade 0.2.0 --yes` runs
- **Then:** it reports the failure and its reason, 0.1.0 is current and ready with every job as before, the
    configuration file and the internal folder are byte-identical to the copy, the database is the one 0.1.0 left, 0.2.0
  is no longer installed, and the exit status is 1

**Verification:** test — the installation cycle test with a deliberately failing build.

#### AC-007.2 — The new version fails after opening the database

- **Given:** 0.1.0 running with jobs, and a locally built 0.2.0 that migrates the database and then fails at startup
  step 8 because the web port is taken
- **When:** `bob upgrade 0.2.0 --yes` runs
- **Then:** the database 0.2.0 opened is set aside in the upgrades folder, 0.1.0 is current and ready with every job of
  the copy, and the exit status is 1

**Verification:** test — the installation cycle test.

### REQ-008 — An unreadable database asks first

When the new version doesn't reach ready because the database is unreadable (S-002 REQ-002 step 4; S-004 REQ-001,
REQ-017), `bob upgrade` SHALL say so and ask "Switch back to X.Y.Z?", where yes is the default. On yes, it SHALL switch
back as REQ-007 does. On no, it SHALL set the database aside in the upgrades folder, keep the pre-upgrade copy and the
previous version, start the new version on a new, empty database, print the paths of the set-aside database and the
copy, and exit 0 once ready. The configuration file, the secrets store and the internal folder SHALL stay as the new
version left them.
With no terminal to ask on, it SHALL take the default and switch back.

#### AC-008.1 — Yes, or no terminal

- **Given:** 0.1.0 running and a locally built 0.2.0 that refuses the database at step 4
- **When:** `bob upgrade 0.2.0 --yes` runs on a terminal and the team member answers yes; and again with standard input
  not a terminal
- **Then:** both times 0.1.0 is current and ready with every job as before, and the exit status is 1

**Verification:** test — the installation cycle test with a build whose job schema is older than the database's.

#### AC-008.2 — No: start fresh, keep the old database

- **Given:** the same versions
- **When:** the team member answers no
- **Then:** the upgrades folder holds the set-aside database and the pre-upgrade copy, both owner-only, 0.2.0 is
  current and ready with no jobs, 0.1.0 is the previous version, the configuration file and secrets are those 0.2.0
  started with, and the exit status is 0; a later `bob rollback` brings back 0.1.0 with every job

**Verification:** test — the installation cycle test.

### REQ-009 — Rollback

`bob rollback` SHALL name the previous version, the time of the upgrade its pre-upgrade copy was taken for, and say that
everything done since then will be lost: jobs and conversations, and changes to the configuration, roles, instructions
and skills, including mail accounts added since, which won't be set up any more. It SHALL also say that work in progress
at the time of the upgrade may run again, that mail received since may be taken in again, and that mail sent since may
be sent again (S-009 REQ-021, REQ-022, as clarified on this branch). It SHALL ask for confirmation unless `--yes` is
given. On confirmation it SHALL stop the service, set the current database aside in the upgrades folder, make the
previous version current, restore the database from the pre-upgrade copy with the previous version's import step (S-004
REQ-017), put back the configuration file and the internal folder from the copy, start the service and wait until it
reports ready. It SHALL leave the secrets store as it is; the secrets of accounts the restored configuration no longer
holds go at the next start (S-002 REQ-002 step 8). The version it leaves SHALL be removed, so no previous version
remains. It SHALL refuse, changing nothing, when there is no previous version or no pre-upgrade copy for it, and when
standard input isn't a terminal and `--yes` isn't given.

#### AC-009.1 — Back to the previous version

- **Given:** an upgrade from 0.1.0 to 0.2.0, then one new job on 0.2.0
- **When:** `bob rollback` runs and the team member confirms
- **Then:** the warning named 0.1.0, the upgrade's time, what is lost and the work and mail that may repeat; 0.1.0 is
  current and ready with every job of the copy and without the new job; the configuration file and internal folder
  match the copy, and the secrets store is unchanged; the 0.2.0 database is set aside; no previous version remains;
  the exit status is 0

**Verification:** test — the installation cycle test.

#### AC-009.2 — Refusals

- **Given:** a fresh install with no previous version; a previous version whose copy is missing; a script with no
  terminal and no `--yes`; a team member who answers no
- **When:** `bob rollback` runs in each
- **Then:** each exits 1 naming the reason, and nothing changes

**Verification:** test — unit tests of the decisions; the installation cycle test for the first.

### REQ-010 — Uninstall

`bob uninstall` SHALL stop and remove the service (REQ-005), remove the program folder and the `bob` link, and undo what
`bob service install` changed on the machine. It SHALL ask whether to keep the instance's data, with keep as the
default, and print the paths of the instance directories it keeps. When the team member chooses to remove the data,
or passes `--remove-data`, it SHALL remove the instance directories, the upgrades folder with them. With no terminal to
ask on, it SHALL keep the data unless `--remove-data` is given. It SHALL never touch the pi login.

#### AC-010.1 — Keep the data

- **Given:** an installed, running service with jobs
- **When:** `bob uninstall` runs and the team member takes the default
- **Then:** the service is gone, `bob` is gone, the instance directories remain and are printed; a new install and
  `bob service install` find every job

**Verification:** test — the installation cycle test.

#### AC-010.2 — Remove the data

- **Given:** the same
- **When:** `bob uninstall --yes --remove-data` runs without a terminal
- **Then:** the service, the program and the instance directories are gone, and the pi login folder is unchanged

**Verification:** test — the installation cycle test.

### REQ-011 — One installation command at a time

`bob service install`, `bob service remove`, `bob upgrade`, `bob rollback` and `bob uninstall` SHALL refuse with exit 1,
naming the running command, while another of them runs for the same installation.

#### AC-011.1 — A second command is refused

- **Given:** `bob upgrade` waiting for the new version to become ready
- **When:** `bob rollback` and `bob uninstall` are started
- **Then:** both exit 1 naming the running upgrade, and the upgrade completes

**Verification:** test — unit test of the lock; the installation cycle test.

## Quality Requirements

### REQ-012 — No data lost without asking, and safe to cut off

No installation command SHALL delete a database, a pre-upgrade copy that is still needed, or a set-aside database,
except `bob uninstall` when the team member chose to remove the data. A pre-upgrade copy is still needed while it is the
latest one; a copy taken for an upgrade that ended with REQ-008's "no" is kept, like a set-aside database, until the
team member deletes it. Pre-upgrade copies and set-aside databases SHALL be owner-only (S-002 REQ-006). When `bob
upgrade` or `bob rollback` is cut off at any step (interrupt, kill, power loss), afterwards exactly one complete version
SHALL be current, `bob service status` SHALL report it, the database SHALL be either untouched or covered by a
pre-upgrade copy, and a new `bob upgrade` or `bob rollback` SHALL be able to complete.

#### AC-012.1 — Cut off at each step

- **Given:** an upgrade from 0.1.0 to 0.2.0
- **When:** it is killed with `kill -9` after each of its steps in turn, and then `bob service status` and
  `bob upgrade 0.2.0 --yes` run
- **Then:** each time the status names one complete version, every job exists in the database or in the copy, and the
  repeated upgrade ends with 0.2.0 ready

**Verification:** test — the installation cycle test, with a test hook that stops after a named step.

#### AC-012.2 — Owner-only copies

- **Given:** a completed upgrade and a set-aside database
- **When:** their modes are read
- **Then:** the upgrades folder and every file in it are accessible to the owner only

**Verification:** test — the installation cycle test.

### REQ-013 — Every download is checked

The install script and `bob upgrade` SHALL check every bundle against its published checksum before unpacking it, and
SHALL stop, changing nothing installed, when the checksum is missing or doesn't match.

#### AC-013.1 — A tampered bundle

- **Given:** a download location whose bundle differs from its checksum, and one with no checksum file
- **When:** the install script and `bob upgrade` run against each
- **Then:** both stop naming the reason, and the installed versions and the service are as they were

**Verification:** test — the installation cycle test with the download location override.

### REQ-014 — Least privilege

The service SHALL run as the service account and never as root (ADR-002). Only `bob service install`, `bob service
remove` and `bob uninstall` MAY ask for admin rights. `bob upgrade` and `bob rollback` SHALL stop and start the service
without admin rights, on Linux and on macOS. The install script SHALL never ask for them.

#### AC-014.1 — No root process, no sudo for upgrades

- **Given:** a registered service
- **When:** the daemon's process owner is read, and `bob upgrade` and `bob rollback` run with no admin rights available
- **Then:** the process runs as the team member's account, and both commands complete

**Verification:** test — the installation cycle test, run as an account that can't use sudo after setup.

### REQ-015 — Ready wait and bundle size

The ready wait in REQ-004, REQ-006, REQ-007 and REQ-008 SHALL be 60 seconds, after which the version counts as not
ready. Each compressed bundle, linux-x64 and darwin-arm64, SHALL be at most 150 MB. This spec sets no time for the
installation commands or the release workflow to finish.

#### AC-015.1 — Over the limit fails the build

- **Given:** a bundle archive over 150 MB
- **When:** the bundle build writes it
- **Then:** the build fails, naming the file and its size

**Verification:** test — the bundle build's size check.

#### AC-015.2 — Published bundles within the limit

- **Given:** a release built by CI
- **When:** it is published
- **Then:** each bundle's size on the release page is at most 150 MB

**Verification:** demonstration — the release run, with the sizes on the release page recorded as evidence.

### REQ-016 — Documentation

The user manual SHALL have an "Installing and upgrading" page that covers the install script, `bob service install`, the
pi login: that the service starts and is reachable without one; that until a team member signs in to pi, no agent of a
role without its own model runs, messages and jobs wait, and schedule fires with no model are skipped (S-001 REQ-027;
S-007 REQ-006); and that signing in includes choosing a default model with pi's `/model` when pi asks for one (S-001
Assumptions), then `bob service status` and `remove`, `bob upgrade` and its two failure paths, `bob rollback` with what
it loses and may repeat, that it leaves the secrets store as it is and that a mail account it brings back without its
secrets needs signing in again, `bob uninstall`, the upgrades folder, which instance directories and pi login the
service uses, and that macOS hasn't yet been verified on a real Mac. `docs/manual/commands.md` SHALL lose its "Until
installation puts `bob` on your `PATH`" note and list the new commands. The developer docs SHALL say how to cut a
release and how to run the installation cycle test against local bundles.

#### AC-016.1 — The manual and the developer docs

- **Given:** the docs after this spec's tasks
- **When:** they are read and `npm run docs:build` runs
- **Then:** each item above is present and the build passes

**Verification:** inspection — the Reviewer reads the pages against this list; `npm run docs:build` passes.

### REQ-017 — The installation cycle runs in CI

CI SHALL run the installation cycle on Linux against bundles it built in the same run, through the download location
override: install, service setup, upgrade, failed upgrade of both kinds, rollback, the cut-off cases of REQ-012 and
uninstall, in an environment with systemd. macOS isn't in the CI cycle: its platform checks and launchd registration are
covered by unit tests, and its live check is Success Criteria 5.

#### AC-017.1 — Every change runs the cycle

- **Given:** a change to `dev-pi-durable` or a release tag
- **When:** CI runs
- **Then:** the installation cycle job runs and its result is reported on the change

**Verification:** inspection — the CI run's job list and log for a change.

## Configuration Requirements

- **Download location override** (developers only)
  - **What must exist:** a way for tests and CI to point the install script and `bob upgrade` at locally built bundles
    instead of GitHub Releases (REQ-013, REQ-017).
  - **Where it lives:** the environment variable `BOB_RELEASE_URL`, a base URL or an absolute folder path holding the
    release assets under their release names, laid out by version.
  - **Constraints:** a `file:` path or an `http(s)` URL. Not documented in the user manual.
  - **Missing-value behaviour:** the project's GitHub Releases.
- **Install script `--version`**
  - **What must exist:** the version to install (REQ-003).
  - **Where it lives:** the script's argument.
  - **Constraints:** `X.Y.Z` of a published release.
  - **Missing-value behaviour:** the latest release.

No setting is added to `config.toml`.

## Assumptions and Dependencies

- **The bundle form.** A per-platform archive that carries its own runtime was compared with the other forms in
  `docs/development/release_form.md` and accepted by the product owner in this spec's brainstorm. How it is built is
  recorded in the architecture documents in Feature Architecture.
- **Start at boot without admin rights for upgrades.** On Linux, a systemd service of the service account's own can
  start at boot without a login once lingering is on, and its owner can stop and start it without root. Confirmed by
  systemd's documentation in `release_form.md` section 3. Whether turning lingering on asks for admin rights depends on
  the machine; REQ-004 asks when it must. On macOS, starting at boot without a login needs a system-wide launchd service
  that runs as the service account, which needs admin rights to register (`release_form.md` section 3). Its daemon runs
  as the service account, so `bob upgrade` and `bob rollback` can stop it without admin rights, and the registration can
  let it start again without them (architecture consistency review of 2026-11-22; designed in Feature Architecture).
  That design, and whether a Mac with FileVault starts the service before the disk is unlocked, are unverified until a
  Mac is available (Open Questions).
- **The machine.** Linux x64 with glibc and systemd, or macOS on Apple silicon; `curl`, `tar` and a SHA-256 tool
  (`sha256sum` on Linux, `shasum` on macOS), network access to GitHub, and an installing person who can get admin rights
  once. Not confirmed per distribution; the install script and REQ-004 refuse with a reason when one is missing.
- **The pi login** stays in the service account's home and is used in place (S-002 REQ-018).
- **Upgrade relies on existing guarantees.** Running work survives a stop (S-002 REQ-005, REQ-008); a version refuses a
  database it can't read before changing it (S-002 REQ-002 step 4; S-004 REQ-001, REQ-017); the import step refuses an
  existing database (S-004 REQ-017), which is why rollback sets the current database aside first.
- **The configuration file and the internal folder across versions.** A new version may convert the configuration
  file and upgrade the internal folder at startup before it opens the database (S-002 REQ-002 steps 1 and 3; S-008
  REQ-003, REQ-011). The pre-upgrade copy therefore holds both with the database, so a switch-back and a rollback
  restore what the previous version ran on.
- **The secrets store is never copied.** Product owner decision of 2026-11-22, after the architecture consistency
  review: secrets stay only in the secrets store (S-002 REQ-018; S-009 REQ-002, REQ-020; ADR-010). After a rollback,
  an account added since the upgrade is gone from the configuration and its secrets go at the next start (S-002
  REQ-002 step 8); an account whose secrets changed since keeps the new ones.
- **A rollback repeats outside effects.** Restoring an older database makes the previous version resume the work that
  was in progress at the upgrade again (as S-004 REQ-017 says of an import), take in mail that arrived since again, and
  send mail it still owed that the newer version already sent. Product owner decision of 2026-11-22: rollback warns
  about it (REQ-009), and S-009 REQ-021 and REQ-022 are clarified to hold within one database's history.
- **Dependencies:** GitHub Releases and Actions on the public repository; the self-hosted CI runner (S-000, Continuous
  integration); the official Node 24 builds for linux-x64 and darwin-arm64.
- **Cross-spec amendments carried by this branch**, for approval at Gate 1 with this spec. S-000's platform list and
  S-002 REQ-004 and Success Criteria 4 need no change: they already expect both platforms, with each measured by hand.
  - **S-000 v0.10:** Command line, Boundary, gains a third exception, the installation commands, which manage the
    program and the service and call no operation apart from reading the version; Command line, Responsibility, names
    them; Installation and service setup and Command line name each other in Works with, and Installation also names
    Jobs and Skills and instructions, whose saved state its copy holds; Installation's Decisions needed are answered
    here and removed.
  - **S-002 v0.18:** Exclusions, Installation: release form and supervisor registration belong to S-010.
  - **S-005 v0.9:** S-010 adds the `service` group and the top-level `upgrade`, `rollback` and `uninstall`, and its
    install script puts `bob` on the `PATH`. They are installation commands: not data commands, outside REQ-016's "no
    state of its own", with their output and exit codes owned by S-010 (Definitions, REQ-001, REQ-003, REQ-016,
    Exclusions, Interfaces, Assumptions).
  - **S-009 v0.5:** REQ-021 and REQ-022: "exactly once" and "at most once" hold within one database's history, not
    across a rollback or an import of an older copy, which can take in or send mail again.

## Success Criteria

1. Pushing a pre-release tag on `main` publishes a release with exactly the five assets, and a mismatched tag
   publishes nothing (REQ-001). Observed on the release page and the run's log.
2. The installation cycle job passes in CI on every change: install, service setup, upgrade, both failed-upgrade paths,
   rollback, the cut-off cases and uninstall (REQ-002 to REQ-014, REQ-017). Observed in the CI run.
3. Live check on a real Linux x64 machine: install from the published release, `bob service install`, reboot with
   nobody logged in, `bob status` answers over SSH; `kill -9` of the daemon gets it restarted and a running job resumes;
   an upgrade and a rollback between two releases keep every job (REQ-004, REQ-006, REQ-009). Recorded by hand as
   evidence.
4. The manual's "Installing and upgrading" page covers REQ-016's list, and `npm run docs:build` passes (REQ-016).
5. Live check on a real Apple silicon Mac: the same steps as criterion 3, with the Mac restarted and nobody logged in
   (REQ-002 to REQ-004, REQ-014). Pending until a Mac is available; until then the release notes and the manual say
   macOS is unverified (product owner decision, 2026-11-22).

## Implementation Order

| Phase | Outcome | Depends on |
|---|---|---|
| 1 | The bundles and the release workflow: a tag builds and publishes both bundles with their checksums; a matching package version | Nothing |
| 2 | The install script and `bob service install`, `status` and `remove` on both platforms, with the installation cycle test for install and service setup in CI on Linux | Phase 1 |
| 3 | `bob upgrade` with both failure paths, `bob rollback`, the single-command lock and the cut-off cases | Phase 2 |
| 4 | `bob uninstall`, the manual and developer docs, the live check on a real Linux machine | Phase 3 |
| 5 | `bob service install` with no pi login: ready, exit 0 and the no-default-model notice; the manual's pi login section (CR-002) | Phase 4, S-002 phase 6 |

## Open Questions

- **Program folder and link paths.** Owner: Architect. Resolution: decided in Feature Architecture, within REQ-003's
  constraints (under the home, apart from the instance directories), and recorded in the manual.
- **How the service is registered** on Linux (for example a user unit with lingering, as `release_form.md` recommends)
  and on macOS (for example a launchd daemon running as the service account), within REQ-004 and REQ-014. Owner:
  Architect. Resolution: decided in Feature Architecture; the consistency review found REQ-014 can be met on both.
- **Resolved in CR-002's Feature Architecture (ADR-013 decision 6). How `bob service install` learns that there is no
  default model** (REQ-004): from the `noDefaultModel` field of the ready startup report, with no S-000 change and no
  operation called.
- **macOS behaviour on a real Mac**: start at boot without a login, FileVault, the restart after a failure. Owner:
  product owner, who provides the Mac. Resolution: Success Criteria 5, run once a Mac is available; it can't change the
  specified behaviour, only confirm it or raise a bug.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-24 | v0.2. The daemon starts and stays reachable without a pi login (CR-002). REQ-004, Interfaces (the `bob service install` row) and Workflow: a daemon that is ready with no pi login is ready; `bob service install` exits 0 and prints a notice that no model is available, pointing at signing in to pi. AC-004.3: "no pi login" leaves the cases that exit 1. New AC-004.5: no pi login exits 0 with the notice, and the service answers. REQ-016: the manual says the service runs without a pi login and what waits until a team member signs in. Open Questions: how `bob service install` learns that no model is available, for CR-002's Feature Architecture. No identifier retired. | CR-002, approved by the product owner on 2026-11-24. Gate 5 of this spec isn't signed off yet, so this reopens AC-004.3's acceptance. | CR-002's tasks; T-503 to T-505 are unaffected unless they cover the no-login case |
| 2026-11-24 | v0.2, same version, revised on the planning branch after the Architect's consistency review (corrections C11, C13) and CR-002's settled details of the same day. REQ-004, AC-004.5, Interfaces (the `bob service install` row), Workflow and Open Questions: the notice says there is no default model. REQ-016: the manual says that only agents of roles without their own model wait, that only fires with no model are skipped, and that signing in includes choosing a default model with `/model` when pi asks. Implementation Order: new phase 5. No identifier added or retired. | Architect's consistency review of 2026-11-24; product owner, CR-002 settled details, 2026-11-24. | CR-002's tasks |
| 2026-11-24 | v0.2, same version, revised on the planning branch with CR-002's Feature Architecture (Spec finding SF8). REQ-004 and Open Questions: `bob service install` learns that there is no default model from the `noDefaultModel` field of the ready startup report (ADR-013 decision 6); the question is resolved. No identifier added or retired. | CR-002 Feature Architecture, ADR-013 decision 6 amendment, 2026-11-24. | CR-002's tasks |
| 2026-11-26 | v0.3. REQ-015 renamed "Ready wait and bundle size": the four time thresholds (`bob service install` to ready, `bob upgrade` downtime, a switch back after a failed upgrade, the release workflow) are removed, and the spec now says it sets no time for the installation commands or the release workflow. The 60-second ready wait and the 150 MB bundle limit stay. AC-015.1 now checks that a bundle over 150 MB fails the build (test), and new AC-015.2 checks the published bundle sizes (demonstration). Success Criteria 3 no longer checks REQ-015 timings. AC-015.2 added; no identifier retired. | Product owner, 2026-11-26: the thresholds were not based on measurements, and the project has no reference machine for the test benches or the release runner, so a release time can't be met or tested meaningfully. | T-503 (AC-2 keeps the size check only), T-504 (AC-4 removed) |
| 2026-11-26 | v0.4. Interfaces, Commands: the exception for `daemon.status` also covers the ready wait of `bob service install`, `bob upgrade` and `bob rollback`, which reads the phase and the version with it. REQ-006 and Workflow: `bob upgrade` refuses, changing nothing, when standard input isn't a terminal and `--yes` isn't given. Cross-spec: S-005 v0.12, the installation commands' row of the Interfaces command table. No identifier added or retired. | Spec-truth reconciliation, 2026-11-26 (findings F2 and F3): the built work was right and the spec was out of date. Approved by the loop acting as product owner while the team member is away. | none (built as amended) |
| 2026-11-26 | Reconciliation record: spec-truth reconciliation — FAIL. S-010 v0.3 checked against T-464 to T-505, T-511, T-525, T-526, T-530 to T-532 and B-056 to B-063: running `bob service install` again replaces the record's `PATH`, against REQ-004 (follow-up task); Interfaces and S-005 said only `bob service status` calls `daemon.status`, but the ready wait does too, and REQ-006 omitted the no-terminal refusal (v0.4). Success Criteria 3 met through the product owner's substitute (a privileged systemd container, 2026-11-26); Success Criteria 5 pending. | Completion mode of the architecture consistency review | the follow-up task for REQ-004's `PATH` |
