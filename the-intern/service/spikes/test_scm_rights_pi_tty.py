import os
import socket
import unittest
from pathlib import Path

from spikes import scm_rights_pi_tty


class ScmRightsPiTtyTests(unittest.TestCase):
    def test_transfers_three_file_descriptors_over_unix_socket(self) -> None:
        sender, receiver = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        read_fd, write_fd = os.pipe()
        duplicated_fds: list[int] = []
        try:
            scm_rights_pi_tty.send_fds(sender, [read_fd, write_fd, write_fd])
            duplicated_fds = scm_rights_pi_tty.receive_fds(receiver, expected=3)

            self.assertEqual(len(duplicated_fds), 3)
            os.write(duplicated_fds[1], b"fd-passing works")
            self.assertEqual(os.read(duplicated_fds[0], 16), b"fd-passing works")
        finally:
            sender.close()
            receiver.close()
            os.close(read_fd)
            os.close(write_fd)
            for fd in duplicated_fds:
                os.close(fd)

    def test_builds_default_interactive_pi_command_with_explicit_extension(self) -> None:
        extension = Path("/tmp/bob.ts")

        command = scm_rights_pi_tty.build_pi_command("/usr/bin/pi", extension)

        self.assertEqual(command[0], "/usr/bin/pi")
        self.assertIn("-e", command)
        self.assertIn(str(extension), command)
        self.assertNotIn("--print", command)
        self.assertNotIn("-p", command)
        self.assertNotIn("--mode", command)

    def test_receiver_rejects_passed_descriptors_that_are_not_ttys(self) -> None:
        sender, receiver = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        read_fd, write_fd = os.pipe()
        try:
            scm_rights_pi_tty.send_fds(sender, [read_fd, write_fd, write_fd])

            with self.assertRaisesRegex(RuntimeError, "not TTYs"):
                scm_rights_pi_tty.run_receiver(receiver, "/usr/bin/pi", Path("/tmp/bob.ts"))
        finally:
            sender.close()
            receiver.close()
            os.close(read_fd)
            os.close(write_fd)

    def test_accepts_an_explicit_pi_executable(self) -> None:
        arguments = scm_rights_pi_tty.parse_args(
            ["--pi", "/opt/pi-0.79.10/bin/pi", "--extension", "/tmp/bob.ts"]
        )

        self.assertEqual(arguments.pi, "/opt/pi-0.79.10/bin/pi")
        self.assertEqual(arguments.extension, Path("/tmp/bob.ts"))


if __name__ == "__main__":
    unittest.main()
