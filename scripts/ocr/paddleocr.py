#!/usr/bin/env python3

import argparse
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path = [
    entry
    for entry in sys.path
    if os.path.abspath(entry or os.getcwd()) != SCRIPT_DIR
]


def to_native(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def build_box_and_center(box, poly):
    if isinstance(box, list) and len(box) == 4:
        left, top, right, bottom = [int(round(float(item))) for item in box]
        center_x = int(round((left + right) / 2))
        center_y = int(round((top + bottom) / 2))
        return [left, top, right, bottom], [center_x, center_y]

    if isinstance(poly, list) and len(poly) > 0:
        flat_points = []
        for point in poly:
            if isinstance(point, list) and len(point) >= 2:
                flat_points.append((float(point[0]), float(point[1])))

        if flat_points:
            left = int(round(min(point[0] for point in flat_points)))
            top = int(round(min(point[1] for point in flat_points)))
            right = int(round(max(point[0] for point in flat_points)))
            bottom = int(round(max(point[1] for point in flat_points)))
            center_x = int(round((left + right) / 2))
            center_y = int(round((top + bottom) / 2))
            return [left, top, right, bottom], [center_x, center_y]

    return None, None


def load_ocr(model_variant):
    try:
        from paddleocr import PaddleOCR
    except Exception as error:
        print(
            f"PaddleOCR import failed: {error}. Install paddlepaddle and paddleocr first.",
            file=sys.stderr,
        )
        sys.exit(2)

    kwargs = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if model_variant == "mobile":
        kwargs["text_detection_model_name"] = "PP-OCRv5_mobile_det"
        kwargs["text_recognition_model_name"] = "PP-OCRv5_mobile_rec"
    return PaddleOCR(**kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--model-variant", default="mobile")
    args = parser.parse_args()

    ocr = load_ocr(args.model_variant)
    result = ocr.predict(args.image)
    blocks = []

    for page in result:
        native_page = to_native(page)
        page_res = None
        if isinstance(native_page, dict):
            page_res = native_page.get("res") if "res" in native_page else native_page
        if not isinstance(page_res, dict):
            continue

        texts = to_native(page_res.get("rec_texts")) or []
        scores = to_native(page_res.get("rec_scores")) or []
        boxes = to_native(page_res.get("rec_boxes")) or []
        polys = to_native(page_res.get("rec_polys")) or []

        item_count = max(len(texts), len(scores), len(boxes), len(polys))
        for index in range(item_count):
            text = texts[index] if index < len(texts) else None
            if not isinstance(text, str) or not text.strip():
                continue

            score = scores[index] if index < len(scores) else None
            box = boxes[index] if index < len(boxes) else None
            poly = polys[index] if index < len(polys) else None
            normalized_box, center = build_box_and_center(to_native(box), to_native(poly))
            if not normalized_box or not center:
                continue

            blocks.append(
                {
                    "text": text,
                    "score": float(score) if isinstance(score, (int, float)) else None,
                    "box": normalized_box,
                    "center": center,
                }
            )

    json.dump({"blocks": blocks}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
