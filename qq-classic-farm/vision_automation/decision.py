from __future__ import annotations

from typing import Iterable, Optional, Sequence, Tuple

from config import VisionAutomationConfig
from models import Action, ExecutionContext, ScreenState, UIElement
from state_machine import all_friend_actions_done, all_home_actions_done
from vision_moondream import MoondreamClient


def _normalize(value: str) -> str:
    return "".join(value.strip().lower().split())


def _contains_keyword(text: str, keywords: Iterable[str]) -> bool:
    normalized_text = _normalize(text)
    return any(_normalize(keyword) in normalized_text for keyword in keywords if keyword.strip())


def _center(element: UIElement) -> Tuple[int, int]:
    left, top, right, bottom = element.bbox
    return ((left + right) // 2, (top + bottom) // 2)


def _raw_text(elements: Sequence[UIElement]) -> str:
    return "\n".join(element.text for element in elements if element.text.strip())


def _match_scene(elements: Sequence[UIElement], groups: Sequence[Sequence[str]]) -> bool:
    if not groups:
        return False
    texts = [element.text for element in elements]
    matched = 0
    for group in groups:
        if any(_contains_keyword(text, group) for text in texts):
            matched += 1
    return matched == len(groups)


def _count_matched_groups(elements: Sequence[UIElement], groups: Sequence[Sequence[str]]) -> tuple[int, bool]:
    if not groups:
        return (0, False)
    texts = [element.text for element in elements]
    matched = 0
    for group in groups:
        if any(_contains_keyword(text, group) for text in texts):
            matched += 1
    return (matched, matched == len(groups))


def _find_element(elements: Sequence[UIElement], keywords: Sequence[str]) -> Optional[UIElement]:
    for element in elements:
        if element.text and _contains_keyword(element.text, keywords):
            return element
    return None


def classify_screen(
    elements: Sequence[UIElement],
    config: VisionAutomationConfig,
    scene_hint: Optional[str],
) -> tuple[str, float, str]:
    raw_ocr = _raw_text(elements)
    if raw_ocr and _contains_keyword(raw_ocr, config.high_risk_keywords):
        return ("high-risk", 1.0, raw_ocr)
    if raw_ocr and _contains_keyword(raw_ocr, config.loading_keywords):
        return ("loading", 0.85, raw_ocr)
    if raw_ocr and _contains_keyword(raw_ocr, config.dialog_keywords):
        return ("dialog", 0.75, raw_ocr)

    scene_groups = config.scene_groups
    scene_priority = {
        "friends": 40,
        "store": 35,
        "friend-farm": 30,
        "home": 10,
    }
    best_scene: Optional[str] = None
    best_score = 0
    for scene, groups in scene_groups.items():
        matched_groups, matched_all = _count_matched_groups(elements, groups)
        if matched_groups == 0:
            continue
        score = matched_groups * 100 + (1000 if matched_all else 0) + int(scene_priority.get(scene, 0))
        if score <= best_score:
            continue
        best_scene = scene
        best_score = score

    if best_scene:
        return (best_scene, 0.92, raw_ocr)

    if scene_hint:
        return (scene_hint, 0.7, raw_ocr)

    return ("unknown", 0.35, raw_ocr)


def _locate_with_moondream(
    moondream: MoondreamClient,
    image_bytes: bytes,
    width: int,
    height: int,
    prompts: Sequence[str],
) -> Optional[tuple[int, int]]:
    for prompt in prompts:
        point = moondream.point(image_bytes, prompt, width, height)
        if point:
            return (point[0], point[1])
    return None


def _tap_element_or_prompt(
    screen: ScreenState,
    keywords: Sequence[str],
    moondream_prompts: Sequence[str],
    moondream: MoondreamClient,
    image_bytes: bytes,
) -> Optional[tuple[int, int]]:
    element = _find_element(screen.elements, keywords)
    if element:
        return _center(element)
    return _locate_with_moondream(moondream, image_bytes, screen.width, screen.height, moondream_prompts)


def decide_action(
    screen: ScreenState,
    context: ExecutionContext,
    config: VisionAutomationConfig,
    moondream: MoondreamClient,
    image_bytes: bytes,
) -> Action:
    if screen.screen_type == "high-risk":
        return Action("abort", "高风险页面", meta={"success": False, "reason": "high-risk"})

    if context.phase == "home" and all_home_actions_done(context, config) and screen.screen_type == "home":
        return Action("abort", "自家农场一键动作完成", meta={"success": True})

    if context.phase == "friends" and context.returned_home:
        return Action("abort", "好友流程完成并已回家", meta={"success": True})

    if screen.screen_type == "dialog":
        target = _tap_element_or_prompt(
            screen,
            config.dialog_keywords,
            ["关闭按钮", "确认按钮", "取消按钮"],
            moondream,
            image_bytes,
        )
        if target:
            return Action("tap", "处理弹窗", target=target)
        return Action("back", "弹窗恢复")

    if screen.screen_type == "loading":
        return Action("wait", "等待加载", meta={"ms": 1000})

    if context.phase == "home":
        if screen.screen_type != "home":
            if screen.screen_type in {"friends", "friend-farm", "store"}:
                return Action("back", f"从 {screen.screen_type} 返回主页")
            return Action("wait", "等待主页稳定", meta={"ms": 800})

        for action in config.home_actions:
            action_id = str(action.get("id") or "")
            if not action_id or action_id in context.home_actions_done:
                continue
            texts = [str(item) for item in action.get("texts", []) if str(item).strip()]
            target = _tap_element_or_prompt(
                screen,
                texts,
                [f"{action.get('note', action_id)}按钮", action.get("note", action_id)],
                moondream,
                image_bytes,
            )
            if not target:
                context.mark_done(action_id)
                continue
            context.mark_done(action_id)
            return Action("tap", f"执行{action.get('note', action_id)}", target=target, meta={"action_id": action_id})

        return Action("abort", "自家农场一键动作完成", meta={"success": True})

    if screen.screen_type == "home":
        target = _tap_element_or_prompt(
            screen,
            config.friend_entry_texts,
            ["好友按钮", "好友入口"],
            moondream,
            image_bytes,
        )
        if target and context.attempt_count("friend-entry") < 3:
            context.bump_attempt("friend-entry")
            return Action("tap", "打开好友列表", target=target)
        return Action("wait", "等待好友入口稳定", meta={"ms": 800})

    if screen.screen_type == "friends":
        target = _tap_element_or_prompt(
            screen,
            [*config.friend_help_texts, *config.friend_visit_texts],
            ["好友求助入口", "拜访按钮", "去帮忙按钮"],
            moondream,
            image_bytes,
        )
        if target and context.attempt_count("visit-friend") < 4:
            context.bump_attempt("visit-friend")
            return Action("tap", "进入好友农场", target=target)
        return Action("back", "好友列表恢复")

    if screen.screen_type == "friend-farm":
        for action in config.friend_actions:
            action_id = str(action.get("id") or "")
            if not action_id or action_id in context.friend_actions_done:
                continue
            texts = [str(item) for item in action.get("texts", []) if str(item).strip()]
            target = _tap_element_or_prompt(
                screen,
                texts,
                [f"{action.get('note', action_id)}按钮", action.get("note", action_id)],
                moondream,
                image_bytes,
            )
            if not target:
                context.mark_done(action_id)
                continue
            context.mark_done(action_id)
            return Action("tap", f"执行{action.get('note', action_id)}", target=target, meta={"action_id": action_id})

        if all_friend_actions_done(context, config):
            target = _tap_element_or_prompt(
                screen,
                config.return_home_texts,
                ["回家按钮", "返回自家农场按钮"],
                moondream,
                image_bytes,
            )
            if target and context.attempt_count("return-home") < 3:
                context.bump_attempt("return-home")
                return Action("tap", "回家", target=target)
        return Action("back", "好友农场恢复")

    if screen.screen_type == "store":
        return Action("back", "从商店或商城返回")

    if context.stagnation_count <= 1:
        return Action("wait", "等待界面稳定", meta={"ms": 1000})
    if context.stagnation_count <= 3:
        return Action("back", "未知页面返回")
    return Action("home", "未知页面回到桌面")
