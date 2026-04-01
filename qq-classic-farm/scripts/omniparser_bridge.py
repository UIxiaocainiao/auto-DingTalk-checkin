#!/usr/bin/env python3

import argparse
import base64
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image


DEFAULT_PORT = 7861
DEFAULT_HOST = "127.0.0.1"
DEFAULT_BOX_THRESHOLD = float(os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_BOX_THRESHOLD", "0.05"))
DEFAULT_IOU_THRESHOLD = float(os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_IOU_THRESHOLD", "0.1"))
DEFAULT_IMGSZ = int(os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_IMGSZ", "640"))


class OmniParserContext:
    def __init__(self, repo_dir: Path) -> None:
        self.repo_dir = repo_dir
        self.loaded = False
        self.yolo_model = None
        self.caption_model_processor = None
        self.check_ocr_box = None
        self.get_som_labeled_img = None

    def load(self) -> None:
        if self.loaded:
            return

        if not self.repo_dir.exists():
            raise FileNotFoundError(f"OmniParser repo not found: {self.repo_dir}")

        if str(self.repo_dir) not in sys.path:
            sys.path.insert(0, str(self.repo_dir))

        os.chdir(self.repo_dir)

        from util.utils import (  # type: ignore
            check_ocr_box,
            get_caption_model_processor,
            get_som_labeled_img,
            get_yolo_model,
        )

        weights_dir = self.repo_dir / "weights"
        icon_detect_model = weights_dir / "icon_detect" / "model.pt"
        icon_caption_dir = weights_dir / "icon_caption_florence"
        if not icon_detect_model.exists():
            raise FileNotFoundError(f"OmniParser icon detect weights missing: {icon_detect_model}")
        if not icon_caption_dir.exists():
            raise FileNotFoundError(f"OmniParser caption weights missing: {icon_caption_dir}")

        self.yolo_model = get_yolo_model(model_path=str(icon_detect_model))
        self.caption_model_processor = get_caption_model_processor(
            model_name="florence2",
            model_name_or_path=str(icon_caption_dir),
        )
        self.check_ocr_box = check_ocr_box
        self.get_som_labeled_img = get_som_labeled_img
        self.loaded = True

    def parse(
        self,
        image: Image.Image,
        box_threshold: float,
        iou_threshold: float,
        use_paddleocr: bool,
        imgsz: int,
        output_coord_in_ratio: bool,
    ) -> Dict[str, Any]:
        self.load()

        assert self.check_ocr_box is not None
        assert self.get_som_labeled_img is not None

        ocr_bbox_rslt, _ = self.check_ocr_box(
            image,
            display_img=False,
            output_bb_format="xyxy",
            goal_filtering=None,
            easyocr_args={"paragraph": False, "text_threshold": 0.9},
            use_paddleocr=use_paddleocr,
        )
        ocr_text, ocr_bbox = ocr_bbox_rslt

        _, label_coordinates, filtered_boxes_elem = self.get_som_labeled_img(
            image,
            self.yolo_model,
            BOX_TRESHOLD=box_threshold,
            output_coord_in_ratio=output_coord_in_ratio,
            ocr_bbox=ocr_bbox,
            caption_model_processor=self.caption_model_processor,
            ocr_text=ocr_text,
            iou_threshold=iou_threshold,
            imgsz=imgsz,
        )

        elements: List[Dict[str, Any]] = []
        for index, item in enumerate(filtered_boxes_elem):
            bbox = item.get("bbox")
            if not isinstance(bbox, list) or len(bbox) != 4:
                continue
            content = item.get("content")
            label = content if isinstance(content, str) and content.strip() else str(item.get("type") or f"element_{index}")
            elements.append(
                {
                    "id": index,
                    "label": label.strip(),
                    "bbox": bbox,
                    "type": item.get("type"),
                    "interactivity": bool(item.get("interactivity")),
                    "source": item.get("source"),
                }
            )

        return {
            "elements": elements,
            "labelCoordinates": label_coordinates,
            "imageWidth": image.width,
            "imageHeight": image.height,
            "outputCoordInRatio": output_coord_in_ratio,
        }


def decode_image_from_payload(payload: Dict[str, Any]) -> Image.Image:
    image_url = payload.get("image_url")
    image_base64 = payload.get("imageBase64")
    raw_bytes: Optional[bytes] = None

    if isinstance(image_url, str) and image_url.startswith("data:image/"):
      _, encoded = image_url.split(",", 1)
      raw_bytes = base64.b64decode(encoded)
    elif isinstance(image_base64, str) and image_base64.strip():
      raw_bytes = base64.b64decode(image_base64)

    if raw_bytes is None:
      raise ValueError("payload must include image_url as data URL or imageBase64")

    return Image.open(BytesIO(raw_bytes)).convert("RGB")


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def create_handler(context: OmniParserContext):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path.rstrip("/") == "/health":
                json_response(self, 200, {"status": "ok", "loaded": context.loaded})
                return
            json_response(self, 404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path.rstrip("/") != "/parse":
                json_response(self, 404, {"error": "not_found"})
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                payload = json.loads(raw_body.decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("payload must be a JSON object")

                image = decode_image_from_payload(payload)
                result = context.parse(
                    image=image,
                    box_threshold=float(payload.get("boxThreshold", DEFAULT_BOX_THRESHOLD)),
                    iou_threshold=float(payload.get("iouThreshold", DEFAULT_IOU_THRESHOLD)),
                    use_paddleocr=bool(payload.get("usePaddleOCR", True)),
                    imgsz=int(payload.get("imgsz", DEFAULT_IMGSZ)),
                    output_coord_in_ratio=bool(payload.get("outputCoordInRatio", True)),
                )
                json_response(self, 200, result)
            except Exception as error:  # noqa: BLE001
                json_response(
                    self,
                    500,
                    {
                        "error": str(error),
                        "traceback": traceback.format_exc(),
                    },
                )

        def log_message(self, fmt: str, *args: Tuple[Any, ...]) -> None:
            sys.stderr.write("[omniparser-bridge] " + (fmt % args) + "\n")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_REPO"))
    parser.add_argument("--host", default=os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_PORT", str(DEFAULT_PORT))))
    args = parser.parse_args()

    if not args.repo:
        raise SystemExit("Missing OmniParser repo path. Set --repo or WEIXIN_QQ_FARM_OMNIPARSER_REPO.")

    context = OmniParserContext(Path(args.repo).expanduser().resolve())
    server = ThreadingHTTPServer((args.host, args.port), create_handler(context))
    print(f"[omniparser-bridge] listening on http://{args.host}:{args.port}/parse repo={context.repo_dir}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
