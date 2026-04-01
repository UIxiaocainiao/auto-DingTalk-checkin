from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Optional, Tuple


def _command_string(parts: list[str]) -> str:
    return " ".join(parts)


class AdbClient:
    def __init__(self, device_id: str) -> None:
        self.device_id = device_id

    def _run(
        self,
        args: list[str],
        *,
        binary: bool = False,
        allow_non_zero: bool = False,
    ) -> str | bytes:
        command = ["adb", "-s", self.device_id, *args]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
        )
        if completed.returncode != 0 and not allow_non_zero:
            details = completed.stderr.decode("utf-8", "replace").strip() or completed.stdout.decode("utf-8", "replace").strip()
            raise RuntimeError(f"{_command_string(command)} failed: {details}")
        return completed.stdout if binary else completed.stdout.decode("utf-8", "replace")

    def screencap(self) -> bytes:
        raw = self._run(["exec-out", "screencap", "-p"], binary=True)
        if not isinstance(raw, bytes):
            raise RuntimeError("expected binary screencap result")
        return raw

    def tap(self, x: int, y: int) -> None:
        self._run(["shell", "input", "tap", str(x), str(y)])

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 300) -> None:
        self._run(["shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(duration_ms)])

    def back(self) -> None:
        self._run(["shell", "input", "keyevent", "4"])

    def home(self) -> None:
        self._run(["shell", "input", "keyevent", "3"])

    def current_focus(self) -> Tuple[str, str]:
        raw = self._run(["shell", "dumpsys", "window"])
        if not isinstance(raw, str):
            return "", ""

        for pattern in [
            r"mCurrentFocus=Window\{[^\s]+\s+[^\s]+\s+([^/\s]+)/([^\s\}]+)",
            r"mFocusedApp=.* ([^/\s]+)/([^\s\}]+)",
            r"topResumedActivity=.* ([^/\s]+)/([^\s\}]+)",
        ]:
            match = re.search(pattern, raw)
            if match:
                return match.group(1), match.group(2)
        return "", ""

    def ensure_scrcpy_observer(self) -> None:
        running = subprocess.run(["pgrep", "-x", "scrcpy"], check=False, capture_output=True)
        if running.returncode == 0:
            return
        subprocess.Popen(
            ["scrcpy", "-s", self.device_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
