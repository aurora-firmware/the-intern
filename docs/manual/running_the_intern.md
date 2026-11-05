# Running The Intern

The Intern is a service that runs in the background on a machine, as one service account. It keeps your team's jobs,
conversations and queued work in a database. When the service stops or the machine restarts, the work that was running
resumes where it left off, and nothing that was queued is lost.

## Start the service

Run:

```
bob serve
```

The service runs in the foreground, writes its log lines to standard error and keeps running until you stop it with
`SIGTERM` or `SIGINT` (Ctrl+C). It exits with status 0 only after a requested stop. Any other exit has a non-zero
status, so a supervisor such as systemd or launchd can restart it.

When the database refuses a write to a job, the service fails that call with `internal`, leaves the job and its
history as they were, logs "job store write failed; the daemon exits", and stops within 10 seconds with a non-zero
status. It doesn't reopen the database; your supervisor restarts it.

Until a release provides `bob`, run it from a checkout of the project:

```
node src/cli/bob.ts serve
```

The other commands, such as `bob status`, `bob jobs create` and `bob chat`, are listed in the
[Command reference](commands.md). `bob serve` takes these flags, all optional:

| Flag                  | Effect                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| `--config-dir <dir>`  | Use this config directory.                                              |
| `--state-dir <dir>`   | Use this state directory.                                               |
| `--data-dir <dir>`    | Use this data directory.                                                |
| `--runtime-dir <dir>` | Use this runtime directory.                                             |
| `--verbose`           | Write more detailed log lines.                                          |

Give each directory flag an absolute path. Any other flag or argument prints the usage line and exits with status 2.

## Where The Intern keeps its files

The Intern uses four directories, each in a folder named `the-intern`:

| Directory | Holds                                    | Default                                                 |
| --------- | ---------------------------------------- | ------------------------------------------------------- |
| config    | `config.toml`                            | `$XDG_CONFIG_HOME/the-intern`, else `~/.config/the-intern` |
| state     | the database, `the-intern.sqlite`        | `$XDG_STATE_HOME/the-intern`, else `~/.local/state/the-intern` |
| data      | the default workspaces of your roles     | `$XDG_DATA_HOME/the-intern`, else `~/.local/share/the-intern` |
| runtime   | the socket's directory                   | `$XDG_RUNTIME_DIR/the-intern`, else the `run` folder inside the state directory |

The runtime fallback matters on macOS and under launchd, which don't set `XDG_RUNTIME_DIR`.

The service creates a missing directory that only its account can use. If a directory exists but isn't a directory,
belongs to another account, or is open to the group or others, the service refuses to start and names the path and the
reason. Run `chmod 700` on the directory, or choose another one with the flag.

## Copy the database as a backup

