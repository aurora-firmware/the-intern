# Installing and upgrading

This page explains how to install The Intern, register it as a service that starts at boot, upgrade it, go back to the
earlier version and remove it. Each step is a `bob` command or one `curl` line.

The install script and the service run on Linux on x86-64 with systemd, and on a Mac with Apple silicon. The macOS
support hasn't yet been verified on a real Mac: its checks and its launchd registration are covered by tests only, so
expect rough edges there and report them.

## Install the program

Run one of these lines as your own account, never as root:

```
curl -fsSL https://github.com/aurora-firmware/the-intern/releases/latest/download/install.sh | sh
curl -fsSL https://github.com/aurora-firmware/the-intern/releases/latest/download/install.sh | sh -s -- --version X.Y.Z
```

The first line installs the latest release. The second installs the version you name in place of `X.Y.Z`.

The script checks the download against its published checksum before it unpacks it. If the download or the check
fails, it leaves nothing behind. It refuses, changes nothing and exits 1 when:

- the machine is Linux on ARM, a Linux with a musl C library, a Linux that doesn't run systemd, an Intel Mac or any
  other system;
- you run it as root;
- The Intern is already installed. The message names the installed version. Use `bob upgrade` instead;
- the version you name doesn't exist.

The script puts the program in `~/.local/lib/the-intern/` and links `bob` as `~/.local/bin/bob`. Both are yours alone:
no other account can read them. The program folder is apart from the folders that hold your instance's data, so
upgrading and uninstalling never mix the two up.

It ends by printing the installed version, the two paths and the next step. When `~/.local/bin` isn't on your `PATH`,
it also prints this line. Add it to your shell's startup file:

```
export PATH="$HOME/.local/bin:$PATH"
```

Installing doesn't sign in to pi, create a configuration file or add a mail account. Do these yourself, as the
service account.

## Sign in to pi first

