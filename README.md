# weixin-agent-sdk

> 本项目非微信官方项目，代码由 [@tencent-weixin/openclaw-weixin](https://npmx.dev/package/@tencent-weixin/openclaw-weixin) 改造而来，仅供学习交流使用。

微信 AI Agent 桥接框架 —— 通过简单的 Agent 接口，将任意 AI 后端接入微信。

## 项目结构

```
packages/
  sdk/                  weixin-agent-sdk —— 微信桥接 SDK
  agent-acp/            ACP (Agent Client Protocol) 适配器
  example-openai/       基于 OpenAI 的示例
```

## 通过 ACP 接入 Claude Code, Codex, kimi-cli 等 Agent

[ACP (Agent Client Protocol)](https://agentclientprotocol.com/) 是一个开放的 Agent 通信协议。如果你已有兼容 ACP 的 agent，可以直接通过 [`weixin-acp`](https://www.npmjs.com/package/weixin-acp) 接入微信，无需编写任何代码。


### 扫码登录

`start` 命令现在会在每次启动前强制走一次微信扫码登录；如果你只想单独测试登录，也可以手动执行：

```bash
npx weixin-acp login
```

在 macOS 上，`start()` / `weixin-acp start` 默认会自动启用 `caffeinate` 防休眠，所以锁定屏幕后 bot 仍可继续在后台运行。这个保活只覆盖“锁屏但机器未合盖”的场景；如果合上笔记本或系统主动关机，进程仍会中断。若你确实要关闭这项行为，可设置 `WEIXIN_MACOS_KEEP_AWAKE=0`。

### Claude Code

```bash
# 安装 claude-agent-acp
npm install -g @zed-industries/claude-agent-acp

# 启动 agent（会先要求重新扫码登录微信）
npx weixin-acp start -- claude-agent-acp
```

### Codex

```bash
# 安装 codex-acp
npm install -g @zed-industries/codex-acp

# 启动 agent（会先要求重新扫码登录微信）
# 若未显式传 -c model=...，weixin-acp 会默认补成 gpt-5.4
npx weixin-acp start -- codex-acp
```

如果你使用的是本仓库里 `打卡` 这类 adb 本地命令，`scrcpy` 现在是尽量启动而不是硬依赖；锁屏后即使无法拉起前台窗口，也会继续走后台 adb 流程。

如果你想在桌面上看到手机画面，可以先安装 `scrcpy`：

```bash
# macOS (Homebrew)
brew install scrcpy android-platform-tools

# Ubuntu / Debian
sudo apt update
sudo apt install -y scrcpy adb

# Arch Linux
sudo pacman -S scrcpy android-tools
```

Windows 可以直接用 `winget`：

```powershell
winget install Genymobile.scrcpy
```

安装完成后，先用 USB 或无线 adb 连上手机，再执行本项目即可。

当前仓库还内置了自动打卡调度：默认会按中国法定工作日，在每天 `09:01` 到 `09:10` 之间随机执行一次上班打卡，并在 `18:10` 到 `18:20` 之间随机执行一次下班打卡，复用同一套后台 adb 流程。微信里手动发送 `打卡` 仍然随时可用。工作日判定依赖节假日接口；若接口暂时不可用，当天会延后重试，不会盲目执行。若要关闭这项能力，可设置 `WEIXIN_AUTO_CLOCK_IN=0`。

另外，`weixin-acp` 还会在每天 `09:05` 主动给最近与你交互过的微信会话发送一段晨间鼓励文案，当前文案风格默认按男性口吻编写。第一次启用后，请先手动给 bot 发一条消息，用来建立主动发送所需的会话上下文；之后它就能按计划主动发消息。若要关闭这项能力，可设置 `WEIXIN_DAILY_MOTIVATION=0`。

同时，`weixin-acp` 还会在每天 `08:00` 主动发送一条市场价格简报，默认包含 `BTC / ETH / SOL / BNB / XRP / DOGE` 的 `USDT` 价格和 24 小时涨跌幅，以及 `LBMA PM` 黄金定盘价和较上一条定盘的涨跌幅。第一次启用前同样需要你先手动给 bot 发过一条消息，以建立主动发送上下文。若要关闭这项能力，可设置 `WEIXIN_DAILY_CRYPTO_BRIEFING=0`；若要改币种列表，可设置 `WEIXIN_CRYPTO_IDS=btc,eth,...` 这种逗号分隔列表；若要改报价币种，可设置 `WEIXIN_CRYPTO_QUOTE_ASSET=USDT`。

### kimi-cli

```bash
# 启动 agent（会先要求重新扫码登录微信）
npx weixin-acp start -- kimi acp
```

`--` 后面的部分就是你的 ACP agent 启动命令，`weixin-acp` 会自动以子进程方式启动它，通过 JSON-RPC over stdio 进行通信。

更多 ACP 兼容 agent 请参考 [ACP agent 列表](https://agentclientprotocol.com/get-started/agents)。

## 自定义 Agent

SDK 只导出三样东西：

- **`Agent`** 接口 —— 实现它就能接入微信
- **`login()`** —— 扫码登录
- **`start(agent)`** —— 每次启动前重新扫码登录，然后启动消息循环

### Agent 接口

```typescript
interface Agent {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

interface ChatRequest {
  conversationId: string;         // 用户标识，可用于维护多轮对话
  text: string;                   // 文本内容
  media?: {                       // 附件（图片/语音/视频/文件）
    type: "image" | "audio" | "video" | "file";
    filePath: string;             // 本地文件路径（已下载解密）
    mimeType: string;
    fileName?: string;
  };
}

interface ChatResponse {
  text?: string;                  // 回复文本（支持 markdown，发送前自动转纯文本）
  media?: {                       // 回复媒体
    type: "image" | "video" | "file";
    url: string;                  // 本地路径或 HTTPS URL
    fileName?: string;
  };
}
```

### 最简示例

```typescript
import { start, type Agent } from "weixin-agent-sdk";

const echo: Agent = {
  async chat(req) {
    return { text: `你说了: ${req.text}` };
  },
};

await start(echo);
```

### 完整示例（自己管理对话历史）

```typescript
import { start, type Agent } from "weixin-agent-sdk";

const conversations = new Map<string, string[]>();

const myAgent: Agent = {
  async chat(req) {
    const history = conversations.get(req.conversationId) ?? [];
    history.push(req.text);

    // 调用你的 AI 服务...
    const reply = await callMyAI(history);

    history.push(reply);
    conversations.set(req.conversationId, history);
    return { text: reply };
  },
};

await start(myAgent);
```

### OpenAI 示例

`packages/example-openai/` 是一个完整的 OpenAI Agent 实现，支持多轮对话和图片输入：

```bash
pnpm install

# 启动 bot（每次启动前会重新扫码登录微信）
OPENAI_API_KEY=sk-xxx pnpm run start -w packages/example-openai
```

支持的环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 是 | OpenAI API Key |
| `OPENAI_BASE_URL` | 否 | 自定义 API 地址（兼容 OpenAI 接口的第三方服务） |
| `OPENAI_MODEL` | 否 | 模型名称，默认 `gpt-5.4` |
| `SYSTEM_PROMPT` | 否 | 系统提示词 |

## 支持的消息类型

### 接收（微信 → Agent）

| 类型 | `media.type` | 说明 |
|------|-------------|------|
| 文本 | — | `request.text` 直接拿到文字 |
| 图片 | `image` | 自动从 CDN 下载解密，`filePath` 指向本地文件 |
| 语音 | `audio` | SILK 格式自动转 WAV（需安装 `silk-wasm`） |
| 视频 | `video` | 自动下载解密 |
| 文件 | `file` | 自动下载解密，保留原始文件名 |
| 引用消息 | — | 被引用的文本拼入 `request.text`，被引用的媒体作为 `media` 传入 |
| 语音转文字 | — | 微信侧转写的文字直接作为 `request.text` |

### 发送（Agent → 微信）

| 类型 | 用法 |
|------|------|
| 文本 | 返回 `{ text: "..." }` |
| 图片 | 返回 `{ media: { type: "image", url: "/path/to/img.png" } }` |
| 视频 | 返回 `{ media: { type: "video", url: "/path/to/video.mp4" } }` |
| 文件 | 返回 `{ media: { type: "file", url: "/path/to/doc.pdf" } }` |
| 文本 + 媒体 | `text` 和 `media` 同时返回，文本作为附带说明发送 |
| 远程图片 | `url` 填 HTTPS 链接，SDK 自动下载后上传到微信 CDN |

## 内置斜杠命令

在微信中发送以下命令：

- `/echo <消息>` —— 直接回复（不经过 Agent），附带通道耗时统计
- `/toggle-debug` —— 开关 debug 模式，启用后每条回复追加全链路耗时

## 技术细节

- 使用 **长轮询** (`getUpdates`) 接收消息，无需公网服务器
- 媒体文件通过微信 CDN 中转，**AES-128-ECB** 加密传输
- 单账号模式：每次 `login` 或 `start` 内触发的扫码登录都会覆盖之前的账号
- 断点续传：`get_updates_buf` 持久化到 `~/.openclaw/`，重启后从上次位置继续
- 会话过期自动重连（errcode -14 触发 1 小时冷却后恢复）
- Node.js >= 22
