from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Literal, Optional, Tuple


BBox = Tuple[int, int, int, int]
Point = Tuple[int, int]
ActionKind = Literal["tap", "swipe", "back", "home", "wait", "abort"]


@dataclass
class UIElement:
    type: str
    text: str
    bbox: BBox
    score: float
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ScreenState:
    screen_type: str
    elements: List[UIElement]
    confidence: float
    raw_ocr: str
    package_name: str
    activity_name: str
    width: int
    height: int
    frame_id: str
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Action:
    kind: ActionKind
    label: str
    target: Optional[Point] = None
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Frame:
    frame_id: str
    timestamp: str
    image_bytes: bytes
    width: int
    height: int


@dataclass
class ExecutionContext:
    phase: Literal["home", "friends"]
    machine_state: str = "BOOT"
    home_actions_done: List[str] = field(default_factory=list)
    friend_actions_done: List[str] = field(default_factory=list)
    attempts: Dict[str, int] = field(default_factory=dict)
    friend_list_seen: bool = False
    friend_farm_seen: bool = False
    returned_home: bool = False
    stagnation_count: int = 0
    last_fingerprint: str = ""
    step_index: int = 0

    def mark_done(self, action_id: str) -> None:
        target = self.home_actions_done if self.phase == "home" else self.friend_actions_done
        if action_id not in target:
            target.append(action_id)

    def done_ids(self) -> List[str]:
        return self.home_actions_done if self.phase == "home" else self.friend_actions_done

    def bump_attempt(self, key: str) -> int:
        value = self.attempts.get(key, 0) + 1
        self.attempts[key] = value
        return value

    def attempt_count(self, key: str) -> int:
        return self.attempts.get(key, 0)


@dataclass
class ControllerSummary:
    ok: bool
    phase: Literal["home", "friends"]
    notes: List[str]
    completed_home_one_key_actions: bool
    completed_friend_flow: bool
    final_scene: str
    run_dir: str
    reason: Optional[str] = None
    unsupported: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
