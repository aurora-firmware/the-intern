# Releasing

This page says how to cut a release of The Intern, how to build a bundle on your machine and how to run the
installation cycle against local bundles. The design behind them is in
[architecture.md](architecture.md) (Installation and service setup, Releases and Tests), the choice of form in
[release_form.md](release_form.md), and the requirements in [S-010](../ai-team/specs/S-010-installation-and-service-setup.md)
with [ADR-012](../ai-team/decisions/ADR-012-the-service-runs-the-current-version-through-a-stable-link-and-a-hold-file-keeps-it-stopped.md)
and [ADR-013](../ai-team/decisions/ADR-013-installed-versions-share-one-versioned-layout-and-resume-each-other-s-operations.md).

## Cut a release

The product owner cuts a release. A release is a tag `vX.Y.Z` on a commit of `main`, and nothing else starts one.

1. On `dev-pi-durable`, set the `version` field of `package.json` to the release's version, `X.Y.Z`, and merge that
   change. A pre-release carries a pre-release part, such as `0.2.0-rc.1`.
2. After Gate 5, the product owner merges `dev-pi-durable` into `main`.
3. On that commit of `main`, the product owner pushes the tag `v` plus the package version: `v0.2.0`, or `v0.2.0-rc.1`
   for a pre-release.
4. Check that the Release workflow, in the repository's Actions tab, ends green, and that the release has its assets.
5. Check macOS by hand on a Mac with Apple silicon. No job covers it: its checks and its launchd registration are
   covered by unit tests only, and the release notes say it isn't yet verified on a real Mac.

### What the workflow does

`.github/workflows/deploy.yml` runs on every pushed tag that starts with `v`. Every job runs on the self-hosted runner,
in the `node:24.22.0-bookworm` image.

| Job | What it does |
|---|---|
| `verify` | Runs `release/check_release.ts` on the tag. It fails when the tag isn't `v` plus `package.json`'s version, and when the tagged commit isn't an ancestor of `origin/main`. |
| `checks` | Calls `.github/workflows/build.yml`, so a release runs the same checks as a change, the installation cycle included. It needs `verify`. |
| `bundles` | Builds the `linux-x64` and `darwin-arm64` bundles with their `.sha256` files and writes `install.sh` with the version stamped in. It uploads them as one artifact. It needs `verify`. |
| `publish` | Needs the other three. It creates the GitHub Release with `gh release create`, titled with the tag, with `release/release_notes.md` as its notes, and with `--prerelease` when the version has a pre-release part. |

The workflow grants `contents: read`; only `publish` has `contents: write`. A failure in any job before `publish`
publishes nothing. A tag that already has a release fails `gh release create`.

### What refuses a tag

- A tag that isn't `v` plus the `package.json` version. Fix the version, merge it and push a tag that matches. A tag
  that was already pushed with the wrong name stays on the remote until the product owner deletes it.
- A tagged commit that isn't on `main`.
- A failed check or installation cycle in `checks`.
- A tag whose release already exists.

### Where the assets appear

The release page of the repository, under Releases, holds five assets for each release:

- `the-intern-X.Y.Z-linux-x64.tar.gz` and its `.sha256` file;
- `the-intern-X.Y.Z-darwin-arm64.tar.gz` and its `.sha256` file;
- `install.sh`, with `VERSION` set to `X.Y.Z`.

The `releases/latest/download/install.sh` link in [README.md](../../README.md) and in the
[manual's Installing and upgrading page](../manual/installing.md) points at the newest release that isn't a
pre-release.

## Build a bundle locally

From the repository root, after `npm ci`:

```
node release/build_bundle.ts linux-x64 --out .tmp/bundles
```

The platform is `linux-x64` or `darwin-arm64`. The command downloads the official Node build that matches the Node you
run and checks it against its published checksum, so it needs the network. It writes
`the-intern-<version>-<platform>.tar.gz` and its `.sha256` file into the folder, and prints the archive's path. Without
`--out`, the folder is `.tmp/release`. The version is `package.json`'s. The `--version` and `--patch` options exist for
the installation cycle's test bundles only. Building needs GNU `tar`.

## Run the installation cycle

The installation cycle (S-010 REQ-017) runs the commands of real bundles under systemd. It is not part of `npm test`;
CI runs it as the `Installation Cycle` job on every change and every release. Run it from the repository root:

```
test/install/run_cycle.sh [test file ...]
```

Without arguments, the script runs every `test/install/*.test.ts` file. Name one or more files to run only those. It
needs Docker, and it starts a privileged container, so run it on a machine where that is acceptable. It does this:

1. Builds the test bundles in a `node:24.22.0-bookworm` container, with `test/install/build_test_bundles.ts`, into
   `.tmp/install/bundles`.
2. Builds the `bob-install-rig` image from `test/install/Dockerfile`: `debian:bookworm` with systemd and no Node.
3. Starts that image privileged with systemd as its init, and waits until systemd runs.
4. Creates the account `tester` without `sudo`, turns its lingering on, and waits for its user manager.
5. Copies the bundles and the tests in, and runs the tests as `tester` with the test bundle's own `node`, which isn't on
   the `PATH` the commands get.
6. Removes the container when it ends, and exits with the test runner's status.

The output of the run goes to the terminal and to `.tmp/test-logs/install.log`. A run builds the bundles and boots a
container each time, so it takes minutes, even for one file. `npm run test:install` runs the same files on your own
machine, outside the container, where there is no `tester` account with lingering and no systemd to test against; use
`run_cycle.sh` instead.

### Install from local bundles

`BOB_RELEASE_URL` replaces the download location of `install.sh` and of every installation command that downloads. Set
it to an absolute path, a `file:` path or an `http(s)` URL of a folder laid out like this:

```
<location>/latest                                   the text "vX.Y.Z", the version `bob upgrade` finds
<location>/vX.Y.Z/the-intern-X.Y.Z-linux-x64.tar.gz
<location>/vX.Y.Z/the-intern-X.Y.Z-linux-x64.tar.gz.sha256
```

`build_bundle.ts` writes the archive and checksum into one folder: put them in the `vX.Y.Z` folder. An unstamped
`release/install.sh` has no version of its own, so give it one:

```
BOB_RELEASE_URL="$PWD/.tmp/location" sh release/install.sh --version X.Y.Z
```

This installs into `~/.local/lib/the-intern/` of your own account, as a real install does, and refuses when The Intern
is already installed there. Run it on a machine or account you can spare, or use the cycle's container.

### Stop an operation partway

`BOB_INSTALL_TEST_STOP_AFTER` is a test hook. Set it to the name of a step of `bob upgrade` or `bob rollback`, such as
`switched`, and the command records that step in `operation.json`, prints `stopped after <step>` on standard error and
waits for `SIGUSR2`. The cut-off tests send `SIGKILL` at that point, then run the next installation command and check
that it finishes the operation. The step names are in `src/install/install_model.ts` and the journal in
[ADR-013](../ai-team/decisions/ADR-013-installed-versions-share-one-versioned-layout-and-resume-each-other-s-operations.md).
The product carries no other failure switch.
