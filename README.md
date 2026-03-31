# auto-DingTalk-checkin

> 本项目非微信官方项目，代码由 [@tencent-weixin/openclaw-weixin](https://npmx.dev/package/@tencent-weixin/openclaw-weixin) 改造而来，仅供学习交流使用。

当前仓库实际是一个「微信 Agent 桥接 + ACP 接入 + 本地设备自动化」的 monorepo。除了把 Codex、Claude Code、kimi-cli 这类 Agent 接进微信，也内置了钉钉打卡、QQ 经典农场和定时主动消息。

## 项目结构

```text
packages/
  sdk/                  weixin-agent-sdk，微信桥接 SDK
  agent-acp/            weixin-acp，ACP Agent 适配器和本地自动化入口
  example-openai/       基于 OpenAI 的示例 bot
scripts/
  ios/run-action.mjs    iPhone 自动化脚本（Appium + XCUITest）
```

## 功能概览

- 每次启动 `weixin-acp start` 前都会重新扫码登录微信。
- 支持通过 ACP 接入 Codex、Claude Code、kimi-cli 等 Agent。
- 微信内置本地命令：`打卡`、`偷菜`、`退出钉钉`。
- Android 和 iPhone 共用同一套命令语义，默认自动识别连接设备，也支持手动指定平台。
- 自动打卡调度：工作日 `09:01-09:10` 随机上班打卡，`18:10-18:20` 随机下班打卡。
- 自动偷菜调度：默认每 `5` 分钟执行一次进入 `QQ经典农场` 的流程。
- 主动消息：每天 `08:00` 市场价格简报，每天 `09:05` 晨间鼓励。
- 支持文本、图片、语音、视频、文件消息，以及图片/视频/文件回复。

主动消息第一次启用前，需要你先手动给 bot 发过一条消息，用来建立可复用的会话上下文。

## 快速开始

### 环境要求

- Node.js `>= 22`
- `pnpm`
- Android 自动化需要 `adb`
- iPhone 自动化需要完整 Xcode、Appium 和真机签名环境

### 安装依赖

```bash
corepack enable
corepack pnpm install
```

### 启动整个项目

整个 monorepo 没有根目录统一的 `pnpm start`。实际启动入口是 `weixin-acp` 这个包：

```bash
corepack pnpm --filter weixin-acp start -- -- codex-acp
```

如果你要接别的 Agent，把最后的 `codex-acp` 换成你自己的 ACP 命令即可，例如：

```bash
corepack pnpm --filter weixin-acp start -- -- claude-agent-acp
corepack pnpm --filter weixin-acp start -- -- kimi acp
corepack pnpm --filter weixin-acp start -- -- node ./my-agent.js
```

说明：

- 首次启动或会话失效时，会在启动过程中要求重新扫码登录微信。
- Android 直接执行上面的命令即可。
- iPhone 需要先在另一个终端启动 Appium：

```bash
corepack pnpm ios:appium
```

如果你使用的是已发布 CLI，对应命令是：

```bash
npx weixin-acp start -- codex-acp
```

### 一键提交最新代码到 GitHub

仓库根目录已经内置了一条一键同步脚本：

```bash
corepack pnpm git:sync
```

默认行为：

- 自动执行 `git add -A`
- 如果检测到新变更，自动生成提交信息并提交
- 将当前分支推送到 `origin`
- 不会执行强推

如果你想自己指定提交信息：

```bash
corepack pnpm git:sync -- "feat: update qq farm store module"
```

如果你想显式推送到指定分支，例如 `main`：

```bash
GIT_SYNC_BRANCH=main corepack pnpm git:sync -- "chore: sync latest changes"
```

### 可选：安装 OCR 回退

为减少因不同分辨率、WebView、自绘控件导致的定位失败，仓库支持通过 PaddleOCR 做文字识别回退，优先用于：

- 钉钉工作台里的 `考勤打卡` 入口
- 钉钉考勤页里的 `上班打卡` / `下班打卡` / `极速打卡`
- 微信搜索结果页里的 `QQ经典农场` / `前往`
- QQ 经典农场里的 `好友` / `拜访` / `回家` / `商店` / `商城` 等场景文字

推荐安装到仓库本地虚拟环境：

```bash
uv venv .venv-paddleocr --python 3.9
uv pip install --python .venv-paddleocr/bin/python paddlepaddle==3.2.0 paddleocr
```

默认会优先使用仓库内的 `.venv-paddleocr/bin/python`。常用开关：

| 变量 | 说明 |
| --- | --- |
| `WEIXIN_OCR=0` | 关闭 OCR 回退 |
| `WEIXIN_OCR_PYTHON=/path/to/python` | 指定 OCR 使用的 Python |
| `WEIXIN_OCR_PADDLE_MODEL_VARIANT=mobile` | 指定 PaddleOCR 模型规格，默认 `mobile` |

### 仅扫码登录

```bash
corepack pnpm --filter weixin-acp login
```

如果你使用已发布的 CLI，也可以直接执行：

```bash
npx weixin-acp login
```

### 启动 ACP Agent

Codex:

```bash
npm install -g @zed-industries/codex-acp
corepack pnpm --filter weixin-acp start -- -- codex-acp
```

如果没有显式传 `-c model=...`，`weixin-acp` 会默认给 `codex-acp` 补上 `gpt-5.4`。

Claude Code:

```bash
npm install -g @zed-industries/claude-agent-acp
corepack pnpm --filter weixin-acp start -- -- claude-agent-acp
```

kimi-cli:

```bash
corepack pnpm --filter weixin-acp start -- -- kimi acp
```

也可以接自己的 ACP 命令：

```bash
corepack pnpm --filter weixin-acp start -- -- node ./my-agent.js
```

如果你使用的是已发布的 CLI，也可以把上面的启动命令替换成 `npx weixin-acp start -- ...`。

常用启动相关环境变量：

| 变量 | 说明 |
| --- | --- |
| `WEIXIN_EXIT_AFTER_LOGIN=1` | 只完成扫码登录，成功后立即退出 |
| `WEIXIN_MACOS_KEEP_AWAKE=0` | 关闭 macOS 默认的 `caffeinate` 防休眠 |

## 本地自动化

### 统一命令入口

微信里直接发送：

- `打卡`
- `偷菜`
- `退出钉钉`

这三个命令在 Android 和 iPhone 上保持同一套入口和返回语义：

| 命令 | Android | iPhone |
| --- | --- | --- |
| `打卡` | 通过 `adb` 打开钉钉，进入 `工作台 -> 考勤打卡`，在有效时间窗内点击打卡 | 通过内置 `Appium + XCUITest` 脚本进入钉钉并执行同样流程 |
| `偷菜` | 通过 `adb` 打开微信并进入 `QQ经典农场` | 通过 iPhone 自动化脚本进入微信并打开 `QQ经典农场` |
| `退出钉钉` | 关闭钉钉 | 关闭钉钉 |

默认行为：

- 自动检测当前连接的是 Android 还是 iPhone。
- 如果同时连着两种设备，需显式设置 `WEIXIN_DEVICE_PLATFORM=android` 或 `WEIXIN_DEVICE_PLATFORM=ios`。
- `打卡` 完成后默认会清掉钉钉后台。
- 若钉钉出现验证码、滑块、人脸或其他安全校验，需要先人工处理，自动化不会替你过风控。
- `偷菜` 会先识别 QQ 农场当前场景（主页 / 好友页 / 商店 / 好友农场），再按统一语义执行；文字菜单优先走 OCR，田地里的采摘/偷取/除草/除虫仍主要依赖画布热点与视觉兜底。

### 自动任务

| 功能 | 默认行为 | 关闭方式 |
| --- | --- | --- |
| 自动打卡 | 工作日早晚各随机执行一次 | `WEIXIN_AUTO_CLOCK_IN=0` |
| 自动偷菜 | 每 `5` 分钟执行一次 | `WEIXIN_AUTO_QQ_FARM=0` |
| 晨间鼓励 | 每天 `09:05` 主动发送 | `WEIXIN_DAILY_MOTIVATION=0` |
| 市场简报 | 每天 `08:00` 主动发送 | `WEIXIN_DAILY_CRYPTO_BRIEFING=0` |

自动打卡时间窗统一在 [`packages/agent-acp/src/clock-in-config.ts`](./packages/agent-acp/src/clock-in-config.ts) 调整。

### 常用自动化环境变量

| 变量 | 说明 |
| --- | --- |
| `WEIXIN_DEVICE_PLATFORM` | 强制指定当前使用 `android` 或 `ios` |
| `WEIXIN_CLEAR_DINGTALK_AFTER_CLOCK_IN=0` | 关闭 Android/iPhone 共用的“打卡后自动关闭钉钉”行为 |
| `WEIXIN_ANDROID_CLEAR_RECENT_APPS_AFTER_CLOCK_IN=0` | 仅 Android，关闭清理最近任务列表 |
| `WEIXIN_QQ_FARM_INTERVAL_MINUTES=10` | 修改自动偷菜轮询间隔 |
| `WEIXIN_QQ_FARM_QUERY_PREFIX=...` | Android 侧修改 QQ 农场搜索前缀 |
| `WEIXIN_QQ_FARM_PINYIN_QUERY=...` | Android 侧修改 QQ 农场拼音搜索词 |
| `WEIXIN_CRYPTO_IDS=btc,eth,sol` | 修改市场简报币种列表 |
| `WEIXIN_CRYPTO_QUOTE_ASSET=USDT` | 修改市场简报报价币种 |

## Android 配置

Android 侧依赖 `adb`。`scrcpy` 只用于辅助看画面，不是必须。

macOS:

```bash
brew install android-platform-tools scrcpy
adb devices
```

Linux:

```bash
sudo apt update
sudo apt install -y adb scrcpy
adb devices
```

确认 `adb devices` 能看到手机后，再发微信命令 `打卡` / `偷菜` 即可。

## iPhone 配置

仓库内置了 [`scripts/ios/run-action.mjs`](./scripts/ios/run-action.mjs)，默认用 `Appium + XCUITest + WebDriverAgent` 处理 iPhone 上的 `打卡`、`偷菜`、`退出钉钉`。

### 前置要求

至少需要：

1. 安装完整 Xcode，而不只是 Command Line Tools
2. 执行：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
```

3. iPhone 开启 `Developer Mode`
4. USB 连接手机，并在手机上点“信任”
5. Xcode 登录 Apple ID，并为 `WebDriverAgentRunner` 配置可用签名
6. 手机上信任开发者证书

安装辅助依赖：

```bash
brew install libimobiledevice
corepack pnpm ios:appium:install-driver
```

### 常用命令

```bash
corepack pnpm ios:doctor
corepack pnpm ios:appium
corepack pnpm ios:action -- doctor
corepack pnpm ios:action -- dingtalk-clock-in
corepack pnpm ios:action -- qq-farm
corepack pnpm ios:action -- exit-dingtalk
```

### 常用 iPhone 环境变量

| 变量 | 说明 |
| --- | --- |
| `WEIXIN_IOS_DEVICE_ID` | 指定真机设备 ID |
| `WEIXIN_IOS_APPIUM_SERVER_URL` | Appium 地址，默认 `http://127.0.0.1:4723` |
| `WEIXIN_IOS_XCODE_ORG_ID` | Apple Developer Team ID |
| `WEIXIN_IOS_XCODE_SIGNING_ID` | 签名证书名，默认 `Apple Development` |
| `WEIXIN_IOS_UPDATED_WDA_BUNDLE_ID` | 给 `WebDriverAgentRunner` 使用你账号下唯一的 bundle id |
| `WEIXIN_IOS_ALLOW_PROVISIONING_DEVICE_REGISTRATION` | 是否允许自动注册设备和创建 profile |
| `WEIXIN_IOS_CLEAR_DINGTALK_AFTER_CLOCK_IN` | 仅 iPhone，优先级高于共享变量 |
| `WEIXIN_IOS_QQ_FARM_QUERY` | iPhone 侧修改 QQ 农场搜索词 |

如果你不想使用仓库内置的 iPhone 脚本，也可以覆盖默认命令：

- `WEIXIN_IOS_DINGTALK_CLOCK_IN_COMMAND`
- `WEIXIN_IOS_QQ_FARM_COMMAND`
- `WEIXIN_IOS_EXIT_DINGTALK_COMMAND`

执行这些自定义命令时，进程会注入：

- `WEIXIN_CONNECTED_DEVICE_ID`
- `WEIXIN_CONNECTED_DEVICE_NAME`
- `WEIXIN_CONNECTED_DEVICE_PLATFORM`

执行打卡命令时还会注入：

- `WEIXIN_CLOCK_IN_SLOT_ID`
- `WEIXIN_CLOCK_IN_SLOT_LABEL`

如需坐标兜底、画布点击步骤等更细粒度配置，请直接查看 [`scripts/ios/run-action.mjs`](./scripts/ios/run-action.mjs) 顶部的环境变量说明。

## 自定义 Agent / SDK

`packages/sdk` 只暴露一套很小的接口：

- `login()`
- `start(agent)`
- `sendProactiveTextMessage()`
- `Agent` / `ChatRequest` / `ChatResponse` 类型

最简示例：

```ts
import { start, type Agent } from "weixin-agent-sdk";

const echo: Agent = {
  async chat(req) {
    return { text: `你说了: ${req.text}` };
  },
};

await start(echo);
```

如果你要自己维护多轮上下文，只需要按 `conversationId` 保存历史即可。

完整的 OpenAI 示例见 [`packages/example-openai`](./packages/example-openai)：

```bash
OPENAI_API_KEY=sk-xxx corepack pnpm --filter example-openai start
```

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API Key |
| `OPENAI_BASE_URL` | 自定义兼容 OpenAI 的接口地址 |
| `OPENAI_MODEL` | 模型名，默认 `gpt-5.4` |
| `SYSTEM_PROMPT` | 自定义系统提示词 |

## 消息与内置命令

### 支持的消息类型

接收侧支持：

- 文本
- 图片
- 语音
- 视频
- 文件
- 引用消息
- 微信语音转文字

发送侧支持：

- 文本
- 图片
- 视频
- 文件
- 文本 + 媒体组合回复

语音消息会优先转成 `WAV`；如果本机没有可用的 `silk-wasm`，则回退保存原始 `SILK` 文件。

### 内置斜杠命令

微信里可直接发送：

- `/echo <消息>`：不经过 Agent，直接回显并附带耗时统计
- `/toggle-debug`：开关 debug 模式，启用后每条回复追加全链路耗时

## 运行说明

- 使用长轮询接收消息，不需要公网服务器。
- 单账号模式：新的扫码登录会覆盖上一次账号状态。
- 运行状态和断点信息保存在 `~/.openclaw/` 下。
- 会话过期后会自动尝试恢复。
