#!/usr/bin/env python3

import argparse
import json
import math
import os
from dataclasses import dataclass
from typing import Any, Optional, Tuple

import cv2
import numpy as np

DEFAULT_SCALES = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3]


@dataclass
class TemplateMatch:
    template_name: str
    score: float
    left: int
    top: int
    width: int
    height: int
    center_x: int
    center_y: int
    scale: float


def load_image(path: str, flags: int = cv2.IMREAD_UNCHANGED) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        raise ValueError(f"unable to read image bytes: {path}")
    image = cv2.imdecode(data, flags)
    if image is None:
        raise ValueError(f"unable to decode image: {path}")
    return image


def to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def load_template(path: str) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    image = load_image(path, cv2.IMREAD_UNCHANGED)
    mask = None
    if image.ndim == 3 and image.shape[2] == 4:
        mask = image[:, :, 3]
        image = image[:, :, :3]
    return image, mask


def clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def ratio_to_range(total: int, template_size: int, min_ratio: Optional[float], max_ratio: Optional[float]) -> Optional[Tuple[int, int]]:
    minimum = clamp(int(round(total * (min_ratio if min_ratio is not None else 0))), 0, max(0, total - template_size))
    max_edge = clamp(int(round(total * (max_ratio if max_ratio is not None else 1))), 0, total)
    maximum = clamp(max_edge - template_size, 0, max(0, total - template_size))
    if maximum < minimum:
        return None
    return minimum, maximum


def safe_score(value: float) -> bool:
    return value == value and not math.isinf(value) and 0 <= value <= 1.0


def build_match(
    template_path: str,
    left: int,
    top: int,
    width: int,
    height: int,
    score: float,
    scale: float,
) -> TemplateMatch:
    return TemplateMatch(
        template_name=os.path.basename(template_path),
        score=float(score),
        left=left,
        top=top,
        width=width,
        height=height,
        center_x=left + width // 2,
        center_y=top + height // 2,
        scale=scale,
    )


def intersection_over_union(left: TemplateMatch, right: TemplateMatch) -> float:
    left_x1 = left.left
    left_y1 = left.top
    left_x2 = left.left + left.width
    left_y2 = left.top + left.height
    right_x1 = right.left
    right_y1 = right.top
    right_x2 = right.left + right.width
    right_y2 = right.top + right.height

    inter_x1 = max(left_x1, right_x1)
    inter_y1 = max(left_y1, right_y1)
    inter_x2 = min(left_x2, right_x2)
    inter_y2 = min(left_y2, right_y2)
    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    if inter_w == 0 or inter_h == 0:
        return 0.0

    intersection = inter_w * inter_h
    left_area = left.width * left.height
    right_area = right.width * right.height
    union = left_area + right_area - intersection
    if union <= 0:
        return 0.0
    return intersection / union


def apply_non_max_suppression(matches: list[TemplateMatch], max_matches: int, iou_threshold: float = 0.35) -> list[TemplateMatch]:
    kept: list[TemplateMatch] = []
    for match in sorted(matches, key=lambda current: current.score, reverse=True):
        if all(intersection_over_union(match, current) < iou_threshold for current in kept):
            kept.append(match)
            if len(kept) >= max_matches:
                break
    return kept


