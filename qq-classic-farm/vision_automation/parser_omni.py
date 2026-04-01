from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from models import UIElement


@dataclass
class OmniParseResult:
    elements: List[UIElement]
    payload: Dict[str, Any]


def _extract_text(record: Dict[str, Any]) -> str:
    for key in ("label", "text", "name", "content", "description"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _extract_bbox(record: Dict[str, Any], width: int, height: int) -> Optional[tuple[int, int, int, int]]:
    raw = record.get("bbox") or record.get("box") or record.get("rect")
    if not isinstance(raw, list) or len(raw) != 4:
        return None
    values: List[float] = []
    for item in raw:
        if not isinstance(item, (int, float)):
            return None
        values.append(float(item))
    normalized = max(abs(value) for value in values) <= 1.01
    left, top, right, bottom = values
    if normalized:
        left *= width
        right *= width
        top *= height
        bottom *= height
    return (round(left), round(top), round(right), round(bottom))


class OmniParserClient:
    def __init__(self, endpoint: Optional[str], timeout_ms: int) -> None:
        self.endpoint = endpoint
        self.timeout_seconds = max(timeout_ms, 1000) / 1000.0

    def parse(self, image_bytes: bytes, width: int, height: int) -> OmniParseResult:
        if not self.endpoint:
            return OmniParseResult(elements=[], payload={})

        payload = {
            "imageBase64": base64.b64encode(image_bytes).decode("ascii"),
            "image_url": f"data:image/png;base64,{base64.b64encode(image_bytes).decode('ascii')}",
            "outputCoordInRatio": True,
            "usePaddleOCR": True,
        }
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                parsed = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            return OmniParseResult(elements=[], payload={})

        elements: List[UIElement] = []
        for item in parsed.get("elements", []):
            if not isinstance(item, dict):
                continue
            text = _extract_text(item)
            bbox = _extract_bbox(item, width, height)
            if not text or not bbox:
                continue
            score = float(item.get("score", 0.5) or 0.5)
            elements.append(
                UIElement(
                    type=str(item.get("type") or "element"),
                    text=text,
                    bbox=bbox,
                    score=score,
                    meta=item,
                )
            )
        return OmniParseResult(elements=elements, payload=parsed)
