# qq-classic-farm

QQ 经典农场相关的视觉模板、场景识别、商店解析、视觉 sidecar 和自动调度都集中在这个子项目里。

当前职责：

- QQ 农场规则配置和场景词表
- Android / iPhone 共用的农场视觉 helper
- OpenCV 模板匹配脚本
- OmniParser / Moondream sidecar 启动脚本
- Android 视觉 controller 原型
- 农场模板资源

常用命令：

```bash
corepack pnpm --dir ./qq-classic-farm vision:omniparser
corepack pnpm --dir ./qq-classic-farm vision:moondream
corepack pnpm --dir ./qq-classic-farm vision:doctor
WEIXIN_CONNECTED_DEVICE_ID=emulator-5554 corepack pnpm --dir ./qq-classic-farm vision:controller -- --phase home
WEIXIN_CONNECTED_DEVICE_ID=emulator-5554 corepack pnpm --dir ./qq-classic-farm vision:controller -- --phase friends
WEIXIN_CONNECTED_DEVICE_ID=emulator-5554 corepack pnpm --dir ./qq-classic-farm record:manual -- --label wechat-search-flow
```

目录说明：

- `vision_automation/` 是新的 Android 端通用视觉自动化 PoC：`ADB screencap/input + OmniParser + Moondream + 状态机 + 回放日志`
- `scripts/run-android-vision-controller.sh` 是 controller 启动入口，会自动选择 `python3.12 -> python3.11 -> python3.10 -> python3`
- `runs/` 会落盘每次视觉 controller 的截图、parser JSON、state/action 流水和错误日志
- `manual-runs/` 会落盘手动演示流程的截图序列、`getevent` 触摸日志和前台 Activity 时间线
- standalone 调试时需要传 `--device-id` 或设置 `WEIXIN_CONNECTED_DEVICE_ID` / `ANDROID_SERIAL`

常用环境变量：

- `WEIXIN_QQ_FARM_ANDROID_VISION_CONTROLLER_MODE=auto`：主项目 Android 偷菜流程里先尝试视觉 controller；`off` 完全关闭，`on` 则要求 controller 成功
- `WEIXIN_QQ_FARM_ANDROID_VISION_CONTROLLER_COMMAND=...`：覆盖默认 controller 启动命令
- `WEIXIN_QQ_FARM_VISION_CONTROLLER_PYTHON=/path/to/python3.11`：指定 controller 使用的 Python
- `WEIXIN_QQ_FARM_VISION_MAX_STEPS=18`：修改单次 controller 最多步数
- `WEIXIN_QQ_FARM_VISION_ACTION_DELAY_MS=900`：修改每次动作后的默认等待
- `WEIXIN_QQ_FARM_VISION_TIMEOUT_MS=5000`：修改 OmniParser / Moondream 请求超时
- `WEIXIN_QQ_FARM_VISION_DRY_RUN=1`：只记录决策和截图，不真正点击
- `WEIXIN_QQ_FARM_VISION_SCRCPY_OBSERVER=1`：运行 controller 时自动拉起 `scrcpy` 观察窗口
- `WEIXIN_QQ_FARM_MANUAL_RECORDER_PYTHON=/path/to/python3.11`：指定手动流程录制器使用的 Python

手动流程录制：

```bash
WEIXIN_CONNECTED_DEVICE_ID=4f2094d1 corepack pnpm --dir ./qq-classic-farm record:manual -- --label wechat-qq-farm
```

录制开始后，你手动在手机上操作一次完整流程；结束时按 `Ctrl-C`。我会基于 `manual-runs/` 里的截图序列、`getevent.log` 和 `timeline.jsonl` 还原你的真实操作路径，再把它转成自动化。

主项目里的 `偷菜` 入口目前仍然会复用这里的模块，但目录、模板和视觉 sidecar 已经从 `RepoTitan` 主逻辑里拆出来了。
