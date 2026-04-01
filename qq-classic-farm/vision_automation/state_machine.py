from __future__ import annotations

from config import VisionAutomationConfig
from models import ExecutionContext, ScreenState


def all_home_actions_done(context: ExecutionContext, config: VisionAutomationConfig) -> bool:
    target = [str(item.get("id")) for item in config.home_actions if item.get("id")]
    return all(action_id in context.home_actions_done for action_id in target)


def all_friend_actions_done(context: ExecutionContext, config: VisionAutomationConfig) -> bool:
    target = [str(item.get("id")) for item in config.friend_actions if item.get("id")]
    return all(action_id in context.friend_actions_done for action_id in target)


def update_context(context: ExecutionContext, screen: ScreenState, config: VisionAutomationConfig) -> None:
    fingerprint = f"{screen.screen_type}|{screen.package_name}|{screen.raw_ocr}"
    if fingerprint == context.last_fingerprint:
        context.stagnation_count += 1
    else:
        context.stagnation_count = 0
        context.last_fingerprint = fingerprint

    if context.phase == "friends":
        if screen.screen_type == "friends":
            context.friend_list_seen = True
        elif screen.screen_type == "friend-farm":
            context.friend_list_seen = True
            context.friend_farm_seen = True
        elif screen.screen_type == "home" and context.friend_farm_seen and all_friend_actions_done(context, config):
            context.returned_home = True

    if context.phase == "home" and screen.screen_type == "home" and all_home_actions_done(context, config):
        context.machine_state = "IDLE"
        return

    if context.phase == "friends" and context.returned_home:
        context.machine_state = "IDLE"
        return

    if screen.screen_type == "loading":
        context.machine_state = "RESULT_VERIFY"
    elif screen.screen_type == "dialog":
        context.machine_state = "RECOVERY"
    else:
        context.machine_state = "TASK_DISCOVERY"
