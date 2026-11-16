#!/usr/bin/env python3
"""Start real Pi in a PTY; no model requests or cleanup commands are executed."""
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time

ROOT = Path(__file__).resolve().parent.parent


def run(mode, locale):
    russian = locale.startswith("ru")
    label = f"{mode} {locale}"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = {**os.environ, "TERM": "xterm-256color", "PI_OFFLINE": "1", "LC_ALL": locale}
    command = ["pi", "-ne", "-e", str(ROOT / "src/index.ts"), "--offline",
               "--no-session", "--no-context-files", "--no-themes", "--use-theme", "dark",
               "--no-skills", "--no-mcp", "--no-approve", "--tui-mode", mode]
    proc = subprocess.Popen(command, cwd=ROOT, env=env, stdin=slave, stdout=slave,
                            stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def pump(seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            ready, _, _ = select.select([master], [], [], min(0.1, max(0, until - time.monotonic())))
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                output.extend(data)

    def require(text):
        assert text in output.decode("utf-8", errors="replace"), f"{label}: missing {text!r}"

    try:
        pump(4)
        require("Диск: занято" if russian else "Disk: used")
        assert proc.poll() is None, f"Pi exited early: {proc.returncode}"
        os.write(master, b"/disk\r")
        pump(2)
        require("Диск · обзор" if russian else "Disk · overview")
        require("Топ-20" if russian else "Top 20")
        os.write(master, b"c")
        pump(0.5)
        require("Рекомендации по очистке" if russian else "Cleanup recommendations")
        require("systemd-tmpfiles")
        os.write(master, b"\x1b")
        pump(0.5)
        assert proc.poll() is None
        print(f"PASS {label}: indicator, /disk, report, cleanup advice, Esc")
    except Exception:
        # Strip neither private session data nor credentials into a log; print only a short error marker.
        print(f"FAIL {label}: {len(output)} terminal bytes captured (not printed)")
        raise
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        os.close(master)


if __name__ == "__main__":
    for locale in ("ru_RU.UTF-8", "en_US.UTF-8"):
        for mode in ("fullscreen", "regular"):
            run(mode, locale)
