#!/usr/bin/env python3

import argparse
import base64
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from typing import Any, Dict, Optional, Tuple

from PIL import Image


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 2020
DEFAULT_MODEL_ID = os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_MODEL_ID", "vikhyatk/moondream2")
DEFAULT_MODEL_REVISION = os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_REVISION")
DEFAULT_MAX_OBJECTS = int(os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_MAX_OBJECTS", "24"))


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


class MoondreamContext:
    def __init__(self, model_id: str, revision: Optional[str], should_compile: bool) -> None:
        self.model_id = model_id
        self.revision = revision
        self.should_compile = should_compile
        self.loaded = False
        self.lock = threading.Lock()
        self.model = None
        self.device = "cpu"
        self.dtype_name = "float32"

    def _resolve_device(self, torch: Any) -> str:
        explicit = os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_DEVICE", "").strip().lower()
        if explicit:
            return explicit
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    def _candidate_dtypes(self, torch: Any, device: str) -> list[Tuple[str, Any]]:
        explicit = os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_DTYPE", "").strip()
        if explicit:
            attr = getattr(torch, explicit, None)
            if attr is None:
                raise ValueError(f"unsupported torch dtype: {explicit}")
            return [(explicit, attr)]

        if device == "cpu":
            return [("float32", torch.float32)]

        candidates: list[Tuple[str, Any]] = []
        bfloat16 = getattr(torch, "bfloat16", None)
        float16 = getattr(torch, "float16", None)
        float32 = getattr(torch, "float32", None)
        if bfloat16 is not None:
            candidates.append(("bfloat16", bfloat16))
        if float16 is not None:
            candidates.append(("float16", float16))
        if float32 is not None:
            candidates.append(("float32", float32))
        return candidates

    def load(self) -> None:
        if self.loaded:
            return

        with self.lock:
            if self.loaded:
                return

            import torch
            from transformers import AutoModelForCausalLM

            device = self._resolve_device(torch)
            last_error: Optional[Exception] = None

            for dtype_name, dtype in self._candidate_dtypes(torch, device):
                try:
                    kwargs: Dict[str, Any] = {
                        "trust_remote_code": True,
                        "device_map": device,
                        "dtype": dtype,
                    }
                    if self.revision:
                        kwargs["revision"] = self.revision
                    try:
                        model = AutoModelForCausalLM.from_pretrained(self.model_id, **kwargs)
                    except TypeError:
                        kwargs.pop("dtype")
                        kwargs["torch_dtype"] = dtype
                        model = AutoModelForCausalLM.from_pretrained(self.model_id, **kwargs)

                    if self.should_compile and hasattr(model, "compile"):
                        try:
                            model.compile()
                        except Exception:
                            pass

                    self.model = model
                    self.device = device
                    self.dtype_name = dtype_name
                    self.loaded = True
                    return
                except Exception as error:  # noqa: BLE001
                    last_error = error

            raise RuntimeError(
                f"failed to load {self.model_id} on {device}: {last_error if last_error else 'unknown error'}",
            )

    def health(self) -> Dict[str, Any]:
        return {
            "status": "ok",
            "loaded": self.loaded,
            "model": self.model_id,
            "revision": self.revision,
            "device": self.device,
            "dtype": self.dtype_name,
        }

    def _run_model(self, fn_name: str, image: Image.Image, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        self.load()
        if self.model is None:
            raise RuntimeError("Moondream model failed to initialize")
        with self.lock:
            fn = getattr(self.model, fn_name)
            result = fn(image, *args, **kwargs)
        if isinstance(result, dict):
            return result
        raise RuntimeError(f"unexpected result from moondream {fn_name}: {type(result).__name__}")

    def point(self, image: Image.Image, target: str, settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._run_model("point", image, target, settings=settings or {"max_objects": DEFAULT_MAX_OBJECTS})

    def detect(self, image: Image.Image, target: str, settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._run_model("detect", image, target, settings=settings or {"max_objects": DEFAULT_MAX_OBJECTS})

    def query(
        self,
        image: Image.Image,
        question: str,
        reasoning: bool = False,
        settings: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._run_model("query", image, question, settings=settings or {}, reasoning=reasoning)


def create_handler(context: MoondreamContext):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path.rstrip("/") in ("/health", "/v1/health"):
                json_response(self, 200, context.health())
                return
            json_response(self, 404, {"error": "not_found"})

        def do_POST(self) -> None:
            path = self.path.rstrip("/")
            if path not in ("/point", "/v1/point", "/detect", "/v1/detect", "/query", "/v1/query"):
                json_response(self, 404, {"error": "not_found"})
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                payload = json.loads(raw_body.decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("payload must be a JSON object")

                image = decode_image_from_payload(payload)
                settings = payload.get("settings")
                if settings is not None and not isinstance(settings, dict):
                    raise ValueError("settings must be a JSON object")

                if path in ("/point", "/v1/point"):
                    target = payload.get("object")
                    if not isinstance(target, str) or not target.strip():
                        raise ValueError("payload.object must be a non-empty string")
                    result = context.point(image, target.strip(), settings)
                elif path in ("/detect", "/v1/detect"):
                    target = payload.get("object")
                    if not isinstance(target, str) or not target.strip():
                        raise ValueError("payload.object must be a non-empty string")
                    result = context.detect(image, target.strip(), settings)
                else:
                    question = payload.get("question")
                    if not isinstance(question, str) or not question.strip():
                        raise ValueError("payload.question must be a non-empty string")
                    result = context.query(
                        image,
                        question.strip(),
                        bool(payload.get("reasoning", False)),
                        settings,
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
            sys.stderr.write("[moondream-bridge] " + (fmt % args) + "\n")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_PORT", str(DEFAULT_PORT))))
    parser.add_argument("--model", default=DEFAULT_MODEL_ID)
    parser.add_argument("--revision", default=DEFAULT_MODEL_REVISION)
    parser.add_argument("--preload", action="store_true")
    parser.add_argument("--compile", action="store_true")
    args = parser.parse_args()

    context = MoondreamContext(args.model, args.revision, args.compile)
    if args.preload:
        print(f"[moondream-bridge] preloading model={args.model} revision={args.revision or 'default'}", flush=True)
        context.load()

    server = ThreadingHTTPServer((args.host, args.port), create_handler(context))
    print(
        f"[moondream-bridge] listening on http://{args.host}:{args.port}/v1 "
        f"model={args.model} loaded={context.loaded} device={context.device} dtype={context.dtype_name}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
