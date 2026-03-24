import spawn from "cross-spawn";

import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

const DINGTALK_PACKAGE = "com.alibaba.android.rimet";
const UI_DUMP_PATH = "/sdcard/weixin-agent-ui.xml";
const SCRCPY_PROCESS_NAME = "scrcpy";
const DEFAULT_WIDGET_CENTER = { x: 1524, y: 1103 };
const DEFAULT_CLEAR_ALL_CENTER = { x: 2814, y: 153 };
const OPEN_DELAY_MS = Number.parseInt(process.env.WEIXIN_DINGTALK_OPEN_DELAY_MS ?? "4000", 10);
const EXIT_DELAY_MS = Number.parseInt(process.env.WEIXIN_DINGTALK_EXIT_DELAY_MS ?? "1500", 10);

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type UINode = Record<string, string>;

function log(message: string): void {
  console.log(`[local-command] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandString(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function runCommand(
  command: string,
  args: string[],
  opts?: { allowNonZero?: boolean },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (exitCode) => {
      const code = exitCode ?? -1;
      if (code !== 0 && !opts?.allowNonZero) {
        const details = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`${commandString(command, args)} failed: ${details}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function resolveDeviceId(): Promise<string> {
  const preferred = process.env.WEIXIN_DINGTALK_DEVICE_ID?.trim();
  const result = await runCommand("adb", ["devices", "-l"]);
  const deviceLines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached"));

  const devices = deviceLines
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0] && parts[1] === "device")
    .map((parts) => parts[0]);

  if (preferred) {
    if (!devices.includes(preferred)) {
      throw new Error(`未找到指定设备 ${preferred}`);
    }
    return preferred;
  }

  if (devices.length === 0) {
    throw new Error("未检测到 adb 设备");
  }

  return devices[0];
}

async function adb(deviceId: string, args: string[], opts?: { allowNonZero?: boolean }): Promise<CommandResult> {
  return await runCommand("adb", ["-s", deviceId, ...args], opts);
}

async function isScrcpyRunning(): Promise<boolean> {
  const result = await runCommand("pgrep", ["-x", SCRCPY_PROCESS_NAME], { allowNonZero: true });
  return result.exitCode === 0;
}

async function ensureScrcpyRunning(deviceId: string): Promise<string> {
  if (await isScrcpyRunning()) {
    return "scrcpy 已在运行";
  }

  try {
    log(`starting scrcpy for device=${deviceId}`);
    let spawnError: Error | undefined;
    const child = spawn("scrcpy", ["-s", deviceId], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    await sleep(1200);

    if (spawnError) {
      log(`scrcpy start failed: ${spawnError.message}`);
      return "scrcpy 启动失败，已切换为纯后台执行";
    }

    if (await isScrcpyRunning()) {
      return "已启动 scrcpy";
    }

    return "scrcpy 未启动，已切换为纯后台执行";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`scrcpy start failed: ${message}`);
    return "scrcpy 启动失败，已切换为纯后台执行";
  }
}

function parseNodes(xml: string): UINode[] {
  const nodes: UINode[] = [];
  const tagRegex = /<node\b([^>]*?)\/>/g;
  for (const match of xml.matchAll(tagRegex)) {
    const attrs: UINode = {};
    const attrRegex = /([\w:-]+)="([^"]*)"/g;
    for (const attrMatch of match[1].matchAll(attrRegex)) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    nodes.push(attrs);
  }
  return nodes;
}

function parseBounds(bounds: string | undefined): { x: number; y: number } | undefined {
  if (!bounds) return undefined;
  const match = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return undefined;
  const [, left, top, right, bottom] = match;
  return {
    x: Math.round((Number.parseInt(left, 10) + Number.parseInt(right, 10)) / 2),
    y: Math.round((Number.parseInt(top, 10) + Number.parseInt(bottom, 10)) / 2),
  };
}

