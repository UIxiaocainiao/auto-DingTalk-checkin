from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional


ROOT_DIR = Path(__file__).resolve().parent.parent
SPEC_PATH = ROOT_DIR / "src" / "qq-farm-spec.json"
DEFAULT_RUNS_DIR = ROOT_DIR / "runs"


def _read_spec() -> Dict[str, Any]:
    return json.loads(SPEC_PATH.read_text("utf-8"))


def _parse_bool(raw: Optional[str], default: bool) -> bool:
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "on", "yes"}:
        return True
    if normalized in {"0", "false", "off", "no"}:
        return False
    return default


def _parse_int(raw: Optional[str], default: int) -> int:
    try:
        value = int(raw or "")
    except ValueError:
        return default
    return value if value > 0 else default


def _resolve_omniparser_url() -> Optional[str]:
    explicit = os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_URL", "").strip()
    if explicit:
        return explicit
    if _parse_bool(os.environ.get("WEIXIN_QQ_FARM_OMNIPARSER_ENABLE"), False):
        return "http://127.0.0.1:7861/parse"
    return None


def _resolve_moondream_url() -> Optional[str]:
    explicit = os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    if _parse_bool(os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_ENABLE"), False):
        return "http://127.0.0.1:2020/v1"
    return None


@dataclass
class VisionAutomationConfig:
    device_id: str
    phase: Literal["home", "friends"]
    runs_dir: Path = DEFAULT_RUNS_DIR
    max_steps: int = 18
    action_delay_ms: int = 900
    timeout_ms: int = 5000
    scrcpy_observer: bool = False
    dry_run: bool = False
    package_name: str = "com.tencent.mm"
    omniparser_url: Optional[str] = None
    moondream_url: Optional[str] = None
    moondream_api_key: Optional[str] = None
    home_actions: List[Dict[str, Any]] = field(default_factory=list)
    friend_actions: List[Dict[str, Any]] = field(default_factory=list)
    friend_entry_texts: List[str] = field(default_factory=list)
    friend_visit_texts: List[str] = field(default_factory=list)
    friend_help_texts: List[str] = field(default_factory=list)
    return_home_texts: List[str] = field(default_factory=list)
    scene_groups: Dict[str, List[List[str]]] = field(default_factory=dict)
    high_risk_keywords: List[str] = field(default_factory=list)
    dialog_keywords: List[str] = field(default_factory=list)
    loading_keywords: List[str] = field(default_factory=list)


def load_config(device_id: Optional[str], phase: Literal["home", "friends"]) -> VisionAutomationConfig:
    spec = _read_spec()
    resolved_device_id = (device_id or os.environ.get("WEIXIN_CONNECTED_DEVICE_ID") or os.environ.get("ANDROID_SERIAL") or "").strip()
    if not resolved_device_id:
        raise ValueError("missing device id; pass --device-id or set WEIXIN_CONNECTED_DEVICE_ID")

    return VisionAutomationConfig(
        device_id=resolved_device_id,
        phase=phase,
        runs_dir=Path(os.environ.get("WEIXIN_QQ_FARM_VISION_RUNS_DIR", DEFAULT_RUNS_DIR)).expanduser().resolve(),
        max_steps=_parse_int(os.environ.get("WEIXIN_QQ_FARM_VISION_MAX_STEPS"), 12 if phase == "home" else 18),
        action_delay_ms=_parse_int(os.environ.get("WEIXIN_QQ_FARM_VISION_ACTION_DELAY_MS"), 900),
        timeout_ms=_parse_int(os.environ.get("WEIXIN_QQ_FARM_VISION_TIMEOUT_MS"), 5000),
        scrcpy_observer=_parse_bool(os.environ.get("WEIXIN_QQ_FARM_VISION_SCRCPY_OBSERVER"), False),
        dry_run=_parse_bool(os.environ.get("WEIXIN_QQ_FARM_VISION_DRY_RUN"), False),
        omniparser_url=_resolve_omniparser_url(),
        moondream_url=_resolve_moondream_url(),
        moondream_api_key=os.environ.get("WEIXIN_QQ_FARM_MOONDREAM_API_KEY", "").strip() or None,
        home_actions=list(spec.get("actions", {}).get("homeOneKeyActions", [])),
        friend_actions=list(spec.get("actions", {}).get("friendOneKeyActions", [])),
        friend_entry_texts=list(spec.get("actions", {}).get("friendEntryTexts", [])),
        friend_visit_texts=list(spec.get("actions", {}).get("friendVisitTexts", [])),
        friend_help_texts=list(spec.get("actions", {}).get("friendHelpTexts", [])),
        return_home_texts=list(spec.get("actions", {}).get("returnHomeTexts", [])),
        scene_groups={key: value.get("groups", []) for key, value in spec.get("scenes", {}).items()},
        high_risk_keywords=[
            "登录",
            "支付",
            "付款",
            "实名",
            "授权",
            "隐私",
            "分享",
            "发送",
            "联系人",
            "密码",
            "验证码",
            "银行卡",
        ],
        dialog_keywords=["关闭", "取消", "确认", "确定", "知道了", "我知道了", "稍后再说", "允许"],
        loading_keywords=["加载", "正在打开", "请稍候", "请稍等"],
    )
