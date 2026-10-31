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

Until a release provides `bob`, run it from a checkout of the project:

```
node src/cli/bob.ts serve
```

`bob serve` takes these flags, all optional:

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

## Who can use The Intern

No listener asks who you are. Everyone who can reach the service is an equal team member, and what they can do is
bounded by what the service account can do. Control who can reach the service through the machine and the network, and
give the service account only the access you want The Intern to have.
