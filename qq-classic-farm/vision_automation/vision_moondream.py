from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


def _normalize_scene(value: str) -> str:
    normalized = "".join(value.strip().lower().split())
    if not normalized:
        return "unknown"
    mapping = {
        "home": "home",
        "friends": "friends",
        "friend-farm": "friend-farm",
        "friendfarm": "friend-farm",
        "store": "store",
        "dialog": "dialog",
        "loading": "loading",
        "unknown": "unknown",
    }
    if normalized in mapping:
        return mapping[normalized]
    if "friendfarm" in normalized or "好友农场" in value:
        return "friend-farm"
    if "friends" in normalized or "好友列表" in value:
        return "friends"
    if "store" in normalized or "商店" in value or "商城" in value or "仓库" in value:
        return "store"
    if "dialog" in normalized or "弹窗" in value:
        return "dialog"
    if "loading" in normalized or "加载" in value:
        return "loading"
    if "home" in normalized or "自家农场" in value:
        return "home"
    return "unknown"


@dataclass
class SceneHint:
    screen_type: str
    confidence: float
    answer: str


class MoondreamClient:
    def __init__(self, base_url: Optional[str], timeout_ms: int, api_key: Optional[str]) -> None:
        self.base_url = base_url.rstrip("/") if base_url else None
        self.timeout_seconds = max(timeout_ms, 1000) / 1000.0
        self.api_key = api_key

    def _post_json(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.base_url:
            return {}

        request = urllib.request.Request(
            f"{self.base_url}/{path.lstrip('/')}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                **({"X-Moondream-Auth": self.api_key} if self.api_key else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            return {}

    def classify_scene(self, image_bytes: bytes) -> Optional[SceneHint]:
        if not self.base_url:
            return None

        payload = self._post_json(
            "query",
            {
                "imageBase64": base64.b64encode(image_bytes).decode("ascii"),
                "question": (
                    "Classify this Android QQ farm screenshot. "
                    "Return exactly one token: home, friends, friend-farm, store, dialog, loading, unknown."
                ),
            },
        )
        answer = payload.get("answer") or payload.get("result") or ""
        if not isinstance(answer, str):
            return None
        scene = _normalize_scene(answer)
        if scene == "unknown":
            return None
        return SceneHint(screen_type=scene, confidence=0.7, answer=answer.strip())

    def point(self, image_bytes: bytes, prompt: str, width: int, height: int) -> Optional[Tuple[int, int, float]]:
        if not self.base_url:
            return None

        payload = self._post_json(
            "point",
            {
                "imageBase64": base64.b64encode(image_bytes).decode("ascii"),
                "object": prompt,
            },
        )
        points = payload.get("points")
        if not isinstance(points, list) or not points:
            return None
        first = points[0]
        if not isinstance(first, dict):
            return None
        raw_x = first.get("x")
        raw_y = first.get("y")
        if not isinstance(raw_x, (int, float)) or not isinstance(raw_y, (int, float)):
            return None
        x = round(raw_x * width) if 0 <= raw_x <= 1.01 else round(raw_x)
        y = round(raw_y * height) if 0 <= raw_y <= 1.01 else round(raw_y)
        return (x, y, 1.0)
