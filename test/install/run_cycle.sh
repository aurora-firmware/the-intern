#!/usr/bin/env bash
# Runs the installation cycle's tests as the account `tester` in a privileged
# debian:bookworm container that boots systemd (S-010 REQ-017).
# Usage: test/install/run_cycle.sh [test file ...]
set -u

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo" || exit 1

builder_image="node:24.22.0-bookworm"
rig_image="bob-install-rig"
container="bob-install-rig-$$"
bundles="$repo/.tmp/install/bundles"
log="$repo/.tmp/test-logs/install.log"
runner_dir="/opt/install-runner"
test_version="0.1.0"
bundle="the-intern-$test_version-linux-x64.tar.gz"

cleanup() {
    docker rm -f "$container" >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
    echo "run_cycle.sh: $1" >&2
    exit 1
}

if [ "$#" -eq 0 ]; then
    set -- test/install/*.test.ts
fi

mkdir -p "$bundles" "$(dirname "$log")" || fail "cannot create $bundles or the log folder"

# Build the test bundles in the Node image, so the machine needs no Node.
if [ -f test/install/build_test_bundles.ts ]; then
    build_command="node test/install/build_test_bundles.ts --out /out"
else
    build_command="node release/build_bundle.ts linux-x64 --version $test_version --out /out"
fi
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$repo:/repo:ro" -v "$bundles:/out" -w /repo \
    "$builder_image" sh -c "$build_command" >&2 || fail "building the test bundles failed"
[ -f "$bundles/$bundle" ] || fail "the build left no $bundle in $bundles"

docker build -q -t "$rig_image" -f test/install/Dockerfile test/install >/dev/null || fail "building the image failed"

docker run -d --name "$container" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock "$rig_image" /sbin/init >/dev/null || fail "starting the container failed"

# The bus may not be up when the container starts, so ask again a bounded number of times.
booted=""
for _ in $(seq 1 60); do
    if [ "$(docker exec "$container" systemctl is-system-running 2>/dev/null)" = "running" ]; then
        booted="yes"
        break
    fi
    sleep 1
done
[ -n "$booted" ] || fail "systemd did not reach the running state in the container"

# The setup step: the account, its lingering, and the test runner.
docker exec "$container" useradd -m -s /bin/bash tester || fail "creating the account tester failed"
docker exec "$container" loginctl enable-linger tester || fail "turning lingering on for tester failed"
uid="$(docker exec "$container" id -u tester)" || fail "reading the uid of tester failed"
runtime_dir="/run/user/$uid"
docker exec -i "$container" sh -c "mkdir -p $runner_dir && tar -xzf - -C $runner_dir --strip-components=3 \
    the-intern-$test_version-linux-x64/node/bin/node" <"$bundles/$bundle" \
    || fail "taking the test runner out of $bundle failed"

# Wait for the user manager of tester, as a bounded number of tries.
ready=""
for _ in $(seq 1 60); do
    if docker exec -u tester -e "XDG_RUNTIME_DIR=$runtime_dir" -e "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime_dir/bus" \
        "$container" systemctl --user is-system-running >/dev/null 2>&1; then
        ready="yes"
        break
    fi
    sleep 1
done
[ -n "$ready" ] || fail "the user manager of tester did not answer systemctl --user"

# Copy the bundles and the tests in, owned by tester.
docker exec -u tester "$container" mkdir -p /home/tester/bundles /home/tester/work || fail "creating folders failed"
tar -C "$bundles" -c . | docker exec -i -u tester "$container" tar -x -C /home/tester/bundles \
    || fail "copying the bundles in failed"
tar -C "$repo" -c package.json test/install test/support | docker exec -i -u tester "$container" \
    tar -x -C /home/tester/work || fail "copying the tests in failed"

# The runner is not on the PATH the commands get.
docker exec -u tester -w /home/tester/work \
    -e "XDG_RUNTIME_DIR=$runtime_dir" \
    -e "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime_dir/bus" \
    -e "PATH=/usr/local/bin:/usr/bin:/bin" \
    -e "INSTALL_BUNDLES=/home/tester/bundles" \
    "$container" "$runner_dir/node" --test --test-reporter=spec "$@" 2>&1 | tee "$log"
exit "${PIPESTATUS[0]}"
