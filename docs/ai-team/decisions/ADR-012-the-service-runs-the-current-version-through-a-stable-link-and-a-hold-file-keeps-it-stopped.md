---
id: ADR-012
title: The service runs the current version through a stable link and a hold file keeps it stopped
status: accepted
created: '2026-11-22'
---

# ADR-012: The service runs the current version through a stable link and a hold file keeps it stopped

## Context

S-010 registers The Intern with systemd on Linux and launchd on macOS, so it starts at boot with nobody logged in,
runs as the service account and is restarted after a non-zero exit (S-010 REQ-004; S-002 REQ-004). The registration
fixes the instance directories and the pi agent folder. `bob upgrade` and `bob rollback` must stop and start the
service without admin rights on both platforms (S-010 REQ-014), and a cut-off upgrade must never let the service start
on a half-restored state directory (S-010 REQ-012). On macOS only a LaunchDaemon in the system domain starts before a
login, and only root can change it or stop it through `launchctl` (`docs/development/release_form.md`, section 3).
The registration outlives every version, so whatever an upgrade relies on in it must hold for later versions too.

## Decision

The registration names a path that never changes, `<program folder>/current/bin/bob`, and a hold file in the program
folder that every installation command creates to keep the service stopped and removes to let it start.

1. **One stable path.** The registration runs `<program folder>/current/bin/bob serve` with the four directory flags
   `bob service install` resolved, and the environment variables `PI_CODING_AGENT_DIR` (the resolved pi agent folder),
   `PATH` (the one `bob service install` ran with), `HOME` and `BOB_SERVICE_LABEL` (the unit name or launchd label).
   An upgrade or rollback switches `current` (ADR-013) and never rewrites the registration. Running
   `bob service install` again rewrites the registration from the record below.
2. **Linux: a user unit with lingering.** `~/.config/systemd/user/the-intern.service` with `Restart=on-failure`,
   `RestartSec=5`, `StartLimitIntervalSec=0`, `KillMode=mixed`, `TimeoutStopSec=20`,
   `ConditionPathExists=!<hold file>` and `WantedBy=default.target`, enabled with `systemctl --user enable`.
   `loginctl enable-linger` is tried first as the service account and, when the machine refuses it, through `sudo`.
   Stop is `systemctl --user stop`; start is `systemctl --user start`. Neither needs admin rights.
3. **macOS: a LaunchDaemon that runs as the service account.** `/Library/LaunchDaemons/com.aurora-firmware.the-intern.plist`,
   owned by root and mode `0644`, with `UserName`, `RunAtLoad`, `StandardErrorPath` set to `<state dir>/service.log`
   (created owner-only first), and `KeepAlive` set to `{ PathState: { <hold file>: false } }` only. launchd then keeps
   the daemon running, and restarts it after any exit, while the hold file is absent, and leaves it stopped while the
   hold file exists. `bob service install` writes the plist and runs `launchctl bootstrap system` in one `sudo` call.
   Stop is: create the hold file, then send SIGTERM to the pid in the instance's owner lock and wait for the lock to be
   released. Start is: remove the hold file. Neither needs admin rights. One machine holds one registration: a plist
   with another `UserName` is refused.
4. **The hold file.** `<program folder>/service.hold`. An installation command creates it before it stops the service
   and removes it just before it starts a version. On Linux it also stops a boot-time start, so a machine that
   restarts during an upgrade or rollback doesn't start the service until the next installation command finishes that
   operation (ADR-013 decision 4).
5. **The registration record.** `bob service install` writes `<program folder>/service.json` (ADR-013 decision 1):
   the platform, the unit name or label, the four instance directories, the pi agent folder, `PATH`, and whether it
   turned lingering on. Every later installation command reads the directories from it, and `bob uninstall` turns
   lingering off only when the record says it turned it on.
6. **Which daemon is the service's.** A daemon started with `BOB_SERVICE_LABEL` writes that label into its startup
   report (ADR-013 decision 6). An owner lock whose pid has no such report belongs to a daemon started by hand, and
   `bob upgrade` refuses (S-010 REQ-006).

## Consequences

- `bob upgrade` and `bob rollback` never need admin rights, and the root-owned plist is written once.
- On macOS a daemon that exits 0 while the hold file is absent is restarted too. A requested stop always creates the
  hold file first, so only a stray SIGTERM sent by hand meets this.
- On macOS launchd restarts at most once every 10 seconds (its default `ThrottleInterval`), so a failing version
  shows two or three attempts within the 60-second ready wait (S-010 REQ-015).
- On macOS the log grows in `<state dir>/service.log` without rotation; on Linux journald keeps it.
- Unverified until a Mac is available (S-010 Success Criteria 5): that launchd starts the job when the hold file goes,
  that `PathState` alone restarts it after `kill -9`, and that a Mac with FileVault starts it before the disk is
  unlocked. A failed check is a bug against this decision, not a spec change.
- The service's agents run tools with the `PATH` of the shell that ran `bob service install`. Running it again keeps
  the record as it is (S-010 REQ-004), so a new `PATH`, like new directories, takes `bob service remove` and then
  `bob service install`.

## Alternatives Considered

- **Write the registration with the version's own path and rewrite it at each upgrade:** rejected because the macOS
  plist is root-owned, so every upgrade would need admin rights (S-010 REQ-014).
- **macOS `KeepAlive` with `SuccessfulExit: false`:** rejected because the keys are alternatives, so a crash while the
  hold file exists would start the daemon in the middle of an upgrade.
- **Hold the service through the owner lock alone** (the daemon refuses to start while an installation command owns
  the instance): rejected because launchd and systemd would restart the refused daemon in a loop, and after a reboot
  the lock is stale, so a cut-off rollback would start the daemon on an empty state directory and create a new
  database.
- **A system-wide systemd unit with `User=`:** rejected because stopping and starting it needs root.
- **A macOS LaunchAgent:** rejected because it runs only while the person is logged in (S-000, S-002 REQ-004).