function findAttendanceWidgetCenter(xml: string): { x: number; y: number } | undefined {
  const nodes = parseNodes(xml);
  const widgetNode =
    nodes.find((node) => node["resource-id"] === "com.alibaba.android.rimet:id/widget_container") ??
    nodes.find(
      (node) =>
        node["content-desc"] === "钉钉" &&
        node.clickable === "true" &&
        node.bounds,
    ) ??
    nodes.find(
      (node) =>
        (node.text?.includes("考勤打卡") || node.text?.includes("去打卡")) &&
        node.bounds,
    );

  return parseBounds(widgetNode?.bounds);
}

function findClearAllCenter(xml: string): { x: number; y: number } | undefined {
  const nodes = parseNodes(xml);
  const clearAllNode =
    nodes.find(
      (node) =>
        node["resource-id"] === "com.miui.home:id/recent_clear_all_task_container_for_pad" &&
        node.clickable === "true" &&
        node.bounds,
    ) ??
    nodes.find(
      (node) =>
        node.text?.includes("清除全部") &&
        node.bounds,
    );

  return parseBounds(clearAllNode?.bounds);
}

async function dumpUi(deviceId: string): Promise<string> {
  await adb(deviceId, ["shell", "uiautomator", "dump", UI_DUMP_PATH]);
  const result = await adb(deviceId, ["shell", "cat", UI_DUMP_PATH]);
  return result.stdout;
}

async function tap(deviceId: string, x: number, y: number): Promise<void> {
  log(`tap (${x}, ${y})`);
  await adb(deviceId, ["shell", "input", "tap", String(x), String(y)]);
}

async function exitDingTalk(deviceId: string): Promise<void> {
  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await sleep(500);
  await adb(deviceId, ["shell", "am", "force-stop", DINGTALK_PACKAGE]);
}

async function clearRecentApps(deviceId: string): Promise<{ usedFallback: boolean }> {
  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_APP_SWITCH"]);
  await sleep(1200);

  const recentsXml = await dumpUi(deviceId);
  const center = findClearAllCenter(recentsXml) ?? DEFAULT_CLEAR_ALL_CENTER;
  const usedFallback = center === DEFAULT_CLEAR_ALL_CENTER;

  await tap(deviceId, center.x, center.y);
  await sleep(800);
  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
  return { usedFallback };
}

export async function runAttendanceCommand(opts?: { headless?: boolean }): Promise<ChatResponse> {
  const deviceId = await resolveDeviceId();
  const scrcpyStatus = opts?.headless
    ? "已切换为纯后台执行"
    : await ensureScrcpyRunning(deviceId);

  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await sleep(800);

  const homeXml = await dumpUi(deviceId);
  const center = findAttendanceWidgetCenter(homeXml) ?? DEFAULT_WIDGET_CENTER;
  const usedFallback = center === DEFAULT_WIDGET_CENTER;

  await tap(deviceId, center.x, center.y);
  await sleep(OPEN_DELAY_MS);
  await sleep(EXIT_DELAY_MS);
  await exitDingTalk(deviceId);
  const clearResult = await clearRecentApps(deviceId);

  const fallbackMessages: string[] = [];
  if (usedFallback) {
    fallbackMessages.push("打开打卡卡片时使用了默认坐标");
  }
  if (clearResult.usedFallback) {
    fallbackMessages.push("清除全部时使用了默认坐标");
  }
  const fallbackSuffix = fallbackMessages.length > 0 ? `，${fallbackMessages.join("，")}` : "";
  return {
    text: `${scrcpyStatus}，已点击桌面“考勤打卡”卡片、后台退出钉钉，并清除全部后台任务${fallbackSuffix}。`,
  };
}

async function handleExitDingTalkCommand(): Promise<ChatResponse> {
  const deviceId = await resolveDeviceId();
  await exitDingTalk(deviceId);
  return { text: "已退出钉钉。" };
}

export class LocalCommandAgent implements Agent {
  constructor(private delegate: Agent) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const text = request.text.trim();
    if (text === "打卡") {
      return await runAttendanceCommand();
    }
    if (text === "退出钉钉") {
      return await handleExitDingTalkCommand();
    }
    return await this.delegate.chat(request);
  }

  clearSession(conversationId: string): void {
    this.delegate.clearSession?.(conversationId);
  }

  dispose(): void {
    const disposable = this.delegate as Agent & { dispose?: () => void };
    disposable.dispose?.();
  }
}
