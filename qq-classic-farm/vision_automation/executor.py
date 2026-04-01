from __future__ import annotations

import time

from adb_client import AdbClient
from models import Action


def execute_action(adb_client: AdbClient, action: Action, delay_ms: int, dry_run: bool) -> None:
    if action.kind == "abort":
        return

    if dry_run:
        time.sleep(delay_ms / 1000.0)
        return

    if action.kind == "tap":
        if not action.target:
            raise ValueError("tap action requires target coordinates")
        adb_client.tap(action.target[0], action.target[1])
    elif action.kind == "swipe":
        start = action.meta.get("start")
        end = action.meta.get("end")
        duration = int(action.meta.get("duration_ms", 300))
        if not isinstance(start, tuple) or not isinstance(end, tuple):
            raise ValueError("swipe action requires start/end tuples")
        adb_client.swipe(start[0], start[1], end[0], end[1], duration)
    elif action.kind == "back":
        adb_client.back()
    elif action.kind == "home":
        adb_client.home()
    elif action.kind == "wait":
        pass
    else:
        raise ValueError(f"unsupported action kind: {action.kind}")

    time.sleep(int(action.meta.get("ms", delay_ms if action.kind == "wait" else delay_ms)) / 1000.0)
