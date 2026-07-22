#!/usr/bin/env python3
"""Confirm that pi's interactive TUI works on terminal fds passed via SCM_RIGHTS.

Run this script from an interactive terminal. The sender passes its stdin,
stdout, and stderr over a Unix socketpair. The receiver then spawns pi with the
received descriptors and the repository's bob.ts extension.
"""

from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from array import array
from pathlib import Path
from typing import Sequence


def send_fds(sock: socket.socket, fds: Sequence[int]) -> None:
    """Send file descriptors as SCM_RIGHTS ancillary data."""
    payload = array("i", fds)
    sent = sock.sendmsg(
        [b"\0"],
        [(socket.SOL_SOCKET, socket.SCM_RIGHTS, payload)],
    )
    if sent != 1:
        raise RuntimeError(f"expected to send one marker byte, sent {sent}")


def receive_fds(sock: socket.socket, expected: int) -> list[int]:
    """Receive exactly ``expected`` file descriptors from SCM_RIGHTS data."""
    item_size = array("i").itemsize
    ancillary_size = socket.CMSG_SPACE(expected * item_size)
    receive_flags = getattr(socket, "MSG_CMSG_CLOEXEC", 0)
    _, ancillary, message_flags, _ = sock.recvmsg(1, ancillary_size, receive_flags)

    if message_flags & socket.MSG_CTRUNC:
        raise RuntimeError("SCM_RIGHTS ancillary data was truncated")

    received: list[int] = []
    for level, kind, data in ancillary:
        if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
            continue
        values = array("i")
        values.frombytes(data[: len(data) - (len(data) % item_size)])
        received.extend(values)

    if len(received) != expected:
        for fd in received:
            os.close(fd)
        raise RuntimeError(f"expected {expected} file descriptors, received {len(received)}")
    return received


def build_pi_command(pi_path: str, extension_path: Path) -> list[str]:
    """Build a default-interactive pi invocation with only bob.ts loaded."""
    return [
        pi_path,
        "--no-extensions",
        "-e",
        str(extension_path),
        "--no-session",
    ]


def run_receiver(sock: socket.socket, pi_path: str, extension_path: Path) -> int:
    terminal_fds = receive_fds(sock, expected=3)
    try:
        non_tty = [index for index, fd in enumerate(terminal_fds) if not os.isatty(fd)]
        if non_tty:
            names = ["stdin", "stdout", "stderr"]
            invalid = ", ".join(names[index] for index in non_tty)
            raise RuntimeError(f"received descriptors are not TTYs: {invalid}")

        os.write(
            terminal_fds[2],
            b"SCM_RIGHTS transfer confirmed; starting interactive pi. "
            b"Exit pi normally to finish the spike.\n",
        )
        environment = os.environ.copy()
        environment.setdefault("BOB_SESSION_ID", "scm-rights-tty-spike")
        environment.setdefault(
            "BOB_EXTENSION_SOCK_PATH", "/tmp/bob-scm-rights-tty-spike-extension.sock"
        )
        environment.setdefault("PI_OFFLINE", "1")

        with tempfile.TemporaryDirectory(prefix="pi-scm-rights-spike-") as state_dir:
            environment.setdefault("PI_CODING_AGENT_DIR", state_dir)
            return subprocess.run(
                build_pi_command(pi_path, extension_path),
                stdin=terminal_fds[0],
                stdout=terminal_fds[1],
                stderr=terminal_fds[2],
                env=environment,
                check=False,
            ).returncode
    finally:
        for fd in terminal_fds:
            os.close(fd)


def run_spike(pi_path: str, extension_path: Path) -> int:
    sender, receiver = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    child_pid = os.fork()
    if child_pid == 0:
        sender.close()
        try:
            exit_code = run_receiver(receiver, pi_path, extension_path)
        except Exception as error:  # noqa: BLE001 - boundary reports spike failures
            print(f"spike receiver failed: {error}", file=sys.stderr)
            exit_code = 1
        finally:
            receiver.close()
        os._exit(exit_code)

    receiver.close()
    try:
        send_fds(sender, [sys.stdin.fileno(), sys.stdout.fileno(), sys.stderr.fileno()])
    finally:
        sender.close()

    _, status = os.waitpid(child_pid, 0)
    return os.waitstatus_to_exitcode(status)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pi",
        default="pi",
        help="pi executable name or path (default: resolve pi from PATH)",
    )
    parser.add_argument(
        "--extension",
        type=Path,
        default=repository_root / "pi-extension" / "bob.ts",
        help="path to bob.ts",
    )
    return parser.parse_args(argv)


def main() -> int:
    if os.name != "posix":
        print("SCM_RIGHTS is only available on POSIX systems", file=sys.stderr)
        return 1

    args = parse_args()
    pi_path = shutil.which(args.pi)
    if pi_path is None:
        print(f"pi executable not found: {args.pi}", file=sys.stderr)
        return 1
    if not args.extension.is_file():
        print(f"extension does not exist: {args.extension}", file=sys.stderr)
        return 1

    return run_spike(pi_path, args.extension.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