The service needs the service account's pi login and a default model before it starts. Sign in with pi as the account
that runs the service, as [Models and the pi login](running_the_intern.md#models-and-the-pi-login) describes. To add
mail accounts afterwards, see [Email](email.md).

## Register the service

Run:

```
bob service install
```

The command registers The Intern with the operating system, starts it and waits until it is ready. The service starts
when the machine starts, with nobody logged in, runs as your account and restarts after a failure. On Linux it is a
systemd user service, and on macOS a launchd service.

The command asks for admin rights only for the step the machine needs them for. On Linux, that is turning on
lingering, which lets your account's service run at boot; if it is on already, nothing is asked. On a Mac, registering
a launchd service needs `sudo`. When you refuse or the machine doesn't allow it, the command stops with nothing
registered and says why.

When the daemon isn't ready in time, the command exits 1. It names the reason the daemon logged and the command that
shows the service's log. On Linux that command is `journalctl --user -u the-intern.service`. On a Mac it is `tail` on
`service.log` in the state directory.

### Which directories the service uses

The registration fixes the instance directories and the pi login folder that `bob service install` finds in its
environment: the default folders, or the ones your environment variables and `PI_CODING_AGENT_DIR` choose. The service
runs with them whatever its supervisor's environment holds. `bob upgrade`, `bob rollback` and `bob uninstall` act on
them too, not on those of the shell you run them from.

To change them, set the new environment, then run `bob service remove` and `bob service install` again. Run on its
own, `bob service install` again only points the registration at the current version and changes nothing else.

### Check the service

Run `bob service status` to see whether the service is registered, whether it starts at boot, whether it runs, which
version it runs and which directories and pi login folder it uses. It exits 0 in every state. `--json` prints the same
as one JSON object with the fields `registered`, `startsAtBoot`, `running`, `version`, `configDir`, `stateDir`,
`dataDir`, `runtimeDir` and `piAgentDir`.

### Remove the service

Run `bob service remove` to stop the service and take its registration away. The program and your data stay, `bob`
still runs, and a later `bob service install` finds every job.

## Upgrade

Run:

```
bob upgrade
```

The command upgrades to the latest release. `bob upgrade X.Y.Z` upgrades to that version, and `--yes` skips the
question. The upgrade never runs by itself: it happens only when you run the command. It refuses, changing nothing,
when:

- the service isn't registered;
- a daemon you started by hand owns the instance;
- another installation command is running. The message names it;
- the version you name is older than the current one. The message points to `bob rollback`.

When you already run the version you name, the command says so and exits 0.

The command downloads the release and checks its checksum. It asks "Stop the service and upgrade from X to Y?" and
exits 1 when you answer no. Without a terminal, give `--yes`. Then it prints each step as it runs: it stops the service,
copies the instance's saved state, switches to the new version, starts the service and waits until it is ready. Running
work resumes on the new version. The copy, called the pre-upgrade copy, holds the database, the configuration file and
the internal folder. It never holds the secrets store. The version you upgraded from stays as the previous version, so
`bob rollback` can return to it.

### When the new version fails to start

The command exits 1 in both cases below.

- **The new version doesn't become ready.** The command names the reason the daemon logged and switches back to the
  previous version without asking. It puts back the configuration file and the internal folder from the copy. When the
  new version had already opened the database, it also sets that database aside and restores the one from the copy.
  It then removes the version that failed. Your secrets store stays as it is.
- **The new version can't read the database.** This happens when the database comes from a newer version, or holds
  conversations the new version can't read. The command says so and asks "Switch back to X.Y.Z?", where yes is the
  default. Yes switches back as above. Without a terminal, the command takes the default and switches back.

  No keeps the new version and starts it on a new, empty database. Your old database goes into the upgrades folder and
  so does the pre-upgrade copy, and the command prints both paths and exits 0 once the new version is ready. The
  configuration file, the secrets store and the internal folder stay as the new version left them. `bob rollback`
  later brings back the previous version with every job.

If a kill or a power loss stops an installation command halfway, the next installation command that changes something
finishes the cut-off operation first.

## Roll back

Run:

```
bob rollback
```

The command returns to the previous version, with the database, the configuration file and the internal folder as
they were when the upgrade took its copy. It names the previous version and the time of the upgrade, then lists what
you lose and what may repeat:

- **Lost:** every job and conversation since the upgrade, and every change to the configuration, roles, instructions
  and skills since, including mail accounts you added.
- **May repeat:** work that was in progress at the upgrade may run again. Mail received since may be taken in again,
  and mail sent since may be sent again.

It asks "Stop the service and roll back to X?" unless you give `--yes`. Without a terminal and without `--yes`, it
refuses. It also refuses, changing nothing, when there is no previous version or no copy for it. The database it
replaces goes into the upgrades folder. After a rollback no previous version remains, so you can't roll back twice.

The rollback leaves the secrets store as it is. The secrets of mail accounts that the restored configuration no longer
holds go the next time the service starts. A mail account the rollback brings back without its secrets, because you
removed it after the upgrade, needs signing in again: run `bob mail signin` or `bob mail change <name> --new-secret`
as [Email](email.md) describes.

## Uninstall

Run:

```
bob uninstall
```

The command removes the service, the program folder and the `bob` link, and turns lingering off again when
`bob service install` turned it on. It never touches your pi login. It asks "Keep the instance's data?", where yes is
the default, and prints the paths of the directories it keeps. A new install and `bob service install` then find every
job.

- `--remove-data` removes the instance's directories without asking, with the upgrades folder inside them.
- Without a terminal, the command keeps the data unless you give `--remove-data`.
- `--yes` answers the question with yes, so it keeps the data.

## The upgrades folder

The `upgrades` folder in the state directory holds what The Intern keeps for going back. Only you can read it. It
holds two kinds of folder:

| Folder | Name | Holds |
| --- | --- | --- |
| Pre-upgrade copy | `<time>-<from>-to-<to>`, for example `2026-11-22T10-15-00-000Z-0.1.0-to-0.2.0` | The database, the configuration file and the internal folder, as they were when the service stopped. |
| Set-aside database | `<time>-<version>-<reason>`, where the version used the database last and the reason is `unreadable`, `failed-upgrade` or `rollback` | A database that was replaced, with its `-wal` and `-shm` files. |

The time is in UTC. A later upgrade replaces the older pre-upgrade copy only after it succeeds. The copy you kept by
answering no to the unreadable database question stays. Nothing deletes a set-aside database. Delete the folders you no
longer need yourself, once you are sure you won't roll back to them.

The program folder holds one more file, `operation.json`, while an upgrade or a rollback runs. The next installation
command uses it to finish an operation that was cut off. Leave it alone: if you delete it, you take the recovery on
yourself.
