from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from models import Action, ExecutionContext, Frame, ScreenState


def _jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, Path):
        return str(value)
    return value


class RunLogger:
    def __init__(self, runs_root: Path, phase: str) -> None:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        self.run_dir = runs_root / f"{timestamp}_{phase}"
        self.screenshots_dir = self.run_dir / "screenshots"
        self.parser_dir = self.run_dir / "parser"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)
        self.parser_dir.mkdir(parents=True, exist_ok=True)
        self.actions_path = self.run_dir / "actions.jsonl"
        self.state_path = self.run_dir / "state.jsonl"
        self.errors_path = self.run_dir / "errors.log"

    def save_frame(self, frame: Frame) -> str:
        target = self.screenshots_dir / f"{frame.frame_id}.png"
        target.write_bytes(frame.image_bytes)
        return str(target)

    def save_parser_payload(self, frame_id: str, payload: dict[str, Any]) -> str:
        target = self.parser_dir / f"{frame_id}.json"
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")
        return str(target)

    def log_state(self, frame: Frame, screen: ScreenState, context: ExecutionContext, screenshot_path: str) -> None:
        with self.state_path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "timestamp": frame.timestamp,
                        "frame_id": frame.frame_id,
                        "machine_state": context.machine_state,
                        "screen_type": screen.screen_type,
                        "confidence": screen.confidence,
                        "raw_ocr": screen.raw_ocr,
                        "package_name": screen.package_name,
                        "activity_name": screen.activity_name,
                        "screenshot_path": screenshot_path,
                        "context": _jsonable(context),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    def log_action(self, frame: Frame, action: Action, screenshot_path: str) -> None:
        with self.actions_path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "timestamp": frame.timestamp,
                        "frame_id": frame.frame_id,
                        "action": _jsonable(action),
                        "screenshot_path": screenshot_path,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    def log_error(self, message: str) -> None:
        with self.errors_path.open("a", encoding="utf-8") as handle:
            handle.write(message.rstrip() + "\n")
