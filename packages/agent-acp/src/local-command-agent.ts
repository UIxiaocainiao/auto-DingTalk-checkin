import spawn from "cross-spawn";
import { PNG } from "pngjs";

import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

import { CLOCK_IN_SLOTS, resolveActiveClockInSlot, type ClockInSlotConfig, type ClockInSlotId } from "./clock-in-config.js";

const DINGTALK_PACKAGE = "com.alibaba.android.rimet";
const DINGTALK_WORKBENCH_URI =
  process.env.WEIXIN_DINGTALK_WORKBENCH_URI ?? "dingtalk://dingtalkclient/org_microapp_list.html";
const DINGTALK_ATTENDANCE_ENTRY_TEXTS = (
  process.env.WEIXIN_DINGTALK_ATTENDANCE_ENTRY_TEXTS ?? "签到,考勤打卡,考勤,打卡,出勤天数,出勤"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const UI_DUMP_PATH = "/sdcard/weixin-agent-ui.xml";
const SCRCPY_PROCESS_NAME = "scrcpy";
const OPEN_DELAY_MS = Number.parseInt(process.env.WEIXIN_DINGTALK_OPEN_DELAY_MS ?? "4000", 10);
const EXIT_DELAY_MS = Number.parseInt(process.env.WEIXIN_DINGTALK_EXIT_DELAY_MS ?? "1500", 10);
const WORKBENCH_SCROLL_ATTEMPTS = Number.parseInt(process.env.WEIXIN_DINGTALK_WORKBENCH_SCROLL_ATTEMPTS ?? "8", 10);
const PUNCH_BUTTON_DETECTION_STEP = Number.parseInt(process.env.WEIXIN_DINGTALK_PUNCH_BUTTON_DETECTION_STEP ?? "5", 10);
const PUNCH_BUTTON_DETECTION_ATTEMPTS = Number.parseInt(process.env.WEIXIN_DINGTALK_PUNCH_BUTTON_DETECTION_ATTEMPTS ?? "5", 10);
const PUNCH_BUTTON_RETRY_DELAY_MS = Number.parseInt(process.env.WEIXIN_DINGTALK_PUNCH_BUTTON_RETRY_DELAY_MS ?? "1200", 10);

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type BinaryCommandResult = {
  stdout: Buffer;
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

async function runCommandBuffer(
  command: string,
  args: string[],
  opts?: { allowNonZero?: boolean },
): Promise<BinaryCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (exitCode) => {
      const code = exitCode ?? -1;
      const stdout = Buffer.concat(stdoutChunks);
      if (code !== 0 && !opts?.allowNonZero) {
        const details = stderr.trim() || stdout.toString("utf8").trim() || `exit code ${code}`;
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

async function adbBuffer(deviceId: string, args: string[], opts?: { allowNonZero?: boolean }): Promise<BinaryCommandResult> {
  return await runCommandBuffer("adb", ["-s", deviceId, ...args], opts);
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
  // UI XML mixes both self-closing leaf nodes and opening tags for container nodes.
  const tagRegex = /<node\b([^>]*?)(?:\/>|>)/g;
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

function parseRect(bounds: string | undefined): { left: number; top: number; right: number; bottom: number } | undefined {
  if (!bounds) return undefined;
  const match = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return undefined;
  const [, left, top, right, bottom] = match;
  return {
    left: Number.parseInt(left, 10),
    top: Number.parseInt(top, 10),
    right: Number.parseInt(right, 10),
    bottom: Number.parseInt(bottom, 10),
  };
}

function textMatchesAttendanceEntry(text: string | undefined): boolean {
  if (!text) return false;
  return DINGTALK_ATTENDANCE_ENTRY_TEXTS.some((candidate) => text.includes(candidate));
}

function findAttendanceEntryCenter(xml: string): { x: number; y: number } | undefined {
  const nodes = parseNodes(xml);
  const entryNode = nodes.find(
    (node) =>
      textMatchesAttendanceEntry(node.text) &&
      node["resource-id"] === "com.alibaba.android.rimet:id/oa_entry_title" &&
      node.bounds,
  ) ?? nodes.find((node) => textMatchesAttendanceEntry(node.text) && node.bounds);

  return parseBounds(entryNode?.bounds);
}

function findScrollableArea(xml: string): { left: number; top: number; right: number; bottom: number } | undefined {
  const nodes = parseNodes(xml);
  const scrollableNode = nodes.find(
    (node) =>
      node.class === "androidx.recyclerview.widget.RecyclerView" &&
      node.scrollable === "true" &&
      node.bounds,
  );
  return parseRect(scrollableNode?.bounds);
}

function formatClockInWindows(): string {
  return CLOCK_IN_SLOTS.map((slot) => {
    const hour = String(slot.hour).padStart(2, "0");
    const startMinute = String(slot.startMinute).padStart(2, "0");
    const endMinute = String(slot.endMinute).padStart(2, "0");
    return `${slot.label} ${hour}:${startMinute}-${hour}:${endMinute}`;
  }).join(" / ");
}

function getSlotCenterMinute(slot: ClockInSlotConfig): number {
  return slot.hour * 60 + Math.round((slot.startMinute + slot.endMinute) / 2);
}

function resolveManualClockInSlot(now: Date): ClockInSlotConfig {
  const activeSlot = resolveActiveClockInSlot(now);
  if (activeSlot) {
    return activeSlot;
  }

  const currentMinute = now.getHours() * 60 + now.getMinutes();
  let nearestSlot = CLOCK_IN_SLOTS[0];
  let nearestDistance = Math.abs(getSlotCenterMinute(nearestSlot) - currentMinute);

  for (const slot of CLOCK_IN_SLOTS.slice(1)) {
    const distance = Math.abs(getSlotCenterMinute(slot) - currentMinute);
    if (distance < nearestDistance) {
      nearestSlot = slot;
      nearestDistance = distance;
    }
  }

  return nearestSlot;
}
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === red) {
      h = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      h = 60 * ((blue - red) / delta + 2);
    } else {
      h = 60 * ((red - green) / delta + 4);
    }
  }
  if (h < 0) {
    h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

function isPunchButtonPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 180) {
    return false;
  }
  const { h, s, v } = rgbToHsv(r, g, b);
  if (s < 0.35 || v < 0.45) {
    return false;
  }
  const isOrange = h >= 18 && h <= 60;
  const isBlue = h >= 185 && h <= 250;
  return isOrange || isBlue;
}

export function findPunchButtonCenterFromScreenshot(pngBuffer: Buffer): { x: number; y: number } | undefined {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const step = Math.max(2, PUNCH_BUTTON_DETECTION_STEP);
  const xStart = Math.floor(width * 0.05);
  const xEnd = Math.floor(width * 0.95);
  const yStart = Math.floor(height * 0.45);
  const yEnd = Math.floor(height * 0.92);
  const gridWidth = Math.max(1, Math.floor((xEnd - xStart) / step));
  const gridHeight = Math.max(1, Math.floor((yEnd - yStart) / step));
  const mask = new Uint8Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = yStart + gy * step;
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = xStart + gx * step;
      const index = (y * width + x) * 4;
      if (isPunchButtonPixel(data[index], data[index + 1], data[index + 2], data[index + 3])) {
        mask[gy * gridWidth + gx] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  let best:
    | {
        area: number;
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
      }
    | undefined;

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) {
      continue;
    }
    visited[start] = 1;
    const stack = [start];
    let area = 0;
    let minX = start % gridWidth;
    let maxX = minX;
    let minY = Math.floor(start / gridWidth);
    let maxY = minY;

    while (stack.length > 0) {
      const current = stack.pop()!;
      const x = current % gridWidth;
      const y = Math.floor(current / gridWidth);
      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const neighbors = [
        current - 1,
        current + 1,
        current - gridWidth,
        current + gridWidth,
      ];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || visited[next] === 1 || mask[next] === 0) {
          continue;
        }
        const nextX = next % gridWidth;
        const nextY = Math.floor(next / gridWidth);
        if (Math.abs(nextX - x) + Math.abs(nextY - y) !== 1) {
          continue;
        }
        visited[next] = 1;
        stack.push(next);
      }
    }

    const componentWidth = (maxX - minX + 1) * step;
    const componentHeight = (maxY - minY + 1) * step;
    const areaPixels = area * step * step;
    const fillRatio = areaPixels / Math.max(componentWidth * componentHeight, 1);

    if (componentWidth < width * 0.08 || componentHeight < height * 0.05) {
      continue;
    }
    if (componentWidth > width * 0.55 || componentHeight > height * 0.35) {
      continue;
    }
    if (fillRatio < 0.2) {
      continue;
    }

    if (!best || area > best.area) {
      best = { area, minX, minY, maxX, maxY };
    }
  }

  if (!best) {
    return undefined;
  }

  return {
    x: xStart + Math.round(((best.minX + best.maxX + 1) * step) / 2),
    y: yStart + Math.round(((best.minY + best.maxY + 1) * step) / 2),
  };
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

