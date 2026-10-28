"""Classify observable private-CDP startup boundaries without weakening policy.

This module never reads user profiles, accesses process handles, changes
browser configuration, or declares that a child actually inherited a pipe.
Process evidence must already be restricted to one disposable test profile.
"""


def classify_cdp_startup(
    *,
    handshake_ok,
    launcher_pid,
    launcher_exit_code,
    owned_processes,
):
    if handshake_ok:
        return "private_cdp_ready"

    # Windows Edge may exit normally after launching a second browser with
    # identical CDP switches. Command-line inheritance DOES NOT prove HANDLE
    # inheritance. Report the observed relaunch, not an unverified mechanism.
    if launcher_exit_code == 0 and isinstance(launcher_pid, int):
        for child in owned_processes:
            if (
                child.get("ppid") == launcher_pid
                and child.get("role") == "browser"
                and child.get("pipe_flag") is True
                and child.get("handles_flag") is True
            ):
                return "launcher_relaunched_before_private_cdp_handshake"

    if isinstance(launcher_exit_code, int) and launcher_exit_code != 0:
        return "browser_exited_with_error"
    return "private_cdp_closed_unclassified"