def match_template_best(
    screen_gray: np.ndarray,
    template_path: str,
    scales: list[float],
    min_x_ratio: Optional[float],
    max_x_ratio: Optional[float],
    min_y_ratio: Optional[float],
    max_y_ratio: Optional[float],
) -> Optional[TemplateMatch]:
    template_color, template_mask = load_template(template_path)
    template_gray = to_gray(template_color)
    template_h, template_w = template_gray.shape[:2]
    screen_h, screen_w = screen_gray.shape[:2]

    best: Optional[TemplateMatch] = None
    for scale in scales:
        scaled_w = max(8, int(round(template_w * scale)))
        scaled_h = max(8, int(round(template_h * scale)))
        if scaled_w >= screen_w or scaled_h >= screen_h:
            continue

        scaled_template = cv2.resize(template_gray, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
        scaled_mask = None
        if template_mask is not None:
            scaled_mask = cv2.resize(template_mask, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)

        x_range = ratio_to_range(screen_w, scaled_w, min_x_ratio, max_x_ratio)
        y_range = ratio_to_range(screen_h, scaled_h, min_y_ratio, max_y_ratio)
        if not x_range or not y_range:
            continue

        min_x, max_x = x_range
        min_y, max_y = y_range
        roi = screen_gray[min_y : max_y + scaled_h, min_x : max_x + scaled_w]
        if roi.shape[0] < scaled_h or roi.shape[1] < scaled_w:
            continue

        if scaled_mask is not None:
            result = cv2.matchTemplate(roi, scaled_template, cv2.TM_CCOEFF_NORMED, mask=scaled_mask)
        else:
            result = cv2.matchTemplate(roi, scaled_template, cv2.TM_CCOEFF_NORMED)

        _, max_val, _, max_loc = cv2.minMaxLoc(result)
        if not safe_score(max_val):
            continue

        left = min_x + int(max_loc[0])
        top = min_y + int(max_loc[1])
        current = build_match(
            template_path=template_path,
            left=left,
            top=top,
            width=scaled_w,
            height=scaled_h,
            score=float(max_val),
            scale=scaled_w / template_w,
        )
        if best is None or current.score > best.score:
            best = current

    return best


def match_template_candidates(
    screen_gray: np.ndarray,
    template_path: str,
    scales: list[float],
    min_x_ratio: Optional[float],
    max_x_ratio: Optional[float],
    min_y_ratio: Optional[float],
    max_y_ratio: Optional[float],
    min_score: float,
    max_matches: int,
) -> list[TemplateMatch]:
    template_color, template_mask = load_template(template_path)
    template_gray = to_gray(template_color)
    template_h, template_w = template_gray.shape[:2]
    screen_h, screen_w = screen_gray.shape[:2]
    collected: list[TemplateMatch] = []

    for scale in scales:
        scaled_w = max(8, int(round(template_w * scale)))
        scaled_h = max(8, int(round(template_h * scale)))
        if scaled_w >= screen_w or scaled_h >= screen_h:
            continue

        scaled_template = cv2.resize(template_gray, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
        scaled_mask = None
        if template_mask is not None:
            scaled_mask = cv2.resize(template_mask, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)

        x_range = ratio_to_range(screen_w, scaled_w, min_x_ratio, max_x_ratio)
        y_range = ratio_to_range(screen_h, scaled_h, min_y_ratio, max_y_ratio)
        if not x_range or not y_range:
            continue

        min_x, max_x = x_range
        min_y, max_y = y_range
        roi = screen_gray[min_y : max_y + scaled_h, min_x : max_x + scaled_w]
        if roi.shape[0] < scaled_h or roi.shape[1] < scaled_w:
            continue

        if scaled_mask is not None:
            result = cv2.matchTemplate(roi, scaled_template, cv2.TM_CCOEFF_NORMED, mask=scaled_mask)
        else:
            result = cv2.matchTemplate(roi, scaled_template, cv2.TM_CCOEFF_NORMED)

        if result.size == 0:
            continue

        points = np.argwhere(result >= min_score)
        for point_y, point_x in points.tolist():
            score = float(result[point_y, point_x])
            if not safe_score(score):
                continue
            collected.append(
                build_match(
                    template_path=template_path,
                    left=min_x + int(point_x),
                    top=min_y + int(point_y),
                    width=scaled_w,
                    height=scaled_h,
                    score=score,
                    scale=scaled_w / template_w,
                )
            )

    if not collected:
        return []

    return apply_non_max_suppression(collected, max_matches=max_matches)


def serialize_match(match: TemplateMatch) -> dict[str, Any]:
    return {
        "templateName": match.template_name,
        "score": match.score,
        "left": match.left,
        "top": match.top,
        "width": match.width,
        "height": match.height,
        "centerX": match.center_x,
        "centerY": match.center_y,
        "scale": match.scale,
    }


def normalize_template_name(name: str) -> str:
    return name if name.endswith(".png") else f"{name}.png"


def run_query(screen_gray: np.ndarray, templates_dir: str, query: dict[str, Any]) -> dict[str, Any]:
    scales = [float(value) for value in query.get("scales") or DEFAULT_SCALES if float(value) > 0]
    min_score = float(query.get("minScore") or 0.74)
    max_matches = max(1, int(query.get("maxMatches") or 1))
    best: Optional[TemplateMatch] = None
    collected: list[TemplateMatch] = []

    for template_name in query.get("templates", []):
        template_path = os.path.join(templates_dir, normalize_template_name(str(template_name)))
        if not os.path.exists(template_path):
            continue

        if max_matches <= 1:
            match = match_template_best(
                screen_gray=screen_gray,
                template_path=template_path,
                scales=scales,
                min_x_ratio=query.get("minXRatio"),
                max_x_ratio=query.get("maxXRatio"),
                min_y_ratio=query.get("minYRatio"),
                max_y_ratio=query.get("maxYRatio"),
            )
            if match is None:
                continue
            if best is None or match.score > best.score:
                best = match
            continue

        collected.extend(
            match_template_candidates(
                screen_gray=screen_gray,
                template_path=template_path,
                scales=scales,
                min_x_ratio=query.get("minXRatio"),
                max_x_ratio=query.get("maxXRatio"),
                min_y_ratio=query.get("minYRatio"),
                max_y_ratio=query.get("maxYRatio"),
                min_score=min_score,
                max_matches=max_matches * 4,
            )
        )

    matches = []
    if max_matches > 1:
        matches = apply_non_max_suppression(collected, max_matches=max_matches)
        best = matches[0] if matches else None

    if best is None or best.score < min_score:
        return {"id": query["id"], "match": None, "matches": []}

    return {
        "id": query["id"],
        "match": serialize_match(best),
        "matches": [serialize_match(match) for match in matches] if max_matches > 1 else [serialize_match(best)],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--query-json", required=True)
    args = parser.parse_args()

    payload = json.loads(args.query_json)
    screen = load_image(args.image, cv2.IMREAD_COLOR)
    screen_gray = to_gray(screen)
    templates_dir = payload["templatesDir"]
    queries = payload.get("queries", [])

    results = [run_query(screen_gray, templates_dir, query) for query in queries]
    print(json.dumps({"results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
