#!/usr/bin/env python3
"""
Daemon spawner — starts a command as a true daemon (double-fork + setsid),
fully detached from the parent so the sandbox's process-tree-kill can't reach it.

Usage:
  python3 daemonize.py <script_path> <log_path>

The daemon:
  - Calls os.fork() twice (classic daemon pattern)
  - Calls os.setsid() to become a new session leader
  - Closes stdin/stdout/stderr and redirects them to /dev/null or a log file
  - Parent exits immediately, child runs forever
"""

import os
import sys
import signal


def daemonize(script_path: str, log_path: str):
    # First fork
    pid = os.fork()
    if pid > 0:
        # Parent exits
        return

    # Child: become session leader
    os.setsid()

    # Second fork (prevent reacquiring a controlling terminal)
    pid = os.fork()
    if pid > 0:
        os._exit(0)

    # Grandchild is now a true daemon
    os.chdir("/")
    os.umask(0)

    # Close all file descriptors
    try:
        os.close(0)
        os.close(1)
        os.close(2)
    except OSError:
        pass

    # Open /dev/null for stdin, log file for stdout+stderr
    devnull = os.open(os.devnull, os.O_RDWR)
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(devnull, 0)  # stdin
    os.dup2(log_fd, 1)   # stdout
    os.dup2(log_fd, 2)   # stderr

    # Reset signal handlers
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)

    # Exec the target script
    os.execvp("bash", ["bash", script_path])


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <script_path> <log_path>", file=sys.stderr)
        sys.exit(1)
    script_path = sys.argv[1]
    log_path = sys.argv[2]
    daemonize(script_path, log_path)
    # Parent returns here and Python exits cleanly
    print(f"Daemon spawned: {script_path} → log: {log_path}")
