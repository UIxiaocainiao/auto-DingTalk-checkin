#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.append(str(Path(__file__).resolve().parent))

from adb_client import AdbClient
from capture import capture_frame
from config import DEFAULT_RUNS_DIR, load_config
from decision import classify_screen, decide_action
from executor import execute_action
from logger import RunLogger
from models import ControllerSummary, ExecutionContext, ScreenState
from parser_omni import OmniParserClient
from recovery import recovery_action
from state_machine import update_context, all_home_actions_done
from vision_moondream import MoondreamClient


def build_screen_state(
    frame,
    package_name: str,
    activity_name: str,
    elements,
    scene_hint,
    phase: str,
    config,
) -> ScreenState:
    hinted_scene = scene_hint.screen_type if scene_hint else None
    screen_type, confidence, raw_ocr = classify_screen(elements, config, hinted_scene)
    meta = {}
    if scene_hint:
        meta["moondream_scene"] = scene_hint.answer
    return ScreenState(
        screen_type=screen_type,
        elements=elements,
        confidence=confidence,
        raw_ocr=raw_ocr,
        package_name=package_name,
        activity_name=activity_name,
        width=frame.width,
        height=frame.height,
        frame_id=frame.frame_id,
        meta=meta,
    )

def summarize_failure(
    phase: str,
    logger: RunLogger,
    screen_type: str,
    notes: list[str],
    *,
    reason: str,
    unsupported: bool = False,
) -> ControllerSummary:
    return ControllerSummary(
        ok=False,
        phase=phase,
        notes=notes,
        completed_home_one_key_actions=False,
        completed_friend_flow=False,
        final_scene=screen_type,
        run_dir=str(logger.run_dir),
        reason=reason,
        unsupported=unsupported,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device-id")
    parser.add_argument("--phase", choices=("home", "friends"), required=True)
    args = parser.parse_args()

    try:
        config = load_config(args.device_id, args.phase)
    except ValueError as error:
        logger = RunLogger(DEFAULT_RUNS_DIR, args.phase)
        summary = summarize_failure(
            args.phase,
            logger,
            "unknown",
            [str(error)],
            reason="invalid-config",
        )
        print(json.dumps(summary.to_dict(), ensure_ascii=False))
        return

    logger = RunLogger(config.runs_dir, config.phase)
    notes: list[str] = []

    if not config.omniparser_url and not config.moondream_url:
        summary = summarize_failure(
            config.phase,
            logger,
            "unknown",
            ["未配置 OmniParser 或 Moondream，已跳过视觉 controller。"],
            reason="vision-sidecar-unavailable",
            unsupported=True,
        )
        print(json.dumps(summary.to_dict(), ensure_ascii=False))
        return

    adb_client = AdbClient(config.device_id)
    if config.scrcpy_observer:
        try:
            adb_client.ensure_scrcpy_observer()
            notes.append("已启动或复用 scrcpy 观察窗口")
        except Exception as error:  # noqa: BLE001
            notes.append(f"scrcpy 启动失败，已继续纯后台模式: {error}")

    omni = OmniParserClient(config.omniparser_url, config.timeout_ms)
    moondream = MoondreamClient(config.moondream_url, config.timeout_ms, config.moondream_api_key)
    context = ExecutionContext(phase=config.phase)

    final_screen_type = "unknown"
    try:
        for step in range(1, config.max_steps + 1):
            context.step_index = step
            frame = capture_frame(adb_client, step)
            screenshot_path = logger.save_frame(frame)
            package_name, activity_name = adb_client.current_focus()
            omni_result = omni.parse(frame.image_bytes, frame.width, frame.height)
            logger.save_parser_payload(frame.frame_id, omni_result.payload)
            scene_hint = moondream.classify_scene(frame.image_bytes)
            screen = build_screen_state(
                frame,
                package_name,
                activity_name,
                omni_result.elements,
                scene_hint,
                config.phase,
                config,
            )
            final_screen_type = screen.screen_type
            update_context(context, screen, config)
            logger.log_state(frame, screen, context, screenshot_path)

            if config.phase == "home" and all_home_actions_done(context, config) and screen.screen_type == "home":
                notes.append("已通过视觉 controller 完成自家农场一键动作")
                summary = ControllerSummary(
                    ok=True,
                    phase=config.phase,
                    notes=notes,
                    completed_home_one_key_actions=True,
                    completed_friend_flow=False,
                    final_scene=screen.screen_type,
                    run_dir=str(logger.run_dir),
                )
                print(json.dumps(summary.to_dict(), ensure_ascii=False))
                return

            if config.phase == "friends" and context.returned_home:
                notes.append("已通过视觉 controller 完成好友流程并回家")
                summary = ControllerSummary(
                    ok=True,
                    phase=config.phase,
                    notes=notes,
                    completed_home_one_key_actions=False,
                    completed_friend_flow=True,
                    final_scene=screen.screen_type,
                    run_dir=str(logger.run_dir),
                )
                print(json.dumps(summary.to_dict(), ensure_ascii=False))
                return

            action = decide_action(screen, context, config, moondream, frame.image_bytes)
            if action.kind == "abort":
                success = bool(action.meta.get("success"))
                if success:
                    notes.append(action.label)
                    summary = ControllerSummary(
                        ok=True,
                        phase=config.phase,
                        notes=notes,
                        completed_home_one_key_actions=config.phase == "home",
                        completed_friend_flow=config.phase == "friends",
                        final_scene=screen.screen_type,
                        run_dir=str(logger.run_dir),
                    )
                    print(json.dumps(summary.to_dict(), ensure_ascii=False))
                    return

                notes.append(f"{action.label}: {action.meta.get('reason', 'abort')}")
                summary = summarize_failure(
                    config.phase,
                    logger,
                    screen.screen_type,
                    notes,
                    reason=str(action.meta.get("reason", "abort")),
                )
                print(json.dumps(summary.to_dict(), ensure_ascii=False))
                return

            if screen.screen_type == "unknown" and context.stagnation_count >= 2:
                action = recovery_action(screen, context)

            notes.append(action.label)
            logger.log_action(frame, action, screenshot_path)
            execute_action(adb_client, action, config.action_delay_ms, config.dry_run)
    except Exception as error:  # noqa: BLE001
        message = str(error).strip() or error.__class__.__name__
        logger.log_error(message)
        notes.append(f"controller-exception: {message}")
        summary = summarize_failure(
            config.phase,
            logger,
            final_screen_type,
            notes,
            reason="controller-exception",
        )
        print(json.dumps(summary.to_dict(), ensure_ascii=False))
        return

    summary = summarize_failure(
        config.phase,
        logger,
        final_screen_type,
        notes,
        reason="max-steps-exceeded",
    )
    print(json.dumps(summary.to_dict(), ensure_ascii=False))


if __name__ == "__main__":
    main()
