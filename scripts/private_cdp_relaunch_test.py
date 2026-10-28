"""Fail-closed classification tests for disposable Chromium startup diagnostics."""
import unittest
from private_cdp_relaunch import classify_cdp_startup


class CdpRelaunchClassificationTests(unittest.TestCase):
    def test_leno_edge_launcher_exits_after_spawning_browser_with_private_pipe_flags(self):
        self.assertEqual(
            classify_cdp_startup(
                handshake_ok=False,
                launcher_pid=2708,
                launcher_exit_code=0,
                owned_processes=[
                    {"pid": 17448, "ppid": 2708, "role": "browser",
                     "pipe_flag": True, "handles_flag": True},
                    {"pid": 11568, "ppid": 17448, "role": "crashpad-handler",
                     "pipe_flag": False, "handles_flag": False},
                ],
            ),
            "launcher_relaunched_before_private_cdp_handshake",
        )

    def test_unrelated_process_or_renderer_cannot_be_misclassified_as_browser_relaunch(self):
        self.assertEqual(
            classify_cdp_startup(
                handshake_ok=False,
                launcher_pid=500,
                launcher_exit_code=0,
                owned_processes=[
                    {"pid": 600, "ppid": 500, "role": "renderer",
                     "pipe_flag": True, "handles_flag": True},
                    {"pid": 700, "ppid": 300, "role": "browser",
                     "pipe_flag": True, "handles_flag": True},
                ],
            ),
            "private_cdp_closed_unclassified",
        )

    def test_successful_handshake_takes_precedence_over_launcher_status(self):
        self.assertEqual(
            classify_cdp_startup(
                handshake_ok=True,
                launcher_pid=500,
                launcher_exit_code=0,
                owned_processes=[
                    {"pid": 600, "ppid": 500, "role": "browser",
                     "pipe_flag": True, "handles_flag": True},
                ],
            ),
            "private_cdp_ready",
        )

    def test_nonzero_exit_is_not_a_relaunch(self):
        self.assertEqual(
            classify_cdp_startup(
                handshake_ok=False,
                launcher_pid=500,
                launcher_exit_code=1,
                owned_processes=[],
            ),
            "browser_exited_with_error",
        )

    def test_browser_alive_without_any_handshake_remains_unclassified(self):
        self.assertEqual(
            classify_cdp_startup(
                handshake_ok=False,
                launcher_pid=500,
                launcher_exit_code=None,
                owned_processes=[],
            ),
            "private_cdp_closed_unclassified",
        )


if __name__ == "__main__":
    unittest.main()