async function captureScreen(deviceId: string): Promise<Buffer> {
  const result = await adbBuffer(deviceId, ["exec-out", "screencap", "-p"]);
  return result.stdout;
}

async function tap(deviceId: string, x: number, y: number): Promise<void> {
  log(`tap (${x}, ${y})`);
  await adb(deviceId, ["shell", "input", "tap", String(x), String(y)]);
}

async function swipe(deviceId: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  log(`swipe (${from.x}, ${from.y}) -> (${to.x}, ${to.y})`);
  await adb(deviceId, [
    "shell",
    "input",
    "swipe",
    String(from.x),
    String(from.y),
    String(to.x),
    String(to.y),
    "250",
  ]);
}

async function openWorkbenchPage(deviceId: string): Promise<void> {
  log(`opening DingTalk workbench page via deep link: ${DINGTALK_WORKBENCH_URI}`);
  await adb(deviceId, [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    DINGTALK_WORKBENCH_URI,
    DINGTALK_PACKAGE,
  ]);
}

async function openAttendancePageFromWorkbench(deviceId: string): Promise<void> {
  await openWorkbenchPage(deviceId);
  await sleep(1200);

  for (let attempt = 0; attempt < WORKBENCH_SCROLL_ATTEMPTS; attempt += 1) {
    const xml = await dumpUi(deviceId);
    const center = findAttendanceEntryCenter(xml);
    if (center) {
      log(`found attendance entry on workbench at attempt=${attempt + 1}`);
      await tap(deviceId, center.x, center.y);
      return;
    }

    const scrollableArea = findScrollableArea(xml);
    if (!scrollableArea) {
      throw new Error("未找到工作台应用列表，无法定位“考勤打卡”");
    }

    const x = Math.round((scrollableArea.left + scrollableArea.right) / 2);
    const from = {
      x,
      y: Math.round(scrollableArea.top + (scrollableArea.bottom - scrollableArea.top) * 0.78),
    };
    const to = {
      x,
      y: Math.round(scrollableArea.top + (scrollableArea.bottom - scrollableArea.top) * 0.28),
    };
    await swipe(deviceId, from, to);
    await sleep(500);
  }

  throw new Error(`未在工作台中找到应用：${DINGTALK_ATTENDANCE_ENTRY_TEXTS.join(" / ")}`);
}

