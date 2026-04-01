#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional


PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_ROOT = PROJECT_DIR / "manual-runs"


def utc_timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def run_adb(device_id: str, args: list[str], *, binary: bool = False) -> str | bytes:
    command = ["adb", "-s", device_id, *args]
    completed = subprocess.run(command, check=False, capture_output=True)
    if completed.returncode != 0:
        stderr_text = completed.stderr.decode("utf-8", "replace").strip()
        if stderr_text:
            details = stderr_text
        elif binary:
            details = f"binary stdout length={len(completed.stdout)}"
        else:
            details = completed.stdout.decode("utf-8", "replace").strip()
        raise RuntimeError(f"{' '.join(command)} failed: {details}")
    return completed.stdout if binary else completed.stdout.decode("utf-8", "replace")


def resolve_device_id(explicit: Optional[str]) -> str:
    if explicit and explicit.strip():
        return explicit.strip()

    completed = subprocess.run(["adb", "devices", "-l"], check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "adb devices failed")

    for line in completed.stdout.splitlines():
        normalized = line.strip()
        if not normalized or normalized.startswith("List of devices attached"):
            continue
        parts = normalized.split()
        if len(parts) >= 2 and parts[1] == "device":
            return parts[0]

    raise RuntimeError("未检测到可用 Android 设备，请先连接 adb 设备")


def read_top_activity(device_id: str) -> str:
    raw = run_adb(device_id, ["shell", "dumpsys", "activity", "activities"])
    assert isinstance(raw, str)
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("topResumedActivity="):
            return stripped
    return ""


def read_window_focus(device_id: str) -> str:
    raw = run_adb(device_id, ["shell", "dumpsys", "window"])
    assert isinstance(raw, str)
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("mCurrentFocus=") or stripped.startswith("mCurrentFocusedWindow"):
            return stripped
    return ""


def capture_screenshot(device_id: str) -> bytes:
    raw = run_adb(device_id, ["exec-out", "screencap", "-p"], binary=True)
    assert isinstance(raw, bytes)
    return raw


def write_json_line(path: Path, payload: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


class ManualFlowRecorder:
    def __init__(
        self,
        device_id: str,
        output_root: Path,
        label: str,
        screenshot_interval_ms: int,
    ) -> None:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        safe_label = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in label).strip("-") or "manual-flow"
        self.run_dir = output_root / f"{timestamp}_{safe_label}"
        self.screenshots_dir = self.run_dir / "screenshots"
        self.device_id = device_id
        self.screenshot_interval_seconds = max(screenshot_interval_ms, 200) / 1000.0
        self.timeline_path = self.run_dir / "timeline.jsonl"
        self.getevent_path = self.run_dir / "getevent.log"
        self.meta_path = self.run_dir / "meta.json"
        self.stop_event = threading.Event()
        self.getevent_process: Optional[subprocess.Popen[str]] = None
        self.capture_thread: Optional[threading.Thread] = None
        self.getevent_thread: Optional[threading.Thread] = None
        self.frame_index = 0

    def setup(self) -> None:
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / "notes.txt").write_text(
            "手动录制说明：\n"
            "1. 保持微信在前台。\n"
            "2. 手动演示一次完整流程。\n"
            "3. 结束后按 Ctrl-C。\n",
            "utf-8",
        )
        (self.run_dir / "input-devices.txt").write_text(
            str(run_adb(self.device_id, ["shell", "getevent", "-pl"])),
            "utf-8",
        )
        self.meta_path.write_text(
            json.dumps(
                {
                    "device_id": self.device_id,
                    "started_at": utc_timestamp(),
                    "screenshot_interval_ms": int(self.screenshot_interval_seconds * 1000),
                    "run_dir": str(self.run_dir),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            "utf-8",
        )

    def start(self) -> None:
        self.setup()
        self.capture_frame(reason="initial")
        self.start_getevent()
        self.capture_thread = threading.Thread(target=self.capture_loop, name="capture-loop", daemon=True)
        self.capture_thread.start()

    def start_getevent(self) -> None:
        command = ["adb", "-s", self.device_id, "shell", "getevent", "-lt"]
        self.getevent_process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.getevent_thread = threading.Thread(target=self.copy_getevent_output, name="getevent-log", daemon=True)
        self.getevent_thread.start()

    def copy_getevent_output(self) -> None:
        assert self.getevent_process is not None
        assert self.getevent_process.stdout is not None
        with self.getevent_path.open("a", encoding="utf-8") as handle:
            for line in self.getevent_process.stdout:
                handle.write(f"{utc_timestamp()} {line}")
                if self.stop_event.is_set():
                    break

    def capture_loop(self) -> None:
        while not self.stop_event.wait(self.screenshot_interval_seconds):
            try:
                self.capture_frame(reason="poll")
            except Exception as error:  # noqa: BLE001
                write_json_line(
                    self.timeline_path,
                    {
                        "timestamp": utc_timestamp(),
                        "kind": "error",
                        "message": str(error),
                    },
                )

    def capture_frame(self, *, reason: str) -> None:
        self.frame_index += 1
        frame_id = f"frame-{self.frame_index:04d}"
        screenshot_path = self.screenshots_dir / f"{frame_id}.png"
        screenshot_path.write_bytes(capture_screenshot(self.device_id))
        write_json_line(
            self.timeline_path,
            {
                "timestamp": utc_timestamp(),
                "kind": "frame",
                "reason": reason,
                "frame_id": frame_id,
                "screenshot_path": str(screenshot_path),
                "top_activity": read_top_activity(self.device_id),
                "window_focus": read_window_focus(self.device_id),
            },
        )

    def stop(self) -> None:
        self.stop_event.set()
        try:
            self.capture_frame(reason="final")
        except Exception:
            pass

        if self.getevent_process and self.getevent_process.poll() is None:
            self.getevent_process.terminate()
            try:
                self.getevent_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.getevent_process.kill()
        if self.capture_thread:
            self.capture_thread.join(timeout=2)
        if self.getevent_thread:
            self.getevent_thread.join(timeout=2)

        meta = json.loads(self.meta_path.read_text("utf-8"))
        meta["stopped_at"] = utc_timestamp()
        meta["frame_count"] = self.frame_index
        self.meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", "utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device-id")
    parser.add_argument("--label", default="wechat-manual-flow")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--screenshot-interval-ms", type=int, default=800)
    args = parser.parse_args()

    device_id = resolve_device_id(args.device_id)
    output_root = Path(args.output_dir).expanduser().resolve()
    recorder = ManualFlowRecorder(
        device_id=device_id,
        output_root=output_root,
        label=args.label,
        screenshot_interval_ms=args.screenshot_interval_ms,
    )

    def _stop(_signum: int, _frame) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    recorder.start()
    print(
        json.dumps(
            {
                "ok": True,
                "device_id": device_id,
                "run_dir": str(recorder.run_dir),
                "message": "manual flow recording started; operate the phone, then press Ctrl-C to stop.",
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        recorder.stop()
        print(
            json.dumps(
                {
                    "ok": True,
                    "device_id": device_id,
                    "run_dir": str(recorder.run_dir),
                    "frame_count": recorder.frame_index,
                    "message": "manual flow recording stopped",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