The `jobs.export` operation writes a copy of the whole database to a new file while The Intern keeps working. Give it
`path`, an absolute path to a file that doesn't exist yet in a folder that does. It returns the path and the size
written.
From the command line, run [`bob export <file>`](commands.md#bob-export-file).

- The copy holds the jobs, their worklogs and histories, and the conversations and queued work, as committed when the
  copy started. It doesn't hold `config.toml`, so back that up on its own.
- The copy is readable only by the service account, and it never exists under its final name with wider access, not
  even while it is written.
- Running agents carry on. A write that arrives during the copy waits for it to finish.
- The copy starts when the database has no write in progress. If one is in progress, the service waits for it, up to
  about 5 seconds, so the copy can hold what was committed up to that long after the call. If the database is still in
  use then, or a write begins just as the copy starts, the call fails as `busy` saying the database is in use and
  writes nothing. Export again.
- A relative path, a path that already exists and a path in a folder that doesn't exist are refused as `invalid_input`
  naming `path`, and nothing is written.

## Restore a copy as the database

The import step places an exported file as the database of an instance that has none. Use it to move your jobs to
another computer running the same version, or to restore a backup. Run it with
[`bob import <file>`](commands.md#bob-import-file).

- Stop the instance's daemon first. The step takes the instance's single-owner lock while it runs, so it can't replace
  the database of a running daemon, and a daemon you start meanwhile refuses to start.
- The state directory must hold no database file and no `-wal` or `-shm` file. Move the old database and those files
  away yourself if you mean to replace it.
- The file's job schema and its pi-durable schema must not be newer than the version you run. The refusal names the
  schema and both versions. Use a newer release.
- A file that doesn't exist or isn't a SQLite database is refused too.
- Each refusal names its reason and changes nothing.
- The imported database is readable only by the service account, whatever the access of the file you named. The file
  you named is left as it was.
- An older job schema is migrated at the next start. The first start on the copy repairs a write that a crash cut
  short and resumes unfinished work, so importing a copy of an instance that is still running does that work twice.
  Stop that instance first, or export again after you stop it.

## The configuration file

The file is `config.toml` in the config directory. It is optional: without it, The Intern uses its built-in defaults.

- The service reads the file at start. When you edit it by hand, the edit applies at the next restart.
- If the file can't be parsed, has a key The Intern doesn't know or holds an invalid value, the service refuses to start
  and names the file, the key and the reason.
- A change you make through The Intern is checked first, then written to the file, and it applies at once. It survives
  a restart.
- After you edit the file by hand, The Intern refuses a change made through it until you restart the service, because
  it hasn't read your edit and would overwrite it. Restart, then make the change again.

## Models and the pi login

Models and their logins come from the service account's pi login. The Intern uses it in place: it doesn't copy the
credentials. Log in with pi as the service account before you start the service.

The service needs a default model to start. At startup it seats the [front desk](front_desk.md) as the `desk` role with
that role's defaults, so it needs the default model of the pi login or a `model` set for `desk` in `config.toml`. When
neither exists, the service refuses to start and names the `desk` role and its model.

The service reads the pi agent folder, `~/.pi/agent` by default. Set `PI_CODING_AGENT_DIR` in the service's environment
to use another folder.

## Pi agent settings that take effect

The Intern reads `settings.json` in the pi agent folder, but only the settings in this table take effect. Every other
pi agent setting has no effect. A value of the wrong type is left out, and the default applies.

| Setting                        | Value                                              |
| ------------------------------ | -------------------------------------------------- |
| `transport`                    | `auto`, `sse`, `websocket` or `websocket-cached`   |
| `retry.provider.timeoutMs`     | a whole number, 0 or more                          |
| `retry.provider.maxRetries`    | a whole number, 0 or more                          |
| `retry.provider.maxRetryDelayMs` | a whole number, 0 or more                        |
| `retry.enabled`                | `true` or `false`                                  |
| `retry.maxRetries`             | a whole number, 0 or more                          |
| `retry.baseDelayMs`            | a whole number, 0 or more                          |
| `retry.maxAgentDelayMs`        | a whole number, 0 or more                          |
| `steeringMode`                 | `all` or `one-at-a-time`                           |
| `followUpMode`                 | `all` or `one-at-a-time`                           |
| `compaction.enabled`           | `true` or `false`                                  |
| `compaction.reserveTokens`     | a whole number, 0 or more                          |
| `compaction.keepRecentTokens`  | a whole number, 0 or more                          |

## Limits you can't change

- The service runs at most 32 agent runs at once. Further work waits its turn, in order, and starts when a run finishes
  or parks. After a restart, the runs that were going resume first.
- One agent can invoke another to a depth of at most 10.
- A stop takes at most 10 seconds. If the service hasn't finished by then, it exits with a non-zero status. Queued
  and waiting work is kept either way.

## Reach The Intern over the network

On the machine, the command line reaches the service through the local socket `bob.sock` in the runtime directory. It
needs no setting.

Other computers reach The Intern through the network listener, which serves the web interface. The network listener is
off until you add a `[network]` section to `config.toml`. To open it to the computers on your local network (LAN), add:

```toml
[network]
address = "0.0.0.0"
port = 8080
```

| Key       | Value                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------- |
| `address` | an IP address or a host name of the machine. `0.0.0.0` listens on every network interface.     |
| `port`    | a whole number from 1 to 65535                                                                 |

Both keys are required, and the section takes no other key. Choose a fixed port that nothing else on the machine uses.

- Without the section, The Intern listens on no network port.
- The service reads the section at start. A change applies at the next restart.
- If a key is missing, has an invalid value, or isn't one of these two, the service refuses to start and names the file,
  the key and the reason.
- If the port is in use, or the address isn't one of the machine's, the service stops during startup with an error that
  names the address, the port and the reason. Free the port or fix the address, then start the service again.

After a restart, open `http://<address>:<port>/` in a browser, with the machine's address or host name on your network,
for example `http://192.168.1.20:8080/`. Until the web interface is released, the page reads "The web interface comes
later."

::: warning No login and no encryption
The network listener has no login and no encryption. Anyone who can reach its address and port can use The Intern,
with the service account's access, and what they send and receive crosses the network as plain text. Limit who can
reach that address with your network setup, for example with a firewall.
:::

## Who can use The Intern

No listener asks who you are. Everyone who can reach the service is an equal team member, and what they can do is
bounded by what the service account can do. Control who can reach the service through the machine and the network, and
give the service account only the access you want The Intern to have.
