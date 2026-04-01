# dingtalk-clock-in

钉钉打卡相关的配置和自动调度集中在这个子目录里。

当前包含：

- 打卡时间窗配置
- 自动打卡调度逻辑

主项目里的 `打卡` 命令和设备执行器仍然在 `packages/agent-acp` 与 `scripts/ios/run-action.mjs`，但调度和时间配置已经从主目录源码里收进这里。
