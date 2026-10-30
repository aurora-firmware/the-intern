# Release form

This page compares three ways to release The Intern and recommends one for the product owner to accept or change at
review. It settles the "What form does a release take" question of Installation and service setup in
[S-000](../ai-team/specs/S-000-system-overview.md), and gives the facts the boot-time-service and upgrade questions
need. It does not change [tech_stack.md](tech_stack.md); recording the choice there is a follow-up after the decision.

The supported platforms are Linux on x64 and macOS on Apple silicon (S-000, Project exclusions). The service runs as the
installing person's account (S-000, Installation and service setup; [ADR-002](../ai-team/decisions/ADR-002-equal-team-members-bounded-by-the-service-account.md),
decision 4), runs in the foreground, exits non-zero on every error and is restarted by the operating system's
supervisor ([S-002](../ai-team/specs/S-002-daemon-and-host-runtime.md) R-4;
[ADR-001](../ai-team/decisions/ADR-001-one-daemon-process-owns-one-pi-durable-database.md), decision 5).

## How to read this page

- Claims marked `[n]` rest on the numbered source in [Sources](#sources).
- Claims marked **measured** were taken in this task, on 2026-10-30, on Linux x64 with Node 24.22.0 and the repository's
  `package-lock.json`.
- Claims marked **unverified** are not backed by a source or a measurement made here. They need a check, on a Mac for
  the macOS ones, before the choice is final. They are collected in [What is still unverified](#what-is-still-unverified).

## The three forms

| Form | What a release contains | How `bob` runs |
|---|---|---|
| **A. npm package** | One package tarball. Dependencies are fetched by `npm install` | The team member's own Node 24 runs the package's `bin` file |
| **B. Per-platform archive** | One `.tar.gz` per platform: an unmodified Node 24 runtime, the package's files and its production `node_modules` | A launcher script runs the bundled `node` on the bundled sources |
| **C. Single executable per platform** | One executable per platform: the Node binary with the application blob injected | The executable is `bob` |

## 1. What a team member installs and needs beforehand

| Form | Needs beforehand | Install step |
|---|---|---|
| A | Node 24 and npm on the machine, a writable global npm prefix (or elevated rights for a system prefix, **unverified** as the default), and access to wherever the package is published. `engines` is only advisory for an installed dependency: a wrong Node gives a warning, not a refusal, unless the team member set `engine-strict` [8] | `npm install -g the-intern`; npm links the `bin` file onto the `PATH` [8] |
| B | Nothing. The Node runtime is inside the archive. A glibc-based Linux is assumed (**unverified**: the single-executable tests exclude Alpine [1]) | Download, unpack into a directory, add its `bin/` to the `PATH` |
| C | Nothing | Download, mark executable, put on the `PATH` |

The platform makes no difference to what is needed, except that the Linux archive is an x64 build and the macOS archive
an Apple silicon build. Intel Macs and Linux on ARM are out of scope (S-000).

## 2. Can the sources run by type stripping, or is a bundling step needed

Node 24 runs `.ts` files directly by type stripping, and refuses to do so for any file under a `node_modules` path
[2]. That one rule decides the question for form A.

| Form | Sources run directly? | Consequence |
|---|---|---|
| A | **No.** A global or local `npm install` puts the package under `node_modules`. **Measured:** a `.ts` file imported from `node_modules` fails on Node 24.22.0 with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | The package must ship compiled JavaScript, so the release gains a build step (for example `tsc` emitting `.js`). Development keeps running `.ts`. The pi packages are not affected: they already ship JavaScript in `dist/` (**measured**) |
| B | **Yes**, provided the unpacked application directory has no `node_modules` segment in its path. Its dependencies sit in their own `node_modules` beside the sources, and are JavaScript | No build step. The release runs the same files that the tests run. The install path must be chosen with that rule in mind, and `bob` can refuse a path that breaks it |
| C | **No.** A single executable runs one embedded script, and only in the CommonJS module system [1]. The project is ES modules | A bundler is needed to turn the TypeScript and every dependency into one CommonJS file. That is a new dependency, which needs a justification (coding guidelines), and a build step. Single executables are marked "Stability: 1.1 - Active development" [1] |

Form C also has to carry native code on its own: an addon must be added as an asset, written to a temporary file at
run time and loaded with `process.dlopen()` [1]. The production dependencies contain `.node` prebuilds
(`@earendil-works/pi-tui/native/...`, **measured**). Whether `bob` loads any of them is **unverified**.

## 3. Registering and removing the boot-time service with a `bob` command

The supervisor side is the same for all three forms. What differs per form is the program path written into the
service definition, and it is covered after the two platforms.

### Linux x64: systemd with lingering for the installing account

- `bob` writes a user unit to `~/.config/systemd/user/` (a documented load path for user mode [4]) with
  `Restart=on-failure`, which restarts the service on a non-zero exit and not after a clean exit [3]. That is the R-4
  contract. The unit is wanted by `default.target`. `systemctl --user enable --now` starts it.
- A user manager normally runs only while the person is logged in. With lingering enabled, "a user manager is spawned for the user at boot and kept around after
  logouts", which "allows users who are not logged in to run long-running services": `loginctl enable-linger <user>`
  [5]. That is what lets the service start at boot with no login. `bob` enables it for the installing account.
- Whether `loginctl enable-linger` for one's own account asks for administrator authentication depends on the
  machine's policy and is **unverified**. The manual does not say [5]. The installer should run it, and if refused,
  print `sudo loginctl enable-linger <user>` for the team member.
- Removal: `systemctl --user disable --now`, delete the unit file, and optionally `loginctl disable-linger` [5].
- A system unit with `User=` would also start at boot, but it needs root to install. Lingering needs no `sudo` to
  install the unit and fits "the installing person's account" (ADR-002), so it is the chosen design.
- The first word of `ExecStart=` must be an absolute path [3].

### macOS Apple silicon: launchd

| Choice | Starts before anyone logs in? | Admin rights? |
|---|---|---|
| **LaunchDaemon**, plist in `/Library/LaunchDaemons`, `UserName` set to the installing account | **Yes.** launchd loads the plists in `/Library/LaunchDaemons` as part of system start-up and launches the daemons that ask to be kept running [6] | **Yes.** Daemons installed globally must be owned by root and not group- or world-writable [6]; root privileges are required to modify the system domain [7]; `UserName` applies only to services loaded into the privileged system domain [9], so it is the way to run as a non-root account |
| **LaunchAgent**, plist in `~/Library/LaunchAgents` | **No.** A user agent "executes only while that user is logged in" [6] | No (the file is the user's own [6]) |

- Chosen design: a LaunchDaemon with `UserName`, `KeepAlive` with `SuccessfulExit` false (restart on a non-zero exit,
  matching R-4 [9]), `RunAtLoad`, and `StandardErrorPath` for the diagnostics R-4 writes to standard error [9]. launchd
  does not respawn a job more than once every 10 seconds by default (`ThrottleInterval` [9]), so a start-up failure
  loops slowly instead of hot.
- `bob service install` therefore needs administrator rights, once: it writes the root-owned plist and runs
  `launchctl bootstrap system <plist>`; removal is `launchctl bootout system/<label>` and deleting the plist [7].
  Everything else, including the daemon itself, runs as the installing account. This holds for all three forms.
- A LaunchAgent would need no admin rights but starts only after the person logs in, which does not meet S-000. The
  docs also say a user domain "may exist independently of a logged-in user" [7], but they do not say where a plist for
  it can live so that it loads at boot. That route is **unverified**, and is not relied on.
- Whether a Mac with FileVault turned on starts a LaunchDaemon before someone unlocks the disk at the boot screen is
  **unverified**. If it does not, "starts at boot without a login" needs the team's note that such a Mac waits for one
  unlock after each restart.

### What differs per form

| Form | The program path in the service definition | Effect |
|---|---|---|
| A | The absolute path of the `node` that ran `bob service install`, plus the package's `bin` file | If the team member later switches Node versions (a version manager changes the path), the stored path breaks and the service stops starting. `bob` has to re-register the service after such a change |
| B | `<root>/current/node/bin/node` plus the application entry file, via the stable `current` link | The path survives upgrades because `current` is repointed. Node cannot drift |
| C | The executable's own path | Simplest definition. Replacing the file replaces the program |

## 4. Automatic upgrade: export, install, import

S-000 says saved state does not carry over by itself and the job record is exported and imported instead; the Jobs
spec defines the export format and what happens to jobs still in progress, which this page does not settle. The form
decides only who runs the export, how the new version is installed, and whether the old one survives for rollback.

Common flow for `bob upgrade`: the running (old) `bob` exports the job record to a file, the new version is installed,
the new `bob` imports the file into its own state, the service definition points at the new version and the service
restarts. The old version must perform the export, because saved state is not read across versions on its own (S-000).

| Form | Fetch and install the new version | Old version after the upgrade |
|---|---|---|
| A | `npm install -g the-intern@<new>` from the registry. It replaces the old files in place, so the export has to happen first, and a failed install in the middle leaves a broken program | Gone. Rollback is a reinstall of the old version, and needs the registry and a compatible Node |
| B | Download and unpack the new archive into `versions/<new>`, then repoint `current` once the import has succeeded | Stays in `versions/<old>` until removed. Rollback is repointing `current`. Both copies ship their own Node |
| C | Download the new executable next to the old one, then move it over the old one (replacing a file by rename is a normal operation on both platforms, **unverified** for a running macOS binary) | Kept only if `bob` keeps a copy. Rollback is putting the copy back |

Form B and C give the same Node and the same SQLite to everyone, because `node:sqlite` uses the SQLite built into the
Node binary (the coding guidelines require `node:sqlite`). Form A lets the Node 24 minor, and so the SQLite version,
vary per machine.

## 5. Size

| Measure | Value | Basis |
|---|---|---|
| Node 24.22.2 official download, Linux x64 | 32.0 MB `.tar.xz`, 58.3 MB `.tar.gz` | **Measured** (HTTP `Content-Length` of the nodejs.org distribution files) |
| Node 24.22.2 official download, macOS arm64 | 27.5 MB `.tar.xz`, 53.1 MB `.tar.gz` | **Measured** |
| The `node` binary installed on this Linux machine | 127 MB | **Measured** (`ls -l`) |
| Production `node_modules` from the lockfile (`npm ci --omit=dev`) | 164 MB on disk, 27.3 MB as `.tar.gz` | **Measured**; today's four pi packages and their provider SDKs, all platforms' native prebuilds included |
| The project's own sources | Under 1 MB so far | **Measured** (`src/` holds one file) |

| Form | Download | On disk after install |
|---|---|---|
| A | About 27 MB of dependencies plus the package, from the registry. Node is not part of it | About 164 MB, plus the team member's own Node |
| B | About 55 to 60 MB per platform (Node `.tar.xz` size plus the dependencies' `.tar.gz` size; **estimate**, not built) | About 290 MB (the Node binary plus 164 MB of dependencies), minus any native prebuilds for other platforms that are pruned (**unverified** that pruning is safe) |
| C | A compressed Node binary of about 28 to 32 MB (**estimate**, the same files as in B) plus the bundle, whose size is **not measured** | About 127 MB plus the bundle. Unused code in the dependencies could shrink if the bundler removes it |

## 6. macOS signing and notarisation

Apple requires, for notarisation, code signing of every executable with a Developer ID certificate (not ad hoc), the
Hardened Runtime and a secure timestamp. The service accepts disk images, signed installer packages and ZIP archives,
and a ZIP cannot be stapled. Tickets are made for standalone binaries but cannot be stapled to them [10] [11]. An
unstapled product relies on Gatekeeper finding the ticket online and may be blocked while the Mac is offline [12].
Software built after 1 June 2019 and distributed with Developer ID must be notarised to run, from macOS 10.15 [10].

| Form | What we would sign | Notarisation |
|---|---|---|
| A | Nothing of ours is Mach-O: the package is JavaScript. Dependency `.node` prebuilds for darwin-arm64 are inside the package; whether macOS loads them unsigned is **unverified** | Not applicable to our files. Node comes from the team member's own install, with that source's own signing |
| B | Nothing, if the archive carries the official, unmodified `node` binary. That binary's own upstream signature and notarisation were not checked here (**unverified**). A separate notarised ZIP is optional | Optional. If chosen: Developer ID certificate, Hardened Runtime, `notarytool` upload of the ZIP; no stapling. Whether a file unpacked from a curl download is subject to Gatekeeper is **unverified** (the fetched Apple pages do not say) |
| C | The injected binary. Node's own steps are: remove the upstream signature, inject, then `codesign --sign -` (ad hoc) [1]. Ad hoc is not accepted for notarisation [10], so a notarised build needs the Developer ID signature and the Hardened Runtime | Needed for a clean first run on a downloaded binary. No stapling for a bare binary [11]. Whether V8 needs extra Hardened Runtime entitlements here is **unverified** and needs a test on a Mac. `codesign` and `notarytool` run only on macOS, so the build needs a macOS job; the project's continuous integration is a self-hosted Linux runner (tech_stack) and checks macOS by hand |

The Apple Developer Program membership that issues a Developer ID certificate is a cost and an owner (not checked in
the sources above).

## 7. What a tag-triggered GitHub Release attaches

A pushed tag starts the Release workflow (`on: push: tags`, as in `.github/workflows/deploy.yml` [13]).
`gh release create <tag> <files...>` creates the release and uploads the files as assets; the assets cannot be modified
or deleted afterwards [14]. Creating a release will need write permission on repository contents, whereas the
placeholder now declares read (**unverified** against GitHub's permission docs).

| Form | Assets | Where it is built |
|---|---|---|
| A | `the-intern-<version>.tgz` from `npm pack`, plus checksums. Publishing to a registry (npm, which has public and private packages [8] [15]) is a separate step; installing straight from the asset URL needs the repository to be public or a token (**unverified**) | Linux runner. Compile step runs first (section 2) |
| B | `the-intern-<version>-linux-x64.tar.gz`, `the-intern-<version>-darwin-arm64.tar.gz`, `SHA256SUMS`. The macOS archive can be assembled on the Linux runner: download the official macOS Node tarball, verify its checksum, add the sources and the production `node_modules` | Linux runner alone |
| C | `bob-<version>-linux-x64`, `bob-<version>-darwin-arm64` (compressed), `SHA256SUMS`. A blob and its Node binary must have the same version [1]. A cross-platform build must turn off the code cache and snapshots [1] | Linux runner for Linux; a macOS runner for macOS (signing, notarisation) |

## Recommendation

**Form B: a per-platform archive with a bundled Node 24 runtime.**

Why:

1. **It keeps the decided development model.** The release runs the same `.ts` sources, by type stripping, that the
   tests run. A (compiled JavaScript) and C (bundle to one CommonJS file) each add a build step and a second form of
   the code that tests do not exercise, against the "no build step" decision in tech_stack.
2. **It removes the Node 24 prerequisite and drift.** One Node and one SQLite per release; no stale path in the service
   definition after a Node version switch (form A).
3. **It upgrades and rolls back cleanly.** Versioned directories and a `current` link let the old version stay on disk
   for the export, and let a failed upgrade be undone by repointing the link.
4. **It builds in the existing continuous integration.** No macOS runner, certificate or notarisation is needed
   to produce the release, because the macOS Node runtime is used as released upstream.
5. **The service definition is simplest to keep correct** on both platforms, as described in section 3.

Trade-offs the product owner accepts:

- **Larger than A** by about the size of Node (50 to 60 MB per archive, about 290 MB installed). C is smaller on disk
  only if the bundler removes unused code, which is unmeasured.
- **Not a single file.** A team member unpacks a directory and `bob` keeps a layout (`versions/`, `current`) that it
  must manage. The install path must not contain a `node_modules` segment.
- **Archive trust.** Without a notarised ZIP, macOS trust rests on the checksum and on how the file was downloaded; that
  is **unverified** here. Notarising the ZIP later needs a Developer ID certificate and a macOS step, and would still
  not be stapled.
- **We ship the Node runtime.** A Node security release is a new release of The Intern, not a package update on the
  team member's machine.
- **macOS service install needs admin rights once** (a LaunchDaemon). That is true of every form. A LaunchAgent avoids
  it but does not meet "starts without anyone logging in".
- **Revisit C** if a notarised single file becomes a requirement and the team accepts a bundler and a macOS build job.
  **Revisit A** if the team guarantees Node 24 on every machine and accepts a compile step.

## What is still unverified

These are not backed by a source or a measurement made in this task. Each needs a check before the choice is final.

1. On a Mac: a LaunchDaemon with `UserName` starts at boot before login, and restarts after `kill -9` (this is also
   S-002 live acceptance test 3); behaviour with FileVault on.
2. On Linux: whether `loginctl enable-linger` for one's own account prompts for authentication on the target
   distributions.
3. Whether the official macOS `node` binary is signed and notarised by upstream, and whether an archive downloaded with
   `curl` or a browser triggers Gatekeeper.
4. Whether `bob` loads any `.node` prebuild from the pi packages, and whether macOS accepts those unsigned.
5. The sizes of a built archive and of a bundle (the numbers above are estimates built from measured parts).
6. Whether a glibc Linux requirement applies to the official Node binary.
7. Form C only: V8 entitlements under the Hardened Runtime; replacing a running macOS binary by rename.
8. Release permissions for the workflow and installing from an asset URL when the repository is private.

## Sources

1. Node.js 24 documentation, Single executable applications:
   <https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html> (one embedded CommonJS script,
   "Stability: 1.1 - Active development", postject and `codesign --sign -` steps, native addons as assets,
   platform support and the cross-platform build note).
2. Node.js 24 documentation, Modules: TypeScript, "Type stripping in dependencies":
   <https://nodejs.org/docs/latest-v24.x/api/typescript.html>.
3. systemd.service(5): <https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html> (`Restart=`,
   `on-failure`, absolute path of the first `ExecStart=` word).
4. systemd.unit(5): <https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html> (user-mode load path
   `~/.config/systemd/user`).
5. loginctl(1): <https://www.freedesktop.org/software/systemd/man/latest/loginctl.html> (`enable-linger`,
   `disable-linger`).
6. Apple, Daemons and Services Programming Guide, Creating Launch Daemons and Agents:
   <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>
   (start-up sequence, `/Library/LaunchDaemons`, user agents run only while logged in, root ownership and file modes).
7. launchctl(1): <https://keith.github.io/xcode-man-pages/launchctl.1.html> (mirror of the Apple manual page; domain
   targets, root needed to modify the system domain, `bootstrap`, `bootout`).
8. npm documentation, package.json (`bin`, `engines`, `files`):
   <https://docs.npmjs.com/cli/v11/configuring-npm/package-json>.
9. launchd.plist(5): <https://keith.github.io/xcode-man-pages/launchd.plist.5.html> (mirror of the Apple manual page;
   `UserName`, `KeepAlive`/`SuccessfulExit`, `RunAtLoad`, `ThrottleInterval`, `StandardErrorPath`).
10. Apple, Notarizing macOS software before distribution:
    <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>.
11. Apple, Customizing the notarization workflow:
    <https://developer.apple.com/documentation/security/customizing-the-notarization-workflow> (accepted formats,
    stapling, standalone binaries).
12. Apple, Packaging Mac software for distribution:
    <https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution> (stapling and offline
    Gatekeeper; ZIP archives cannot be signed).
13. GitHub Docs, Events that trigger workflows (`push` with `tags`):
    <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>.
14. GitHub CLI manual, `gh release create`: <https://cli.github.com/manual/gh_release_create>.
15. npm documentation, `npm publish`: <https://docs.npmjs.com/cli/v11/commands/npm-publish>.

Pages 1 to 15 were fetched on 2026-10-30. Sizes come from `https://nodejs.org/dist/v24.22.2/` and from a local
`npm ci --omit=dev --ignore-scripts` with the repository's lockfile.
