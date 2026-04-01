from __future__ import annotations

import struct
from datetime import datetime

from adb_client import AdbClient
from models import Frame


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def read_png_size(image_bytes: bytes) -> tuple[int, int]:
    if not image_bytes.startswith(PNG_SIGNATURE) or len(image_bytes) < 24:
        raise ValueError("captured image is not a valid PNG")
    width, height = struct.unpack(">II", image_bytes[16:24])
    return int(width), int(height)


def capture_frame(adb_client: AdbClient, frame_index: int) -> Frame:
    image_bytes = adb_client.screencap()
    width, height = read_png_size(image_bytes)
    timestamp = datetime.now().astimezone().isoformat(timespec="milliseconds")
    return Frame(
        frame_id=f"frame-{frame_index:04d}",
        timestamp=timestamp,
        image_bytes=image_bytes,
        width=width,
        height=height,
    )