async function clickPunchButton(deviceId: string, slot: ClockInSlotConfig): Promise<void> {
  for (let attempt = 0; attempt < PUNCH_BUTTON_DETECTION_ATTEMPTS; attempt += 1) {
    const screenshot = await captureScreen(deviceId);
    const center = findPunchButtonCenterFromScreenshot(screenshot);
    if (center) {
      log(`found ${slot.label} punch button via screenshot at (${center.x}, ${center.y})`);
      await tap(deviceId, center.x, center.y);
      return;
    }
    if (attempt < PUNCH_BUTTON_DETECTION_ATTEMPTS - 1) {
      log(`punch button not ready yet, retrying attempt=${attempt + 2}`);
      await sleep(PUNCH_BUTTON_RETRY_DELAY_MS);
    }
  }
  throw new Error(`已进入“考勤打卡”页面，但未识别到${slot.label}打卡按钮`);
}

async function exitDingTalk(deviceId: string): Promise<void> {
  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await sleep(500);
  await adb(deviceId, ["shell", "am", "force-stop", DINGTALK_PACKAGE]);
}

async function clearRecentApps(deviceId: string): Promise<{ cleared: boolean }> {
  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_APP_SWITCH"]);
  await sleep(1200);

  const recentsXml = await dumpUi(deviceId);
  const center = findClearAllCenter(recentsXml);
  if (!center) {
    await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
    return { cleared: false };
  }

  await tap(deviceId, center.x, center.y);
  await sleep(800);
  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
  return { cleared: true };
}

export async function runAttendanceCommand(opts?: {
  headless?: boolean;
  enforceTimeWindow?: boolean;
  throwOnOutsideWindow?: boolean;
  overrideSlotId?: ClockInSlotId;
}): Promise<ChatResponse> {
  const deviceId = await resolveDeviceId();
  const scrcpyStatus = opts?.headless
    ? "已切换为纯后台执行"
    : await ensureScrcpyRunning(deviceId);
  const enforceTimeWindow = opts?.enforceTimeWindow ?? true;
  const activeSlot = opts?.overrideSlotId
    ? CLOCK_IN_SLOTS.find((slot) => slot.id === opts.overrideSlotId)
    : resolveActiveClockInSlot(new Date());

  if (enforceTimeWindow && !activeSlot) {
    const message = `当前不在打卡时间窗内（${formatClockInWindows()}），已跳过自动打卡操作。`;
    if (opts?.throwOnOutsideWindow) {
      throw new Error(message);
    }
    return { text: message };
  }

  await openAttendancePageFromWorkbench(deviceId);
  await sleep(OPEN_DELAY_MS);
  if (activeSlot) {
    await clickPunchButton(deviceId, activeSlot);
  }
  await sleep(EXIT_DELAY_MS);
  await exitDingTalk(deviceId);
  const clearResult = await clearRecentApps(deviceId);

  const attendanceAction = activeSlot
    ? `识别并点击${activeSlot.label}打卡按钮`
    : "进入打卡页面（当前不在打卡时间窗内，未点击上/下班按钮）";
  const clearStatus = clearResult.cleared ? "并清除全部后台任务" : "未找到“清除全部”，已跳过后台清理";
  return {
    text: `${scrcpyStatus}，已通过 adb 打开钉钉工作台、${attendanceAction}、后台退出钉钉，${clearStatus}。`,
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
      const slot = resolveManualClockInSlot(new Date());
      return await runAttendanceCommand({
        enforceTimeWindow: false,
        overrideSlotId: slot.id,
      });
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
