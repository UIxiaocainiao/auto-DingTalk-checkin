from __future__ import annotations

from models import Action, ExecutionContext, ScreenState


def recovery_action(screen: ScreenState, context: ExecutionContext) -> Action:
    if screen.screen_type == "loading":
        return Action("wait", "恢复等待加载", meta={"ms": 1200})
    if context.stagnation_count <= 1:
        return Action("wait", "恢复等待", meta={"ms": 1000})
    if context.stagnation_count <= 3:
        return Action("back", "恢复返回")
    return Action("home", "恢复回桌面")
