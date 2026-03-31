import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import spawn from "cross-spawn";
import { PNG } from "pngjs";

import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

import { CLOCK_IN_SLOTS, resolveActiveClockInSlot, type ClockInSlotConfig, type ClockInSlotId } from "./clock-in-config.js";
import { findOcrTextBlock, recognizeTextBlocks } from "./ocr-fallback.js";
import {
  QQ_FARM_FRIEND_ONE_KEY_ACTIONS,
  QQ_FARM_FRIEND_ENTRY_TEXTS,
  QQ_FARM_FRIEND_VISIT_TEXTS,
  QQ_FARM_HOME_ONE_KEY_ACTIONS,
  QQ_FARM_OPEN_TEXTS,
  QQ_FARM_PRIMARY_ACTION_TEXTS,
  QQ_FARM_RETURN_HOME_TEXTS,
  buildQqFarmQueryCandidates,
  buildQqFarmResultTexts,
  detectQqFarmScene,
  type QqFarmOneKeyAction,
  type QqFarmSceneId,
} from "./qq-farm-shared.js";
import {
  describeQqFarmStoreSeeds,
  parseQqFarmStoreSeeds,
  pickLatestUnlockedQqFarmStoreSeed,
} from "./qq-farm-store.js";

type PointRatio = {
  xRatio: number;
  yRatio: number;
};

type QqFarmPlotState = "empty" | "ripe" | "growing" | "locked" | "unknown";

type QqFarmPlot = {
  row: number;
  column: number;
  screenRow: number;
  xRatio: number;
  yRatio: number;
  x: number;
  y: number;
  state: QqFarmPlotState;
};

type QqFarmSeedChoice = {
  x: number;
  y: number;
  dragX: number;
  dragY: number;
  count: number;
};

type QqFarmResolvedSeedChoice = {
  choice: QqFarmSeedChoice;
  plotType?: string;
};

type QqFarmHomeModuleResult = {
  notes: string[];
};

type QqFarmHomeModule = {
  id: string;
  name: string;
  run: (deviceId: string) => Promise<QqFarmHomeModuleResult>;
};

type QqFarmBatchFamily = "screenRow" | "row" | "column";

type QqFarmBatchCandidate = {
  family: QqFarmBatchFamily;
  key: number;
  plots: QqFarmPlot[];
};

type QqFarmSeedChoiceOptions = {
  recordPlotType?: boolean;
  recordPurchase?: boolean;
};

function parsePointRatio(raw: string | undefined, envName: string): PointRatio | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${envName} 需要是 JSON，例如 {"xRatio":0.5,"yRatio":0.5}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { xRatio?: unknown }).xRatio !== "number" ||
    typeof (parsed as { yRatio?: unknown }).yRatio !== "number"
  ) {
    throw new Error(`${envName} 需要包含数字字段 xRatio 和 yRatio`);
  }

  return {
    xRatio: (parsed as { xRatio: number }).xRatio,
    yRatio: (parsed as { yRatio: number }).yRatio,
  };
}

function resolvePointRatioEnv(envName: string, fallback: PointRatio): PointRatio {
  return parsePointRatio(process.env[envName], envName) ?? fallback;
}

function resolveOptionalPointRatioEnv(envName: string): PointRatio | undefined {
  return parsePointRatio(process.env[envName], envName);
}

const DINGTALK_PACKAGE = "com.alibaba.android.rimet";
const WECHAT_PACKAGE = "com.tencent.mm";
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
const FAST_CLOCK_SETUP_DELAY_MS = Number.parseInt(process.env.WEIXIN_DINGTALK_FAST_CLOCK_SETUP_DELAY_MS ?? "1200", 10);
const FAST_CLOCK_PAGE_LOAD_DELAY_MS = Number.parseInt(process.env.WEIXIN_DINGTALK_FAST_CLOCK_PAGE_LOAD_DELAY_MS ?? "3000", 10);
const WECHAT_OPEN_DELAY_MS = Number.parseInt(process.env.WEIXIN_WECHAT_OPEN_DELAY_MS ?? "3000", 10);
const WECHAT_SEARCH_DELAY_MS = Number.parseInt(process.env.WEIXIN_WECHAT_SEARCH_DELAY_MS ?? "800", 10);
const WECHAT_SEARCH_RESULTS_DELAY_MS = Number.parseInt(process.env.WEIXIN_WECHAT_SEARCH_RESULTS_DELAY_MS ?? "2500", 10);
const WECHAT_APPBRAND_OPEN_DELAY_MS = Number.parseInt(process.env.WEIXIN_WECHAT_APPBRAND_OPEN_DELAY_MS ?? "4000", 10);
const QQ_FARM_QUERY = process.env.WEIXIN_QQ_FARM_QUERY?.trim() || "QQ经典农场";
const QQ_FARM_QUERY_CANDIDATES = buildQqFarmQueryCandidates(QQ_FARM_QUERY);
const QQ_FARM_RESULT_TEXTS = buildQqFarmResultTexts(QQ_FARM_QUERY);
const WECHAT_QQ_FARM_QUERY_PREFIX = process.env.WEIXIN_QQ_FARM_QUERY_PREFIX?.trim() || "QQ";
const WECHAT_QQ_FARM_PINYIN_QUERY = process.env.WEIXIN_QQ_FARM_PINYIN_QUERY?.trim() || "jingdiannongchang";
const LOCAL_COMMAND_STATE_FILE = path.join(homedir(), ".openclaw", "weixin-agent-sdk", "local-command-state.json");
const FAST_CLOCK_SETTINGS_TAB_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_DINGTALK_FAST_CLOCK_SETTINGS_TAB_COORD", { xRatio: 0.833, yRatio: 0.965 });
const FAST_CLOCK_ENTRY_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_DINGTALK_FAST_CLOCK_ENTRY_COORD", { xRatio: 0.5, yRatio: 0.21 });
const FAST_CLOCK_MORNING_SWITCH_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_DINGTALK_FAST_CLOCK_MORNING_SWITCH_COORD", { xRatio: 0.93, yRatio: 0.547 });
const FAST_CLOCK_EVENING_SWITCH_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_DINGTALK_FAST_CLOCK_EVENING_SWITCH_COORD", { xRatio: 0.93, yRatio: 0.698 });
const ANDROID_DINGTALK_ATTENDANCE_ENTRY_POINT = resolveOptionalPointRatioEnv("WEIXIN_ANDROID_DINGTALK_ATTENDANCE_ENTRY_COORD");
const ANDROID_DINGTALK_MORNING_PUNCH_POINT = resolveOptionalPointRatioEnv("WEIXIN_ANDROID_DINGTALK_MORNING_PUNCH_COORD");
const ANDROID_DINGTALK_EVENING_PUNCH_POINT = resolveOptionalPointRatioEnv("WEIXIN_ANDROID_DINGTALK_EVENING_PUNCH_COORD");
const ANDROID_DINGTALK_GENERIC_PUNCH_POINT = resolveOptionalPointRatioEnv("WEIXIN_ANDROID_DINGTALK_GENERIC_PUNCH_COORD");
const WECHAT_SEARCH_ICON_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_WECHAT_SEARCH_ICON_COORD", { xRatio: 0.225722, yRatio: 0.04626 });
const WECHAT_SEARCH_INPUT_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_WECHAT_SEARCH_INPUT_COORD", { xRatio: 0.4101, yRatio: 0.03297 });
const WECHAT_KEYBOARD_LANG_TOGGLE_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_WECHAT_KEYBOARD_LANG_TOGGLE_COORD", { xRatio: 0.91207, yRatio: 0.95817 });
const WECHAT_QQ_FARM_QUERY_SUGGESTION_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_QUERY_SUGGESTION_COORD", { xRatio: 0.42979, yRatio: 0.39862 });
const WECHAT_QQ_FARM_FORWARD_BUTTON_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_FORWARD_COORD", { xRatio: 0.74803, yRatio: 0.58071 });
const WECHAT_QQ_FARM_RESULT_ROW_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_RESULT_ROW_COORD", { xRatio: 0.254, yRatio: 0.579 });
const WECHAT_QQ_FARM_RESULT_ICON_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_RESULT_ICON_COORD", { xRatio: 0.094, yRatio: 0.579 });
const WECHAT_QQ_FARM_RESULT_BANNER_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_RESULT_BANNER_COORD", { xRatio: 0.446, yRatio: 0.406 });
const WECHAT_QQ_FARM_QUICK_ENTRY_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_QUICK_ENTRY_COORD", { xRatio: 0.03937, yRatio: 0.42077 });
const WECHAT_QQ_FARM_QUICK_ENTRY_GOLD_POINT = { xRatio: 0.03937, yRatio: 0.42077 };
const WECHAT_QQ_FARM_QUICK_ENTRY_BLUE_POINT = { xRatio: 0.03051, yRatio: 0.38927 };
const WECHAT_QQ_FARM_QUICK_ENTRY_SKY_POINT = { xRatio: 0.03937, yRatio: 0.45226 };
const QQ_FARM_POPUP_CLOSE_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_POPUP_CLOSE_COORD", { xRatio: 0.68504, yRatio: 0.10236 });
const QQ_FARM_POPUP_EMPTY_DISMISS_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_POPUP_EMPTY_DISMISS_COORD", { xRatio: 0.82021, yRatio: 0.81102 });
const QQ_FARM_ONE_KEY_HARVEST_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_ONE_KEY_HARVEST_COORD", { xRatio: 0.49934, yRatio: 0.74606 });
const QQ_FARM_FRIEND_ENTRY_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_FRIEND_ENTRY_COORD", { xRatio: 0.96457, yRatio: 0.94094 });
const QQ_FARM_FRIEND_FIRST_VISIT_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_FRIEND_FIRST_VISIT_COORD", { xRatio: 0.63386, yRatio: 0.30955 });
const QQ_FARM_FRIEND_ONE_KEY_STEAL_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_FRIEND_ONE_KEY_STEAL_COORD", { xRatio: 0.49705, yRatio: 0.73819 });
const QQ_FARM_STORE_ENTRY_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_STORE_ENTRY_COORD", { xRatio: 0.10533, yRatio: 0.963 });
const QQ_FARM_STORE_CLOSE_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_STORE_CLOSE_COORD", { xRatio: 0.66767, yRatio: 0.0725 });
const QQ_FARM_PLOT_TOP_POINT = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_PLOT_TOP_COORD", { xRatio: 0.53867, yRatio: 0.516 });
const QQ_FARM_PLOT_DOWN_LEFT_VECTOR = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_PLOT_DOWN_LEFT_VECTOR", { xRatio: -0.03067, yRatio: 0.0235 });
const QQ_FARM_PLOT_DOWN_RIGHT_VECTOR = resolvePointRatioEnv("WEIXIN_ANDROID_QQ_FARM_PLOT_DOWN_RIGHT_VECTOR", { xRatio: 0.03033, yRatio: 0.0235 });
const QQ_FARM_PLOT_SAMPLE_HALF_WIDTH_RATIO = Number.parseFloat(
  process.env.WEIXIN_ANDROID_QQ_FARM_PLOT_SAMPLE_HALF_WIDTH_RATIO ?? "0.018",
);
const QQ_FARM_PLOT_SAMPLE_HALF_HEIGHT_RATIO = Number.parseFloat(
  process.env.WEIXIN_ANDROID_QQ_FARM_PLOT_SAMPLE_HALF_HEIGHT_RATIO ?? "0.014",
);
const QQ_FARM_PLOT_ROWS = Number.parseInt(process.env.WEIXIN_ANDROID_QQ_FARM_PLOT_ROWS ?? "4", 10);
const QQ_FARM_PLOT_COLUMNS = Number.parseInt(process.env.WEIXIN_ANDROID_QQ_FARM_PLOT_COLUMNS ?? "4", 10);
const QQ_FARM_SEED_CHOOSER_DELAY_MS = Number.parseInt(
  process.env.WEIXIN_ANDROID_QQ_FARM_SEED_CHOOSER_DELAY_MS ?? "700",
  10,
);
const QQ_FARM_POST_PLANT_DELAY_MS = Number.parseInt(
  process.env.WEIXIN_ANDROID_QQ_FARM_POST_PLANT_DELAY_MS ?? "900",
  10,
);
const QQ_FARM_BATCH_SWIPE_DURATION_MS = Number.parseInt(
  process.env.WEIXIN_ANDROID_QQ_FARM_BATCH_SWIPE_DURATION_MS ?? "650",
  10,
);
const QQ_FARM_BATCH_MIN_PLOTS = Number.parseInt(
  process.env.WEIXIN_ANDROID_QQ_FARM_BATCH_MIN_PLOTS ?? "3",
  10,
);
const QQ_FARM_BATCH_DRAG_OVERSHOOT_STEPS = Number.parseFloat(
  process.env.WEIXIN_ANDROID_QQ_FARM_BATCH_DRAG_OVERSHOOT_STEPS ?? "0.35",
);
const QQ_FARM_BATCH_TOUCH_HOLD_MS = Number.parseInt(
  process.env.WEIXIN_ANDROID_QQ_FARM_BATCH_TOUCH_HOLD_MS ?? "160",
  10,
);
const QQ_FARM_BATCH_TOUCH_MOVE_DELAY_MS = Number.parseInt(
  process.env.WEIXIN_ANDROID_QQ_FARM_BATCH_TOUCH_MOVE_DELAY_MS ?? "130",
  10,
);
const QQ_FARM_SINGLE_PLANT_DELAY_MS = Number.parseInt(
  process.env.WEIXIN_ANDROID_QQ_FARM_SINGLE_PLANT_DELAY_MS ?? "450",
  10,
);
const QQ_FARM_PLOT_TYPE_TEXTS = ["黑土地", "红土地", "金土地", "紫土地", "普通土地"];
const QQ_FARM_STORE_VISIBLE_MAX_Y_RATIO = Number.parseFloat(
  process.env.WEIXIN_ANDROID_QQ_FARM_STORE_VISIBLE_MAX_Y_RATIO ?? "0.84",
);
const QQ_FARM_STEAL_RUN_DELAY_MS = Number.parseInt(process.env.WEIXIN_QQ_FARM_STEAL_RUN_DELAY_MS ?? "4000", 10);
const QQ_FARM_POST_OPEN_DELAY_MS = Number.parseInt(process.env.WEIXIN_QQ_FARM_POST_OPEN_DELAY_MS ?? "2500", 10);
const QQ_FARM_FRIEND_PAGE_DELAY_MS = Number.parseInt(process.env.WEIXIN_QQ_FARM_FRIEND_PAGE_DELAY_MS ?? "2500", 10);
const DEFAULT_IOS_QQ_FARM_RESULT_COORD = JSON.stringify({ xRatio: 0.5, yRatio: 0.24 });
const IOS_QQ_FARM_RESULT_COORD =
  process.env.WEIXIN_IOS_QQ_FARM_RESULT_COORD?.trim() || DEFAULT_IOS_QQ_FARM_RESULT_COORD;
const IOS_AUTOMATION_SCRIPT_PATH = path.resolve(process.cwd(), "../../scripts/ios/run-action.mjs");
const CLEAR_ANDROID_DINGTALK_AFTER_CLOCK_IN = resolveBooleanEnv(
  [
    process.env.WEIXIN_ANDROID_CLEAR_DINGTALK_AFTER_CLOCK_IN,
    process.env.WEIXIN_CLEAR_DINGTALK_AFTER_CLOCK_IN,
  ],
  true,
);
const CLEAR_ANDROID_RECENT_APPS_AFTER_CLOCK_IN = resolveBooleanEnv(
  [
    process.env.WEIXIN_ANDROID_CLEAR_RECENT_APPS_AFTER_CLOCK_IN,
    process.env.WEIXIN_CLEAR_RECENT_APPS_AFTER_CLOCK_IN,
  ],
  true,
);

function buildDefaultIosAutomationCommand(action: string): string | undefined {
  if (!existsSync(IOS_AUTOMATION_SCRIPT_PATH)) {
    return undefined;
  }
  return `node ${JSON.stringify(IOS_AUTOMATION_SCRIPT_PATH)} ${action}`;
}

const IOS_DINGTALK_CLOCK_IN_COMMAND =
  process.env.WEIXIN_IOS_DINGTALK_CLOCK_IN_COMMAND?.trim() ??
  buildDefaultIosAutomationCommand("dingtalk-clock-in");
const IOS_QQ_FARM_COMMAND =
  process.env.WEIXIN_IOS_QQ_FARM_COMMAND?.trim() ??
  buildDefaultIosAutomationCommand("qq-farm");
const IOS_EXIT_DINGTALK_COMMAND =
  process.env.WEIXIN_IOS_EXIT_DINGTALK_COMMAND?.trim() ??
  buildDefaultIosAutomationCommand("exit-dingtalk");

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

type DevicePlatform = "android" | "ios";

type ConnectedDevice = {
  platform: DevicePlatform;
  id: string;
  name: string;
};

type LocalCommandState = {
  fastClockVerifiedAt?: string;
};

type XcDeviceEntry = {
  available?: boolean;
  identifier?: string;
  name?: string;
  platform?: string;
  simulator?: boolean;
};

type SystemProfilerUsbItem = {
  _items?: SystemProfilerUsbItem[];
  _name?: string;
  device_name?: string;
  manufacturer?: string;
  product_name?: string;
  serial_num?: string;
  serial_num_truncated?: string;
};

function resolveBooleanEnv(values: Array<string | undefined>, defaultValue: boolean): boolean {
  for (const rawValue of values) {
    const normalized = rawValue?.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (["1", "true", "on", "yes"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "off", "no"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

function log(message: string): void {
  console.log(`[local-command] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadLocalCommandState(): Promise<LocalCommandState> {
  try {
    const content = await readFile(LOCAL_COMMAND_STATE_FILE, "utf8");
    return JSON.parse(content) as LocalCommandState;
  } catch {
    return {};
  }
}

async function saveLocalCommandState(state: LocalCommandState): Promise<void> {
  await mkdir(path.dirname(LOCAL_COMMAND_STATE_FILE), { recursive: true });
  await writeFile(LOCAL_COMMAND_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function commandString(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function runCommand(
  command: string,
  args: string[],
  opts?: {
    allowNonZero?: boolean;
    env?: Record<string, string>;
  },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
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

async function runShellCommand(
  command: string,
  opts?: {
    allowNonZero?: boolean;
    env?: Record<string, string>;
  },
): Promise<CommandResult> {
  return await runCommand(process.env.SHELL || "zsh", ["-lc", command], opts);
}

function isMissingCommandError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code === "ENOENT";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENOENT");
}

function normalizePlatform(value: string | undefined): DevicePlatform | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "android") {
    return "android";
  }
  if (normalized === "ios" || normalized === "iphone") {
    return "ios";
  }
  throw new Error(`不支持的设备平台 ${value}，请使用 android 或 ios`);
}

function isIosPlatformName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return (
    normalized.includes("iphone") ||
    normalized.includes("ipad") ||
    normalized.includes("ipod") ||
    normalized.includes("iphoneos") ||
    normalized.includes("ios")
  );
}

function extractJsonArray(raw: string): string | undefined {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  return raw.slice(start, end + 1);
}

async function listAndroidDevices(): Promise<ConnectedDevice[]> {
  const preferred = process.env.WEIXIN_DINGTALK_DEVICE_ID?.trim();
  const result = await runCommand("adb", ["devices", "-l"]);
  const deviceLines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached"));

  const devices = deviceLines
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0] && parts[1] === "device")
    .map((parts) => ({
      platform: "android" as const,
      id: parts[0],
      name: parts[0],
    }));

  if (preferred) {
    if (!devices.some((device) => device.id === preferred)) {
      throw new Error(`未找到指定设备 ${preferred}`);
    }
  }

  return devices;
}

async function listIosDevicesViaXcdevice(): Promise<ConnectedDevice[]> {
  try {
    const result = await runCommand("xcrun", ["xcdevice", "list", "--timeout", "5"], {
      allowNonZero: true,
    });
    if (result.exitCode !== 0) {
      return [];
    }

    const json = extractJsonArray(result.stdout);
    if (!json) {
      return [];
    }

    const entries = JSON.parse(json) as XcDeviceEntry[];
    return entries
      .filter((entry) =>
        entry.simulator !== true &&
        entry.available !== false &&
        typeof entry.identifier === "string" &&
        entry.identifier.trim() &&
        isIosPlatformName(entry.platform),
      )
      .map((entry) => ({
        platform: "ios" as const,
        id: entry.identifier!.trim(),
        name: entry.name?.trim() || entry.identifier!.trim(),
      }));
  } catch (error) {
    if (isMissingCommandError(error)) {
      return [];
    }
    return [];
  }
}

async function listIosDevicesViaXctrace(): Promise<ConnectedDevice[]> {
  try {
    const result = await runCommand("xcrun", ["xctrace", "list", "devices"], {
      allowNonZero: true,
    });
    if (result.exitCode !== 0) {
      return [];
    }

    const devices: ConnectedDevice[] = [];
    let inPhysicalDevicesSection = false;

    for (const rawLine of result.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (line === "== Devices ==") {
        inPhysicalDevicesSection = true;
        continue;
      }
      if (line.startsWith("== ") && line !== "== Devices ==") {
        inPhysicalDevicesSection = false;
        continue;
      }
      if (!inPhysicalDevicesSection || line.includes("(Simulator)")) {
        continue;
      }

      const match = line.match(/^(.*)\s+\(([^()]*)\)\s+\(([0-9A-Fa-f-]+)\)$/);
      if (!match) {
        continue;
      }

      const [, name, osOrModel, id] = match;
      if (!isIosPlatformName(`${name} ${osOrModel}`)) {
        continue;
      }

      devices.push({
        platform: "ios",
        id: id.trim(),
        name: name.trim(),
      });
    }

    return devices;
  } catch (error) {
    if (isMissingCommandError(error)) {
      return [];
    }
    return [];
  }
}

async function listIosDevicesViaIdeviceId(): Promise<ConnectedDevice[]> {
  try {
    const result = await runCommand("idevice_id", ["-l"], {
      allowNonZero: true,
    });
    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((id) => ({
        platform: "ios" as const,
        id,
        name: id,
      }));
  } catch (error) {
    if (isMissingCommandError(error)) {
      return [];
    }
    return [];
  }
}

function collectSystemProfilerUsbItems(
  items: SystemProfilerUsbItem[] | undefined,
  output: SystemProfilerUsbItem[] = [],
): SystemProfilerUsbItem[] {
  if (!items) {
    return output;
  }

  for (const item of items) {
    output.push(item);
    collectSystemProfilerUsbItems(item._items, output);
  }

  return output;
}

function looksLikeIosUsbDevice(item: SystemProfilerUsbItem): boolean {
  const haystack = [
    item._name,
    item.device_name,
    item.product_name,
    item.manufacturer,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    haystack.includes("iphone") ||
    haystack.includes("ipad") ||
    haystack.includes("ipod")
  );
}

async function listIosDevicesViaSystemProfiler(): Promise<ConnectedDevice[]> {
  try {
    const result = await runCommand("system_profiler", ["SPUSBDataType", "-json"], {
      allowNonZero: true,
    });
    if (result.exitCode !== 0) {
      return [];
    }

    const parsed = JSON.parse(result.stdout) as {
      SPUSBDataType?: SystemProfilerUsbItem[];
    };
    const usbItems = collectSystemProfilerUsbItems(parsed.SPUSBDataType);

    return usbItems
      .filter(looksLikeIosUsbDevice)
      .map((item) => ({
        platform: "ios" as const,
        id: item.serial_num?.trim() || item.serial_num_truncated?.trim() || item._name?.trim() || "ios-usb-device",
        name: item.device_name?.trim() || item.product_name?.trim() || item._name?.trim() || "iPhone",
      }));
  } catch {
    return [];
  }
}

function dedupeDevices(devices: ConnectedDevice[]): ConnectedDevice[] {
  const seen = new Set<string>();
  const deduped: ConnectedDevice[] = [];
  for (const device of devices) {
    const key = `${device.platform}:${device.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(device);
  }
  return deduped;
}

async function listIosDevices(): Promise<ConnectedDevice[]> {
  const preferred = process.env.WEIXIN_IOS_DEVICE_ID?.trim();
  const devices = dedupeDevices([
    ...(await listIosDevicesViaXcdevice()),
    ...(await listIosDevicesViaXctrace()),
    ...(await listIosDevicesViaIdeviceId()),
    ...(await listIosDevicesViaSystemProfiler()),
  ]);

  if (preferred) {
    if (!devices.some((device) => device.id === preferred)) {
      throw new Error(`未找到指定的 iOS 设备 ${preferred}`);
    }
  }

  return devices;
}

function pickPreferredDevice(devices: ConnectedDevice[], opts: {
  preferredId?: string;
  missingMessage: string;
}): ConnectedDevice {
  if (devices.length === 0) {
    throw new Error(opts.missingMessage);
  }

  if (opts.preferredId) {
    const preferred = devices.find((device) => device.id === opts.preferredId);
    if (!preferred) {
      throw new Error(`未找到指定设备 ${opts.preferredId}`);
    }
    return preferred;
  }

  return devices[0];
}

async function resolveAndroidDevice(): Promise<ConnectedDevice> {
  return pickPreferredDevice(await listAndroidDevices(), {
    preferredId: process.env.WEIXIN_DINGTALK_DEVICE_ID?.trim(),
    missingMessage: "未检测到 adb 设备",
  });
}

async function resolveIosDevice(): Promise<ConnectedDevice> {
  return pickPreferredDevice(await listIosDevices(), {
    preferredId: process.env.WEIXIN_IOS_DEVICE_ID?.trim(),
    missingMessage: "未检测到可用的 iOS 设备",
  });
}

async function shellCommandExists(commandName: string): Promise<boolean> {
  const result = await runShellCommand(`command -v ${commandName} >/dev/null 2>&1`, {
    allowNonZero: true,
  });
  return result.exitCode === 0;
}

async function hasFullXcodeDeviceTools(): Promise<boolean> {
  const xcdevice = await runCommand("xcrun", ["--find", "xcdevice"], {
    allowNonZero: true,
  }).catch(() => ({ exitCode: 1 }));
  const xctrace = await runCommand("xcrun", ["--find", "xctrace"], {
    allowNonZero: true,
  }).catch(() => ({ exitCode: 1 }));
  return xcdevice.exitCode === 0 || xctrace.exitCode === 0;
}

async function resolveNoDeviceErrorMessage(): Promise<string> {
  const hints: string[] = [];
  const [hasAdb, hasIdeviceId, hasXcodeTools, usbIosDevices] = await Promise.all([
    shellCommandExists("adb"),
    shellCommandExists("idevice_id"),
    hasFullXcodeDeviceTools(),
    listIosDevicesViaSystemProfiler(),
  ]);

  if (!hasAdb) {
    hints.push("未安装 adb（Android 检测与控制不可用）");
  }
  if (!hasIdeviceId && !hasXcodeTools) {
    hints.push("未安装 iPhone 检测工具（需完整 Xcode 或 libimobiledevice）");
  }
  if (usbIosDevices.length === 0) {
    hints.push("当前没有检测到已连接的 USB iPhone/iPad");
  }

  if (hints.length === 0) {
    return "未检测到可用设备，请连接 Android adb 设备或 iPhone 设备";
  }

  return `未检测到可用设备。${hints.join("；")}。`;
}

async function resolveConnectedDevice(): Promise<ConnectedDevice> {
  const preferredPlatform = normalizePlatform(process.env.WEIXIN_DEVICE_PLATFORM);
  if (preferredPlatform === "android") {
    return await resolveAndroidDevice();
  }
  if (preferredPlatform === "ios") {
    return await resolveIosDevice();
  }

  const androidDevices = await listAndroidDevices().catch((error) => {
    if (isMissingCommandError(error)) {
      return [];
    }
    throw error;
  });
  const iosDevices = await listIosDevices();

  if (androidDevices.length > 0 && iosDevices.length > 0) {
    throw new Error(
      "同时检测到 Android 和 iOS 设备，请设置 WEIXIN_DEVICE_PLATFORM=android 或 WEIXIN_DEVICE_PLATFORM=ios",
    );
  }
  if (androidDevices.length > 0) {
    return androidDevices[0];
  }
  if (iosDevices.length > 0) {
    return iosDevices[0];
  }

  throw new Error(await resolveNoDeviceErrorMessage());
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

function pointFromRatio(width: number, height: number, point: { xRatio: number; yRatio: number }): { x: number; y: number } {
  return {
    x: Math.round(width * point.xRatio),
    y: Math.round(height * point.yRatio),
  };
}

function addPointRatios(base: PointRatio, left: PointRatio, leftSteps: number, right: PointRatio, rightSteps: number): PointRatio {
  return {
    xRatio: base.xRatio + left.xRatio * leftSteps + right.xRatio * rightSteps,
    yRatio: base.yRatio + left.yRatio * leftSteps + right.yRatio * rightSteps,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildQqFarmPlotRatios(): Array<Pick<QqFarmPlot, "row" | "column" | "screenRow" | "xRatio" | "yRatio">> {
  const plots: Array<Pick<QqFarmPlot, "row" | "column" | "screenRow" | "xRatio" | "yRatio">> = [];
  for (let row = 0; row < QQ_FARM_PLOT_ROWS; row += 1) {
    for (let column = 0; column < QQ_FARM_PLOT_COLUMNS; column += 1) {
      const point = addPointRatios(
        QQ_FARM_PLOT_TOP_POINT,
        QQ_FARM_PLOT_DOWN_LEFT_VECTOR,
        row,
        QQ_FARM_PLOT_DOWN_RIGHT_VECTOR,
        column,
      );
      plots.push({
        row,
        column,
        screenRow: row + column,
        xRatio: point.xRatio,
        yRatio: point.yRatio,
      });
    }
  }
  return plots;
}

function detectQqFarmPlotStateFromPng(
  png: PNG,
  point: { x: number; y: number },
): QqFarmPlotState {
  const halfWidth = Math.max(8, Math.round(png.width * QQ_FARM_PLOT_SAMPLE_HALF_WIDTH_RATIO));
  const halfHeight = Math.max(6, Math.round(png.height * QQ_FARM_PLOT_SAMPLE_HALF_HEIGHT_RATIO));
  let emptyPixels = 0;
  let ripePixels = 0;
  let growingPixels = 0;
  let lockedPixels = 0;
  let sampled = 0;

  for (let offsetY = -halfHeight; offsetY <= halfHeight; offsetY += 1) {
    for (let offsetX = -halfWidth; offsetX <= halfWidth; offsetX += 1) {
      if (Math.abs(offsetX) / halfWidth + Math.abs(offsetY) / halfHeight > 1) {
        continue;
      }

      const x = Math.max(0, Math.min(png.width - 1, point.x + offsetX));
      const y = Math.max(0, Math.min(png.height - 1, point.y + offsetY));
      const index = (y * png.width + x) * 4;
      const a = png.data[index + 3];
      if (a < 180) {
        continue;
      }

      const r = png.data[index];
      const g = png.data[index + 1];
      const b = png.data[index + 2];
      sampled += 1;

      if (r >= 170 && g >= 135 && b < 120 && r - g < 60) {
        ripePixels += 1;
        continue;
      }
      if (g >= 95 && g > r + 10 && g > b + 8) {
        growingPixels += 1;
        continue;
      }
      if (r >= 40 && r <= 130 && g >= 25 && g <= 110 && b <= 90 && r - g < 35) {
        emptyPixels += 1;
        continue;
      }
      if (
        r >= 110 &&
        g >= 100 &&
        b >= 90 &&
        Math.abs(r - g) < 32 &&
        Math.abs(g - b) < 32
      ) {
        lockedPixels += 1;
      }
    }
  }

  if (sampled === 0) {
    return "unknown";
  }

  const emptyRatio = emptyPixels / sampled;
  const ripeRatio = ripePixels / sampled;
  const growingRatio = growingPixels / sampled;
  const lockedRatio = lockedPixels / sampled;

  if (ripeRatio >= 0.45) {
    return "ripe";
  }
  if (emptyRatio >= 0.3) {
    return "empty";
  }
  if (growingRatio >= 0.28) {
    return "growing";
  }
  if (lockedRatio >= 0.35) {
    return "locked";
  }
  return "unknown";
}

function detectQqFarmPlotsFromPng(png: PNG): QqFarmPlot[] {
  return buildQqFarmPlotRatios().map((plot) => {
    const center = pointFromRatio(png.width, png.height, plot);
    return {
      ...plot,
      x: center.x,
      y: center.y,
      state: detectQqFarmPlotStateFromPng(png, center),
    };
  });
}

function formatQqFarmPlot(plot: QqFarmPlot): string {
  return `r${plot.row + 1}c${plot.column + 1}`;
}

function compareQqFarmPlotsTopRightFirst(left: Pick<QqFarmPlot, "row" | "column">, right: Pick<QqFarmPlot, "row" | "column">): number {
  return left.row - right.row || right.column - left.column;
}

function groupQqFarmPlotsForBatch(plots: QqFarmPlot[], family: QqFarmBatchFamily): QqFarmBatchCandidate[] {
  const grouped = new Map<number, QqFarmPlot[]>();
  for (const plot of plots) {
    const key = family === "screenRow" ? plot.screenRow : family === "row" ? plot.row : plot.column;
    const familyPlots = grouped.get(key) ?? [];
    familyPlots.push(plot);
    grouped.set(key, familyPlots);
  }

  return [...grouped.entries()]
    .map(([key, familyPlots]) => ({
      family,
      key,
      plots: familyPlots,
    }))
    .filter((candidate) => candidate.plots.length >= QQ_FARM_BATCH_MIN_PLOTS);
}

function buildQqFarmBatchCandidates(plots: QqFarmPlot[]): QqFarmBatchCandidate[] {
  return (["screenRow", "row", "column"] as const)
    .flatMap((family) => groupQqFarmPlotsForBatch(plots, family))
    .sort((left, right) => {
      const leftFirstPlot = [...left.plots].sort(compareQqFarmPlotsTopRightFirst)[0];
      const rightFirstPlot = [...right.plots].sort(compareQqFarmPlotsTopRightFirst)[0];
      return (
        compareQqFarmPlotsTopRightFirst(leftFirstPlot, rightFirstPlot) ||
        right.plots.length - left.plots.length ||
        (left.family === right.family ? left.key - right.key : left.family.localeCompare(right.family))
      );
    });
}

function buildQqFarmBatchPath(candidate: QqFarmBatchCandidate): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const sortedPlots = [...candidate.plots].sort(compareQqFarmPlotsTopRightFirst);

  const first = sortedPlots[0];
  const last = sortedPlots[sortedPlots.length - 1];
  const stepCount = Math.max(1, sortedPlots.length - 1);
  const stepX = (last.x - first.x) / stepCount;
  const stepY = (last.y - first.y) / stepCount;

  return {
    from: {
      x: Math.round(clampNumber(first.x - stepX * QQ_FARM_BATCH_DRAG_OVERSHOOT_STEPS, 1, Number.MAX_SAFE_INTEGER)),
      y: Math.round(clampNumber(first.y - stepY * QQ_FARM_BATCH_DRAG_OVERSHOOT_STEPS, 1, Number.MAX_SAFE_INTEGER)),
    },
    to: {
      x: Math.round(clampNumber(last.x + stepX * QQ_FARM_BATCH_DRAG_OVERSHOOT_STEPS, 1, Number.MAX_SAFE_INTEGER)),
      y: Math.round(clampNumber(last.y + stepY * QQ_FARM_BATCH_DRAG_OVERSHOOT_STEPS, 1, Number.MAX_SAFE_INTEGER)),
    },
  };
}

function buildQqFarmBatchTouchPath(
  seedChoice: QqFarmSeedChoice,
  candidate: QqFarmBatchCandidate,
): Array<{ x: number; y: number }> {
  const sortedPlots = [...candidate.plots].sort(compareQqFarmPlotsTopRightFirst);

  const { to } = buildQqFarmBatchPath(candidate);
  return [
    { x: seedChoice.dragX, y: seedChoice.dragY },
    ...sortedPlots.map((plot) => ({ x: plot.x, y: plot.y })),
    to,
  ];
}

function describeQqFarmBatchCandidate(candidate: QqFarmBatchCandidate): string {
  return `${candidate.family}:${candidate.key}(${candidate.plots.map((plot) => formatQqFarmPlot(plot)).join(",")})`;
}

function describeQqFarmPlots(plots: QqFarmPlot[]): string {
  const counts = plots.reduce<Record<QqFarmPlotState, number>>(
    (acc, plot) => {
      acc[plot.state] += 1;
      return acc;
    },
    { empty: 0, ripe: 0, growing: 0, locked: 0, unknown: 0 },
  );
  return `空地 ${counts.empty} 块，成熟 ${counts.ripe} 块，生长中 ${counts.growing} 块，锁定 ${counts.locked} 块`;
}

function parsePositiveIntegerText(raw: string): number | undefined {
  const normalized = raw.replace(/[^\d]/g, "");
  if (!normalized) {
    return undefined;
  }
  const value = Number.parseInt(normalized, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function findAvailableSeedChoice(
  blocks: Awaited<ReturnType<typeof recognizeTextBlocks>>,
  png: PNG,
): QqFarmSeedChoice | undefined {
  const candidates = blocks
    .map((block) => ({
      block,
      count: parsePositiveIntegerText(block.text),
    }))
    .filter(
      (
        entry,
      ): entry is {
        block: NonNullable<Awaited<ReturnType<typeof recognizeTextBlocks>>>[number];
        count: number;
      } =>
        typeof entry.count === "number" &&
        entry.block.centerY >= png.height * 0.58 &&
        entry.block.centerY <= png.height * 0.82 &&
        entry.block.centerX >= png.width * 0.2 &&
        entry.block.centerX <= png.width * 0.92,
    )
    .sort((left, right) => right.block.centerX - left.block.centerX || right.count - left.count);

  const selected = candidates[0];
  if (!selected) {
    return undefined;
  }

  return {
    x: selected.block.centerX,
    y: Math.min(png.height - 1, selected.block.centerY + Math.round(png.height * 0.022)),
    dragX: Math.max(0, selected.block.centerX - Math.round(png.width * 0.02)),
    dragY: Math.min(png.height - 1, selected.block.centerY + Math.round(png.height * 0.035)),
    count: selected.count,
  };
}

function resolveAndroidPunchPoint(slotId: ClockInSlotId | undefined): PointRatio | undefined {
  if (slotId === "morning") {
    return ANDROID_DINGTALK_MORNING_PUNCH_POINT ?? ANDROID_DINGTALK_GENERIC_PUNCH_POINT;
  }
  if (slotId === "evening") {
    return ANDROID_DINGTALK_EVENING_PUNCH_POINT ?? ANDROID_DINGTALK_GENERIC_PUNCH_POINT;
  }
  return ANDROID_DINGTALK_GENERIC_PUNCH_POINT;
}

function isBlueSwitchEnabledInScreenshot(
  pngBuffer: Buffer,
  point: { xRatio: number; yRatio: number },
): boolean {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const center = pointFromRatio(width, height, point);
  const halfWidth = Math.max(24, Math.round(width * 0.025));
  const halfHeight = Math.max(20, Math.round(height * 0.018));
  let bluePixels = 0;
  let sampled = 0;

  for (let y = Math.max(0, center.y - halfHeight); y <= Math.min(height - 1, center.y + halfHeight); y += 1) {
    for (let x = Math.max(0, center.x - halfWidth); x <= Math.min(width - 1, center.x + halfWidth); x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha < 180) {
        continue;
      }
      const { h, s, v } = rgbToHsv(data[index], data[index + 1], data[index + 2]);
      sampled += 1;
      if (h >= 190 && h <= 235 && s >= 0.35 && v >= 0.5) {
        bluePixels += 1;
      }
    }
  }

  return sampled > 0 && bluePixels / sampled >= 0.18;
}

function readPixelAtRatio(
  pngBuffer: Buffer,
  point: { xRatio: number; yRatio: number },
): { r: number; g: number; b: number; a: number } {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const center = pointFromRatio(width, height, point);
  const x = Math.max(0, Math.min(width - 1, center.x));
  const y = Math.max(0, Math.min(height - 1, center.y));
  const index = (y * width + x) * 4;
  return {
    r: data[index],
    g: data[index + 1],
    b: data[index + 2],
    a: data[index + 3],
  };
}

function isQqFarmQuickEntryVisible(pngBuffer: Buffer): boolean {
  const gold = readPixelAtRatio(pngBuffer, WECHAT_QQ_FARM_QUICK_ENTRY_GOLD_POINT);
  const blue = readPixelAtRatio(pngBuffer, WECHAT_QQ_FARM_QUICK_ENTRY_BLUE_POINT);
  const sky = readPixelAtRatio(pngBuffer, WECHAT_QQ_FARM_QUICK_ENTRY_SKY_POINT);

  const looksLikeGold = gold.r >= 220 && gold.g >= 180 && gold.b <= 150;
  const looksLikeBlue = blue.b >= 180 && blue.g >= 180 && blue.r <= 230;
  const looksLikeSky = sky.b >= 220 && sky.g >= 220 && sky.r <= 240;
  return looksLikeGold && looksLikeBlue && looksLikeSky;
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

async function waitForPortraitScreenshot(deviceId: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const screenshot = await captureScreen(deviceId);
    const png = PNG.sync.read(screenshot);
    if (png.height >= png.width) {
      return screenshot;
    }
    await sleep(500);
  }

  throw new Error("考勤页面未能切换到竖屏，无法继续极速打卡初始化");
}

async function tap(deviceId: string, x: number, y: number): Promise<void> {
  log(`tap (${x}, ${y})`);
  await adb(deviceId, ["shell", "input", "tap", String(x), String(y)]);
}

async function swipe(
  deviceId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 250,
): Promise<void> {
  log(`swipe (${from.x}, ${from.y}) -> (${to.x}, ${to.y}) duration=${durationMs}`);
  await adb(deviceId, [
    "shell",
    "input",
    "swipe",
    String(from.x),
    String(from.y),
    String(to.x),
    String(to.y),
    String(durationMs),
  ]);
}

async function dragAndDrop(
  deviceId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 650,
): Promise<void> {
  log(`draganddrop (${from.x}, ${from.y}) -> (${to.x}, ${to.y}) duration=${durationMs}`);
  try {
    await adb(deviceId, [
      "shell",
      "input",
      "draganddrop",
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(durationMs),
    ]);
  } catch (error) {
    log(`draganddrop failed, falling back to swipe: ${(error as Error).message}`);
    await swipe(deviceId, from, to, durationMs);
  }
}

async function motionEvent(deviceId: string, action: "DOWN" | "MOVE" | "UP" | "CANCEL", point: { x: number; y: number }): Promise<void> {
  log(`motionevent ${action} (${point.x}, ${point.y})`);
  await adb(deviceId, ["shell", "input", "motionevent", action, String(point.x), String(point.y)]);
}

async function traceTouchPath(deviceId: string, points: Array<{ x: number; y: number }>): Promise<void> {
  if (points.length < 2) {
    throw new Error("touch path 至少需要两个点");
  }

  const [firstPoint, ...restPoints] = points;
  await motionEvent(deviceId, "DOWN", firstPoint);
  await sleep(QQ_FARM_BATCH_TOUCH_HOLD_MS);
  for (const point of restPoints) {
    await motionEvent(deviceId, "MOVE", point);
    await sleep(QQ_FARM_BATCH_TOUCH_MOVE_DELAY_MS);
  }
  await motionEvent(deviceId, "UP", restPoints[restPoints.length - 1]);
}

async function openPackageApp(deviceId: string, packageName: string, appLabel: string): Promise<void> {
  log(`opening ${appLabel} app: ${packageName}`);
  const resolved = await adb(deviceId, [
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    packageName,
  ], { allowNonZero: true });
  const activity = resolved.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("/"));

  if (activity) {
    await adb(deviceId, ["shell", "am", "start", "-W", "-n", activity]);
    return;
  }

  await adb(deviceId, [
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
}

async function openDingTalkApp(deviceId: string): Promise<void> {
  await openPackageApp(deviceId, DINGTALK_PACKAGE, "DingTalk");
}

async function openWeChatApp(deviceId: string): Promise<void> {
  await openPackageApp(deviceId, WECHAT_PACKAGE, "WeChat");
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
    const openedByOcr = await tryTapTextByOcr(
      deviceId,
      DINGTALK_ATTENDANCE_ENTRY_TEXTS,
      "opening DingTalk attendance entry",
      {
        minYRatio: 0.08,
        maxYRatio: 0.92,
      },
    );
    if (openedByOcr) {
      return;
    }

    const xml = await dumpUi(deviceId);
    const center = findAttendanceEntryCenter(xml);
    if (center) {
      log(`found attendance entry on workbench at attempt=${attempt + 1}`);
      await tap(deviceId, center.x, center.y);
      return;
    }

    if (attempt === 0 && ANDROID_DINGTALK_ATTENDANCE_ENTRY_POINT) {
      await tapCurrentScreenPoint(deviceId, ANDROID_DINGTALK_ATTENDANCE_ENTRY_POINT, "opening DingTalk attendance entry via configured point");
      return;
    }

    const scrollableArea = findScrollableArea(xml);
    if (!scrollableArea) {
      if (ANDROID_DINGTALK_ATTENDANCE_ENTRY_POINT) {
        await tapCurrentScreenPoint(deviceId, ANDROID_DINGTALK_ATTENDANCE_ENTRY_POINT, "opening DingTalk attendance entry via configured point");
        return;
      }
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

async function clickPunchButton(deviceId: string, slot?: ClockInSlotConfig): Promise<void> {
  const slotLabel = slot?.label ?? "当前";
  for (let attempt = 0; attempt < PUNCH_BUTTON_DETECTION_ATTEMPTS; attempt += 1) {
    const screenshot = await captureScreen(deviceId);
    const center = findPunchButtonCenterFromScreenshot(screenshot);
    if (center) {
      log(`found ${slotLabel} punch button via screenshot at (${center.x}, ${center.y})`);
      await tap(deviceId, center.x, center.y);
      return;
    }
    if (attempt < PUNCH_BUTTON_DETECTION_ATTEMPTS - 1) {
      log(`punch button not ready yet, retrying attempt=${attempt + 2}`);
      await sleep(PUNCH_BUTTON_RETRY_DELAY_MS);
    }
  }

  const tappedByOcr = await tryTapTextByOcr(
    deviceId,
    buildPunchTextCandidates(slot),
    `tapping ${slotLabel} punch button`,
    {
      minYRatio: 0.35,
      maxYRatio: 0.95,
    },
  );
  if (tappedByOcr) {
    return;
  }

  const configuredPoint = resolveAndroidPunchPoint(slot?.id);
  if (configuredPoint) {
    await tapCurrentScreenPoint(deviceId, configuredPoint, `tapping configured ${slotLabel} punch point`);
    return;
  }

  throw new Error(`已进入“考勤打卡”页面，但未识别到${slotLabel}打卡按钮`);
}

async function openFastClockSettingsPage(deviceId: string): Promise<void> {
  await openAttendancePageFromWorkbench(deviceId);
  await sleep(FAST_CLOCK_SETUP_DELAY_MS);
  const settingsPageScreenshot = PNG.sync.read(await waitForPortraitScreenshot(deviceId));
  const settingsTabCenter = pointFromRatio(settingsPageScreenshot.width, settingsPageScreenshot.height, FAST_CLOCK_SETTINGS_TAB_POINT);
  log("opening DingTalk attendance settings via bottom settings tab");
  await tap(deviceId, settingsTabCenter.x, settingsTabCenter.y);
  await sleep(FAST_CLOCK_SETUP_DELAY_MS);

  const entryPageScreenshot = PNG.sync.read(await captureScreen(deviceId));
  const fastClockEntryCenter = pointFromRatio(entryPageScreenshot.width, entryPageScreenshot.height, FAST_CLOCK_ENTRY_POINT);
  log("opening DingTalk fast clock page");
  await tap(deviceId, fastClockEntryCenter.x, fastClockEntryCenter.y);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(FAST_CLOCK_PAGE_LOAD_DELAY_MS);
    const xml = await dumpUi(deviceId);
    if (xml.includes('text="极速打卡"')) {
      return;
    }
  }

  throw new Error("未能进入极速打卡页面");
}

async function maybeEnsureFastClockEnabled(deviceId: string): Promise<void> {
  const state = await loadLocalCommandState();
  if (state.fastClockVerifiedAt) {
    return;
  }

  log("first run: verifying DingTalk fast clock settings");
  await openFastClockSettingsPage(deviceId);
  let screenshot = await captureScreen(deviceId);
  const basePng = PNG.sync.read(screenshot);
  const morningSwitchCenter = pointFromRatio(basePng.width, basePng.height, FAST_CLOCK_MORNING_SWITCH_POINT);
  const eveningSwitchCenter = pointFromRatio(basePng.width, basePng.height, FAST_CLOCK_EVENING_SWITCH_POINT);
  let changedAnySetting = false;

  if (!isBlueSwitchEnabledInScreenshot(screenshot, FAST_CLOCK_MORNING_SWITCH_POINT)) {
    log("enabling DingTalk fast clock setting: 上班极速打卡");
    await tap(deviceId, morningSwitchCenter.x, morningSwitchCenter.y);
    await sleep(FAST_CLOCK_SETUP_DELAY_MS);
    changedAnySetting = true;
  }

  screenshot = await captureScreen(deviceId);
  if (!isBlueSwitchEnabledInScreenshot(screenshot, FAST_CLOCK_EVENING_SWITCH_POINT)) {
    log("enabling DingTalk fast clock setting: 下班极速打卡");
    await tap(deviceId, eveningSwitchCenter.x, eveningSwitchCenter.y);
    await sleep(FAST_CLOCK_SETUP_DELAY_MS);
    changedAnySetting = true;
  }

  screenshot = await captureScreen(deviceId);
  if (
    !isBlueSwitchEnabledInScreenshot(screenshot, FAST_CLOCK_MORNING_SWITCH_POINT) ||
    !isBlueSwitchEnabledInScreenshot(screenshot, FAST_CLOCK_EVENING_SWITCH_POINT)
  ) {
    throw new Error("极速打卡开关校验失败，未检测到上班/下班极速打卡均已开启");
  }

  await saveLocalCommandState({
    ...state,
    fastClockVerifiedAt: new Date().toISOString(),
  });
  log("DingTalk fast clock settings were enabled and persisted");
  await exitDingTalk(deviceId);
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

async function readTopResumedActivity(deviceId: string): Promise<string | undefined> {
  const result = await adb(deviceId, ["shell", "dumpsys", "activity", "activities"]);
  const line = result.stdout
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.startsWith("topResumedActivity="));

  const match = line?.match(/u\d+\s+([^ ]+)\s+t\d+\}/);
  return match?.[1];
}

async function waitForTopResumedActivity(
  deviceId: string,
  matcher: (activity: string | undefined) => boolean,
  attempts = 8,
): Promise<string | undefined> {
  let lastActivity: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastActivity = await readTopResumedActivity(deviceId);
    if (matcher(lastActivity)) {
      return lastActivity;
    }
    await sleep(800);
  }
  return lastActivity;
}

function isWeChatAppBrandActivity(activity: string | undefined): boolean {
  if (!activity) {
    return false;
  }

  return (
    activity.includes(`${WECHAT_PACKAGE}/.plugin.appbrand.ui.AppBrandUI`) ||
    activity.includes(`${WECHAT_PACKAGE}/.plugin.appbrand.ui.AppBrandUI1`)
  );
}

async function waitForWeChatAppBrand(deviceId: string): Promise<string | undefined> {
  return await waitForTopResumedActivity(
    deviceId,
    (activity) => isWeChatAppBrandActivity(activity),
  );
}

function isWeChatSearchResultsActivity(activity: string | undefined): boolean {
  if (!activity) {
    return false;
  }

  return (
    activity.includes(`${WECHAT_PACKAGE}/.plugin.webview.ui.tools.fts.MMFTSSOSHomeWebViewUI`) ||
    activity.includes(`${WECHAT_PACKAGE}/.plugin.fts.ui.FTSMainUI`) ||
    activity.includes(`${WECHAT_PACKAGE}/.ui.EmptyActivity`)
  );
}

async function waitForWeChatSearchResultsPage(deviceId: string): Promise<string | undefined> {
  return await waitForTopResumedActivity(
    deviceId,
    (activity) => isWeChatSearchResultsActivity(activity),
    6,
  );
}

async function tryOpenQqFarmQuickEntry(deviceId: string): Promise<boolean> {
  const screenshot = await captureScreen(deviceId);
  if (!isQqFarmQuickEntryVisible(screenshot)) {
    return false;
  }

  const png = PNG.sync.read(screenshot);
  const quickEntryCenter = pointFromRatio(
    png.width,
    png.height,
    WECHAT_QQ_FARM_QUICK_ENTRY_POINT,
  );
  log("opening QQ classic farm mini program from WeChat quick-entry grid");
  await tap(deviceId, quickEntryCenter.x, quickEntryCenter.y);
  const topActivity = await waitForWeChatAppBrand(deviceId);
  return isWeChatAppBrandActivity(topActivity);
}

async function focusWeChatSearchField(deviceId: string): Promise<void> {
  const wechatHomeScreenshot = PNG.sync.read(await captureScreen(deviceId));
  const searchIconCenter = pointFromRatio(
    wechatHomeScreenshot.width,
    wechatHomeScreenshot.height,
    WECHAT_SEARCH_ICON_POINT,
  );
  log("opening WeChat search");
  await tap(deviceId, searchIconCenter.x, searchIconCenter.y);
  await sleep(WECHAT_SEARCH_DELAY_MS);

  // Search focus is flaky on this tablet build, so tap the input itself once.
  const searchScreenshot = PNG.sync.read(await captureScreen(deviceId));
  const searchInputCenter = pointFromRatio(
    searchScreenshot.width,
    searchScreenshot.height,
    WECHAT_SEARCH_INPUT_POINT,
  );
  log("focusing WeChat search input");
  await tap(deviceId, searchInputCenter.x, searchInputCenter.y);
  await sleep(WECHAT_SEARCH_DELAY_MS);
}

async function tryPasteWeChatSearchQuery(deviceId: string, query: string): Promise<boolean> {
  try {
    log(`pasting WeChat search query: ${query}`);
    await adb(deviceId, ["shell", "cmd", "clipboard", "set", "text", query]);
    await sleep(300);
    await adb(deviceId, ["shell", "input", "keyevent", "279"]);
    await sleep(400);
    log("submitting WeChat search");
    await adb(deviceId, ["shell", "input", "keyevent", "66"]);
    await sleep(WECHAT_SEARCH_RESULTS_DELAY_MS);
    return Boolean(await waitForWeChatSearchResultsPage(deviceId));
  } catch (error) {
    log(`pasting WeChat search query failed, falling back to keyboard input: ${(error as Error).message}`);
    return false;
  }
}

async function tapCurrentScreenPoint(
  deviceId: string,
  point: PointRatio,
  description: string,
): Promise<void> {
  const screenshot = PNG.sync.read(await captureScreen(deviceId));
  const center = pointFromRatio(screenshot.width, screenshot.height, point);
  log(description);
  await tap(deviceId, center.x, center.y);
}

function findGreenButtonCentersFromPng(png: PNG): Array<{
  pixelCount: number;
  centerX: number;
  centerY: number;
}> {
  const { width, height, data } = png;
  const visited = new Uint8Array(width * height);
  const minX = Math.floor(width * 0.55);
  const maxX = Math.floor(width * 0.98);
  const minY = Math.floor(height * 0.35);
  const maxY = Math.floor(height * 0.9);
  const minWidth = Math.floor(width * 0.08);
  const minHeight = Math.floor(height * 0.025);
  const centers: Array<{
    pixelCount: number;
    centerX: number;
    centerY: number;
  }> = [];

  const isCandidate = (x: number, y: number): boolean => {
    if (x < minX || x > maxX || y < minY || y > maxY) {
      return false;
    }

    const offset = (y * width + x) * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const a = data[offset + 3];
    return a > 200 && g > 170 && r > 120 && r < 240 && b < 140 && g - r > 8;
  };

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const start = y * width + x;
      if (visited[start] || !isCandidate(x, y)) {
        continue;
      }

      const queue: Array<[number, number]> = [[x, y]];
      visited[start] = 1;
      let minComponentX = x;
      let maxComponentX = x;
      let minComponentY = y;
      let maxComponentY = y;
      let pixelCount = 0;

      while (queue.length > 0) {
        const [currentX, currentY] = queue.pop() as [number, number];
        pixelCount += 1;
        if (currentX < minComponentX) minComponentX = currentX;
        if (currentX > maxComponentX) maxComponentX = currentX;
        if (currentY < minComponentY) minComponentY = currentY;
        if (currentY > maxComponentY) maxComponentY = currentY;

        for (const [nextX, nextY] of [
          [currentX - 1, currentY],
          [currentX + 1, currentY],
          [currentX, currentY - 1],
          [currentX, currentY + 1],
        ] as const) {
          if (nextX < minX || nextX > maxX || nextY < minY || nextY > maxY) {
            continue;
          }
          const nextIndex = nextY * width + nextX;
          if (visited[nextIndex] || !isCandidate(nextX, nextY)) {
            continue;
          }
          visited[nextIndex] = 1;
          queue.push([nextX, nextY]);
        }
      }

      const componentWidth = maxComponentX - minComponentX + 1;
      const componentHeight = maxComponentY - minComponentY + 1;
      if (pixelCount < 500 || componentWidth < minWidth || componentHeight < minHeight) {
        continue;
      }

      centers.push({
        pixelCount,
        centerX: Math.round((minComponentX + maxComponentX) / 2),
        centerY: Math.round((minComponentY + maxComponentY) / 2),
      });
    }
  }

  centers.sort((left, right) => left.centerY - right.centerY || left.centerX - right.centerX);
  return centers;
}

async function detectAndroidFriendVisitButtons(deviceId: string): Promise<Array<{ x: number; y: number; pixelCount: number }>> {
  const png = PNG.sync.read(await captureScreen(deviceId));
  return findGreenButtonCentersFromPng(png).map((center) => ({
    pixelCount: center.pixelCount,
    x: center.centerX,
    y: center.centerY,
  }));
}

async function tryTapTextByOcr(
  deviceId: string,
  candidates: string[],
  description: string,
  opts?: {
    minXRatio?: number;
    maxXRatio?: number;
    minYRatio?: number;
    maxYRatio?: number;
  },
): Promise<boolean> {
  const screenshot = await captureScreen(deviceId);
  const png = PNG.sync.read(screenshot);
  const blocks = await recognizeTextBlocks(screenshot, log);
  if (blocks.length === 0) {
    return false;
  }

  const matched = findOcrTextBlock(blocks, candidates, {
    minX: typeof opts?.minXRatio === "number" ? png.width * opts.minXRatio : undefined,
    maxX: typeof opts?.maxXRatio === "number" ? png.width * opts.maxXRatio : undefined,
    minY: typeof opts?.minYRatio === "number" ? png.height * opts.minYRatio : undefined,
    maxY: typeof opts?.maxYRatio === "number" ? png.height * opts.maxYRatio : undefined,
  });
  if (!matched) {
    return false;
  }

  log(`${description} via OCR: ${matched.text}`);
  await tap(deviceId, matched.centerX, matched.centerY);
  return true;
}

function buildPunchTextCandidates(slot?: ClockInSlotConfig): string[] {
  const slotSpecificTexts =
    slot?.id === "morning"
      ? ["上班打卡", "上班", "极速打卡"]
      : slot?.id === "evening"
        ? ["下班打卡", "下班", "极速打卡"]
        : ["打卡", "极速打卡"];

  return [...new Set([...slotSpecificTexts, "打卡", "极速打卡", "签到"])];
}

async function recognizeQqFarmSceneOnAndroid(deviceId: string): Promise<{
  scene: QqFarmSceneId;
  matchedTexts: string[];
}> {
  const screenshot = await captureScreen(deviceId);
  const blocks = await recognizeTextBlocks(screenshot, log);
  const detection = detectQqFarmScene(blocks);
  return {
    scene: detection.scene,
    matchedTexts: detection.matchedTexts,
  };
}

async function waitForQqFarmSceneOnAndroid(
  deviceId: string,
  attempts = 8,
  delayMs = 1_000,
): Promise<{
  scene: QqFarmSceneId;
  matchedTexts: string[];
}> {
  let detection = await recognizeQqFarmSceneOnAndroid(deviceId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (detection.scene !== "unknown") {
      log(`QQ farm scene detected: ${detection.scene}${detection.matchedTexts.length > 0 ? ` (${detection.matchedTexts.join(", ")})` : ""}`);
      return detection;
    }
    await sleep(delayMs);
    detection = await recognizeQqFarmSceneOnAndroid(deviceId);
  }
  return detection;
}

async function ensureQqFarmHomeScene(deviceId: string): Promise<QqFarmSceneId> {
  let detection = await waitForQqFarmSceneOnAndroid(deviceId, 3, 800);
  if (detection.scene === "home" || detection.scene === "unknown") {
    return detection.scene;
  }

  if (detection.scene === "friend-farm") {
    const returned =
      (await tryTapTextByOcr(deviceId, QQ_FARM_RETURN_HOME_TEXTS, "returning to QQ farm home", {
        minXRatio: 0.75,
        minYRatio: 0.65,
      })) ||
      false;
    if (returned) {
      await sleep(1_500);
      detection = await recognizeQqFarmSceneOnAndroid(deviceId);
      if (detection.scene === "home") {
        return detection.scene;
      }
    }
  }

  if (detection.scene === "friends" || detection.scene === "store") {
    await tapCurrentScreenPoint(deviceId, QQ_FARM_POPUP_CLOSE_POINT, `closing QQ farm ${detection.scene} modal`);
    await sleep(1_200);
    detection = await recognizeQqFarmSceneOnAndroid(deviceId);
  }

  return detection.scene;
}

async function waitForWeChatAppBrandOpen(deviceId: string): Promise<boolean> {
  const topActivity = await waitForWeChatAppBrand(deviceId);
  return isWeChatAppBrandActivity(topActivity);
}

async function tryOpenQqFarmByOcr(deviceId: string): Promise<boolean> {
  const attempts: Array<{
    candidates: string[];
    description: string;
    minXRatio?: number;
    maxXRatio?: number;
    minYRatio?: number;
    maxYRatio?: number;
  }> = [
    {
      candidates: QQ_FARM_OPEN_TEXTS,
      description: "opening QQ classic farm mini program",
      minXRatio: 0.58,
      minYRatio: 0.2,
      maxYRatio: 0.8,
    },
    {
      candidates: QQ_FARM_RESULT_TEXTS,
      description: "opening QQ classic farm result",
      maxXRatio: 0.78,
      minYRatio: 0.15,
      maxYRatio: 0.8,
    },
    {
      candidates: ["小游戏", "最近玩过"],
      description: "opening QQ classic farm badge",
      maxXRatio: 0.82,
      minYRatio: 0.15,
      maxYRatio: 0.8,
    },
  ];

  for (const attempt of attempts) {
    const tapped = await tryTapTextByOcr(deviceId, attempt.candidates, attempt.description, attempt);
    if (!tapped) {
      continue;
    }

    await sleep(WECHAT_APPBRAND_OPEN_DELAY_MS);
    if (await waitForWeChatAppBrandOpen(deviceId)) {
      return true;
    }
  }

  return false;
}

async function tryOpenQqFarmByPointCandidates(deviceId: string): Promise<boolean> {
  const candidates: Array<{ point: PointRatio; description: string }> = [
    { point: WECHAT_QQ_FARM_FORWARD_BUTTON_POINT, description: "opening QQ classic farm mini program via forward button" },
    { point: WECHAT_QQ_FARM_RESULT_ROW_POINT, description: "opening QQ classic farm mini program via result row" },
    { point: WECHAT_QQ_FARM_RESULT_ICON_POINT, description: "opening QQ classic farm mini program via result icon" },
    { point: WECHAT_QQ_FARM_RESULT_BANNER_POINT, description: "opening QQ classic farm mini program via result banner" },
  ];

  for (const candidate of candidates) {
    await tapCurrentScreenPoint(deviceId, candidate.point, candidate.description);
    await sleep(WECHAT_APPBRAND_OPEN_DELAY_MS);
    const topActivity = await waitForWeChatAppBrand(deviceId);
    if (isWeChatAppBrandActivity(topActivity)) {
      return true;
    }
  }

  return false;
}

async function reopenWeChatHome(deviceId: string): Promise<void> {
  await adb(deviceId, ["shell", "am", "force-stop", WECHAT_PACKAGE]);
  await sleep(800);
  await openWeChatApp(deviceId);
  await sleep(WECHAT_OPEN_DELAY_MS);
}

async function openQqFarmFromWeChatSearch(deviceId: string): Promise<void> {
  await focusWeChatSearchField(deviceId);

  let searchResultsActivity: string | undefined;
  const pastedSearchOpened = await tryPasteWeChatSearchQuery(deviceId, QQ_FARM_QUERY);
  if (pastedSearchOpened) {
    searchResultsActivity = await readTopResumedActivity(deviceId);
  } else {
    log(`typing WeChat search prefix: ${WECHAT_QQ_FARM_QUERY_PREFIX}`);
    await adb(deviceId, ["shell", "input", "text", WECHAT_QQ_FARM_QUERY_PREFIX]);
    await sleep(WECHAT_SEARCH_DELAY_MS);

    const prefixScreenshot = PNG.sync.read(await captureScreen(deviceId));
    const searchInputCenter = pointFromRatio(
      prefixScreenshot.width,
      prefixScreenshot.height,
      WECHAT_SEARCH_INPUT_POINT,
    );
    await tap(deviceId, searchInputCenter.x, searchInputCenter.y);
    await sleep(300);

    const langToggleCenter = pointFromRatio(
      prefixScreenshot.width,
      prefixScreenshot.height,
      WECHAT_KEYBOARD_LANG_TOGGLE_POINT,
    );
    log("switching WeChat keyboard to Chinese mode");
    await tap(deviceId, langToggleCenter.x, langToggleCenter.y);
    await sleep(300);

    log(`typing WeChat search pinyin: ${WECHAT_QQ_FARM_PINYIN_QUERY}`);
    await adb(deviceId, ["shell", "input", "text", WECHAT_QQ_FARM_PINYIN_QUERY]);
    await sleep(WECHAT_SEARCH_RESULTS_DELAY_MS);

    const suggestionScreenshot = PNG.sync.read(await captureScreen(deviceId));
    const suggestionCenter = pointFromRatio(
      suggestionScreenshot.width,
      suggestionScreenshot.height,
      WECHAT_QQ_FARM_QUERY_SUGGESTION_POINT,
    );
    log("choosing QQ classic farm search suggestion");
    await tap(deviceId, suggestionCenter.x, suggestionCenter.y);
    await sleep(WECHAT_SEARCH_RESULTS_DELAY_MS);

    searchResultsActivity = await waitForWeChatSearchResultsPage(deviceId);
  }

  if (!isWeChatSearchResultsActivity(searchResultsActivity)) {
    throw new Error(`未能进入 QQ经典农场 搜索结果页，当前前台 Activity: ${searchResultsActivity ?? "unknown"}`);
  }

  const opened = (await tryOpenQqFarmByOcr(deviceId)) || (await tryOpenQqFarmByPointCandidates(deviceId));
  if (!opened) {
    const topActivity = await readTopResumedActivity(deviceId);
    throw new Error(`未能进入 QQ经典农场 小程序，当前前台 Activity: ${topActivity ?? "unknown"}`);
  }
}

async function dismissQqFarmTransientPopups(deviceId: string): Promise<void> {
  // These taps are intentionally tolerant: on the normal farm canvas they land on empty sky/ground,
  // while on welcome/level-up overlays they close the dialog and let the flow continue.
  await tapCurrentScreenPoint(deviceId, QQ_FARM_POPUP_CLOSE_POINT, "closing QQ farm popup if present");
  await sleep(800);
  await tapCurrentScreenPoint(deviceId, QQ_FARM_POPUP_EMPTY_DISMISS_POINT, "dismissing QQ farm overlay if present");
  await sleep(800);
}

async function runQqFarmPrimaryAction(
  deviceId: string,
  candidates: string[],
  description: string,
  fallbackPoint: PointRatio,
): Promise<"ocr" | "point"> {
  const tappedByOcr = await tryTapTextByOcr(deviceId, candidates, description, {
    minXRatio: 0.22,
    maxXRatio: 0.82,
    minYRatio: 0.48,
    maxYRatio: 0.94,
  });
  if (tappedByOcr) {
    return "ocr";
  }

  await tapCurrentScreenPoint(deviceId, fallbackPoint, description);
  return "point";
}

async function runQqFarmOneKeyAction(
  deviceId: string,
  action: QqFarmOneKeyAction,
  fallbackPoint: PointRatio,
): Promise<"ocr" | "point"> {
  return await runQqFarmPrimaryAction(
    deviceId,
    action.texts.length > 0 ? action.texts : QQ_FARM_PRIMARY_ACTION_TEXTS,
    `running QQ farm ${action.note}`,
    fallbackPoint,
  );
}

async function runQqFarmOneKeyActionSequence(
  deviceId: string,
  actions: QqFarmOneKeyAction[],
  fallbackPoint: PointRatio,
): Promise<string[]> {
  const notes: string[] = [];
  for (const action of actions) {
    const source = await runQqFarmOneKeyAction(deviceId, action, fallbackPoint);
    notes.push(source === "ocr" ? `已通过 OCR 执行${action.note}` : `已按默认热点执行${action.note}`);
    await sleep(QQ_FARM_STEAL_RUN_DELAY_MS);
    await dismissQqFarmTransientPopups(deviceId);
  }
  return notes;
}

async function detectQqFarmPlotsOnAndroid(deviceId: string): Promise<QqFarmPlot[]> {
  const screenshot = await captureScreen(deviceId);
  const png = PNG.sync.read(screenshot);
  return detectQqFarmPlotsFromPng(png);
}

function findQqFarmPlotTypeBlock(
  blocks: Awaited<ReturnType<typeof recognizeTextBlocks>>,
  plot: QqFarmPlot,
  png: PNG,
): string | undefined {
  const match = findOcrTextBlock(blocks, QQ_FARM_PLOT_TYPE_TEXTS, {
    minX: plot.x - Math.round(png.width * 0.08),
    maxX: plot.x + Math.round(png.width * 0.12),
    minY: plot.y - Math.round(png.height * 0.12),
    maxY: plot.y - Math.round(png.height * 0.02),
  });
  return match?.text.trim();
}

async function openQqFarmSeedChooserOnAndroid(
  deviceId: string,
  plot: QqFarmPlot,
): Promise<{
  blocks: Awaited<ReturnType<typeof recognizeTextBlocks>>;
  png: PNG;
  plotType?: string;
}> {
  await tap(deviceId, plot.x, plot.y);
  await sleep(QQ_FARM_SEED_CHOOSER_DELAY_MS);
  const screenshot = await captureScreen(deviceId);
  const png = PNG.sync.read(screenshot);
  const blocks = await recognizeTextBlocks(screenshot, log);
  return {
    blocks,
    png,
    plotType: findQqFarmPlotTypeBlock(blocks, plot, png),
  };
}

async function waitForQqFarmStoreSceneOnAndroid(deviceId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const detection = await recognizeQqFarmSceneOnAndroid(deviceId);
    if (detection.scene === "store") {
      return true;
    }
    await sleep(400);
  }
  return false;
}

async function closeQqFarmStoreOnAndroid(deviceId: string): Promise<void> {
  await tapCurrentScreenPoint(deviceId, QQ_FARM_STORE_CLOSE_POINT, "closing QQ farm store");
  await sleep(800);
}

async function buyLatestUnlockedSeedOnAndroid(deviceId: string, notes: string[]): Promise<string | undefined> {
  const openedByOcr = await tryTapTextByOcr(deviceId, ["商店", "商城"], "opening QQ farm store", {
    maxXRatio: 0.22,
    minYRatio: 0.85,
  });
  if (!openedByOcr) {
    await tapCurrentScreenPoint(deviceId, QQ_FARM_STORE_ENTRY_POINT, "opening QQ farm store");
  }

  if (!(await waitForQqFarmStoreSceneOnAndroid(deviceId))) {
    return undefined;
  }

  const screenshot = await captureScreen(deviceId);
  const png = PNG.sync.read(screenshot);
  const blocks = await recognizeTextBlocks(screenshot, log);
  const seeds = parseQqFarmStoreSeeds(blocks, {
    minY: 250,
    maxY: Math.round(png.height * QQ_FARM_STORE_VISIBLE_MAX_Y_RATIO),
  });
  const summary = describeQqFarmStoreSeeds(seeds);
  log(`QQ farm store seeds: ${summary}`);
  notes.push(`商店种子：${summary}`);
  const candidate = pickLatestUnlockedQqFarmStoreSeed(seeds);
  if (!candidate) {
    await closeQqFarmStoreOnAndroid(deviceId);
    return undefined;
  }

  log(`buying latest unlocked seed: ${candidate.label}`);
  const tapTargets = [
    { x: candidate.tapX, y: candidate.tapY, source: "card" },
    { x: candidate.centerX, y: candidate.centerY, source: "quality" },
  ].filter(
    (point, index, list) =>
      list.findIndex((entry) => entry.x === point.x && entry.y === point.y) === index,
  );

  for (const tapTarget of tapTargets) {
    log(`tapping QQ farm store seed ${candidate.label} via ${tapTarget.source} point (${tapTarget.x}, ${tapTarget.y})`);
    await tap(deviceId, tapTarget.x, tapTarget.y);
    await sleep(700);
    const sceneAfterTap = await recognizeQqFarmSceneOnAndroid(deviceId);
    if (sceneAfterTap.scene !== "store") {
      return candidate.label;
    }
  }

  const confirmTapped = await tryTapTextByOcr(deviceId, ["确定"], "confirming QQ farm seed purchase", {
    minYRatio: 0.62,
    maxYRatio: 0.9,
  });
  if (!confirmTapped) {
    await closeQqFarmStoreOnAndroid(deviceId);
    return undefined;
  }

  await sleep(900);
  const sceneAfterConfirm = await recognizeQqFarmSceneOnAndroid(deviceId);
  if (sceneAfterConfirm.scene === "store") {
    await closeQqFarmStoreOnAndroid(deviceId);
  }
  return candidate.label;
}

async function resolveSeedChoiceForPlantingOnAndroid(
  deviceId: string,
  plot: QqFarmPlot,
  notes: string[],
  options: QqFarmSeedChoiceOptions = {},
): Promise<QqFarmResolvedSeedChoice | undefined> {
  const { recordPlotType = true, recordPurchase = true } = options;
  let chooser = await openQqFarmSeedChooserOnAndroid(deviceId, plot);
  if (chooser.plotType && recordPlotType) {
    notes.push(`地块类型：${chooser.plotType}`);
  }

  let choice = findAvailableSeedChoice(chooser.blocks, chooser.png);
  if (!choice) {
    const purchased = await buyLatestUnlockedSeedOnAndroid(deviceId, notes);
    if (purchased) {
      if (recordPurchase) {
        notes.push(`已购买最新解锁种子：${purchased}`);
      }
    } else {
      notes.push("未能识别可购买种子");
      return undefined;
    }
    chooser = await openQqFarmSeedChooserOnAndroid(deviceId, plot);
    choice = findAvailableSeedChoice(chooser.blocks, chooser.png);
  }

  if (!choice) {
    notes.push("未识别到可用种子库存");
    return undefined;
  }

  return {
    choice,
    plotType: chooser.plotType,
  };
}

async function plantSinglePlotOnAndroid(
  deviceId: string,
  plot: QqFarmPlot,
  notes: string[],
  options: QqFarmSeedChoiceOptions = {},
): Promise<boolean> {
  const resolved = await resolveSeedChoiceForPlantingOnAndroid(deviceId, plot, notes, options);
  if (!resolved) {
    return false;
  }

  notes.push(`已点击下拉种子库存：${resolved.choice.count}`);
  await tap(deviceId, resolved.choice.x, resolved.choice.y);
  await sleep(QQ_FARM_SINGLE_PLANT_DELAY_MS);
  return true;
}

async function batchPlantEmptyPlotsOnAndroid(
  deviceId: string,
  emptyPlots: QqFarmPlot[],
  notes: string[],
): Promise<{ remainingPlots: QqFarmPlot[]; dragCount: number; plantedCount: number }> {
  let remainingPlots = emptyPlots;
  let dragCount = 0;
  let plantedCount = 0;
  let attemptedBatch = false;

  while (remainingPlots.length >= 2) {
    const candidates = buildQqFarmBatchCandidates(remainingPlots);
    if (candidates.length === 0) {
      break;
    }

    let progressed = false;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const beforeCount = remainingPlots.length;
      attemptedBatch = true;
      const resolvedSeedChoice = await resolveSeedChoiceForPlantingOnAndroid(deviceId, candidate.plots[0], notes, {
        recordPlotType: dragCount === 0 && candidateIndex === 0,
        recordPurchase: true,
      });
      if (!resolvedSeedChoice) {
        return { remainingPlots, dragCount, plantedCount };
      }
      if (dragCount === 0 && candidateIndex === 0) {
        notes.push(`已按住种子库存：${resolvedSeedChoice.choice.count}`);
      }

      const path = buildQqFarmBatchPath(candidate);
      const touchPath = buildQqFarmBatchTouchPath(resolvedSeedChoice.choice, candidate);
      log(`QQ farm batch planting candidate=${describeQqFarmBatchCandidate(candidate)} before=${beforeCount}`);
      try {
        await traceTouchPath(deviceId, touchPath);
      } catch (error) {
        log(`QQ farm touch path failed, falling back to draganddrop: ${(error as Error).message}`);
        await dragAndDrop(
          deviceId,
          { x: resolvedSeedChoice.choice.dragX, y: resolvedSeedChoice.choice.dragY },
          path.to,
          QQ_FARM_BATCH_SWIPE_DURATION_MS,
        );
      }
      await sleep(QQ_FARM_POST_PLANT_DELAY_MS);

      const detectedPlots = await detectQqFarmPlotsOnAndroid(deviceId);
      const afterRemainingPlots = detectedPlots.filter((plot) => plot.state === "empty");
      log(
        `QQ farm batch planting result candidate=${describeQqFarmBatchCandidate(candidate)} before=${beforeCount} after=${afterRemainingPlots.length}`,
      );
      remainingPlots = afterRemainingPlots;
      if (afterRemainingPlots.length < beforeCount) {
        dragCount += 1;
        plantedCount += beforeCount - afterRemainingPlots.length;
        progressed = true;
        break;
      }
    }

    if (!progressed) {
      break;
    }
  }

  if (dragCount > 0) {
    notes.push(`已批量拖拽播种 ${plantedCount} 块（${dragCount} 次）`);
  } else if (attemptedBatch) {
    notes.push("批量拖拽未命中，改走单块补种");
  }

  return { remainingPlots, dragCount, plantedCount };
}

async function runQqFarmPlantingModuleOnAndroid(deviceId: string): Promise<QqFarmHomeModuleResult> {
  const notes: string[] = [];
  const initialPlots = await detectQqFarmPlotsOnAndroid(deviceId);
  notes.push(describeQqFarmPlots(initialPlots));

  const emptyPlots = initialPlots.filter((plot) => plot.state === "empty");
  if (emptyPlots.length === 0) {
    return { notes };
  }

  let remainingPlots = (await batchPlantEmptyPlotsOnAndroid(deviceId, emptyPlots, notes)).remainingPlots
    .sort(compareQqFarmPlotsTopRightFirst);
  if (remainingPlots.length === 0) {
    return { notes };
  }

  let plantedSingles = 0;
  let recordedPlotType = notes.some((note) => note.startsWith("地块类型："));
  for (const plot of remainingPlots) {
    const planted = await plantSinglePlotOnAndroid(deviceId, plot, notes, {
      recordPlotType: !recordedPlotType,
      recordPurchase: true,
    });
    if (!planted) {
      break;
    }
    recordedPlotType = true;
    plantedSingles += 1;
  }
  if (plantedSingles > 0) {
    notes.push(`已单块补种 ${plantedSingles} 块`);
  }

  remainingPlots = (await detectQqFarmPlotsOnAndroid(deviceId))
    .filter((plot) => plot.state === "empty")
    .sort(compareQqFarmPlotsTopRightFirst);
  if (remainingPlots.length > 0) {
    notes.push(`剩余空地 ${remainingPlots.length} 块`);
  }

  return { notes };
}

async function runQqFarmHomeModulesOnAndroid(deviceId: string): Promise<string[]> {
  const modules: QqFarmHomeModule[] = [
    {
      id: "planting",
      name: "播种模块",
      run: runQqFarmPlantingModuleOnAndroid,
    },
  ];

  const notes: string[] = [];
  for (const module of modules) {
    notes.push(`开始执行${module.name}`);
    const result = await module.run(deviceId);
    notes.push(...result.notes);
  }
  return notes;
}

async function openQqFarmFriendList(deviceId: string): Promise<boolean> {
  const openedByOcr = await tryTapTextByOcr(deviceId, QQ_FARM_FRIEND_ENTRY_TEXTS, "opening QQ farm friend list", {
    minXRatio: 0.8,
    minYRatio: 0.75,
  });
  if (!openedByOcr) {
    await tapCurrentScreenPoint(deviceId, QQ_FARM_FRIEND_ENTRY_POINT, "opening QQ farm friend list");
  }
  await sleep(QQ_FARM_FRIEND_PAGE_DELAY_MS);

  const detection = await waitForQqFarmSceneOnAndroid(deviceId, 8, 1_000);
  return detection.scene === "friends";
}

async function visitQqFarmFriend(deviceId: string): Promise<boolean> {
  const visitedByOcr = await tryTapTextByOcr(deviceId, QQ_FARM_FRIEND_VISIT_TEXTS, "visiting first QQ farm friend", {
    minXRatio: 0.58,
    minYRatio: 0.18,
    maxYRatio: 0.88,
  });
  if (!visitedByOcr) {
    const candidates = await detectAndroidFriendVisitButtons(deviceId);
    if (candidates.length > 0) {
      const first = candidates[0];
      log(`QQ farm friend page detected ${candidates.length} green visit buttons, using first: (${first.x}, ${first.y})`);
      await tap(deviceId, first.x, first.y);
    } else {
      await tapCurrentScreenPoint(deviceId, QQ_FARM_FRIEND_FIRST_VISIT_POINT, "visiting first QQ farm friend");
    }
  }
  await sleep(QQ_FARM_STEAL_RUN_DELAY_MS);

  const detection = await waitForQqFarmSceneOnAndroid(deviceId, 8, 1_000);
  return detection.scene === "friend-farm";
}

type QqFarmRoutineResult = {
  notes: string[];
  finalScene: QqFarmSceneId;
};

async function runQqFarmRoutine(deviceId: string): Promise<QqFarmRoutineResult> {
  const notes: string[] = [];
  await sleep(QQ_FARM_POST_OPEN_DELAY_MS);
  const readyScene = await waitForQqFarmSceneOnAndroid(deviceId, 6, 1_000);
  if (readyScene.scene === "unknown") {
    notes.push("未确认 QQ 农场主场景已就绪");
  }
  await dismissQqFarmTransientPopups(deviceId);

  const initialScene = await ensureQqFarmHomeScene(deviceId);
  if (initialScene === "home") {
    notes.push("已识别自家农场");
  } else if (initialScene !== "unknown") {
    notes.push(`当前场景为 ${initialScene}，已继续按兜底流程处理`);
  }

  notes.push(...await runQqFarmOneKeyActionSequence(deviceId, QQ_FARM_HOME_ONE_KEY_ACTIONS, QQ_FARM_ONE_KEY_HARVEST_POINT));

  notes.push(...await runQqFarmHomeModulesOnAndroid(deviceId));
  await dismissQqFarmTransientPopups(deviceId);
  await ensureQqFarmHomeScene(deviceId);

  const friendListOpened = await openQqFarmFriendList(deviceId);
  if (!friendListOpened) {
    const detection = await recognizeQqFarmSceneOnAndroid(deviceId);
    notes.push("未确认打开好友列表");
    return {
      notes,
      finalScene: detection.scene,
    };
  }
  notes.push("已打开好友列表");
  await sleep(800);

  const visitedFriend = await visitQqFarmFriend(deviceId);
  if (!visitedFriend) {
    const detection = await recognizeQqFarmSceneOnAndroid(deviceId);
    notes.push("未确认进入好友农场");
    return {
      notes,
      finalScene: detection.scene,
    };
  }
  notes.push("已拜访好友农场");

  notes.push(...await runQqFarmOneKeyActionSequence(deviceId, QQ_FARM_FRIEND_ONE_KEY_ACTIONS, QQ_FARM_FRIEND_ONE_KEY_STEAL_POINT));

  const returnedHomeScene = await ensureQqFarmHomeScene(deviceId);
  if (returnedHomeScene === "home") {
    notes.push("已回到自家农场");
  }

  const finalDetection = await waitForQqFarmSceneOnAndroid(deviceId, 4, 800);
  return {
    notes,
    finalScene: finalDetection.scene,
  };
}

async function openQqFarmMiniProgram(deviceId: string): Promise<void> {
  await adb(deviceId, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await sleep(800);
  await reopenWeChatHome(deviceId);

  try {
    await openQqFarmFromWeChatSearch(deviceId);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`QQ farm search flow failed, falling back to quick entry: ${message}`);
  }

  await reopenWeChatHome(deviceId);

  if (await tryOpenQqFarmQuickEntry(deviceId)) {
    return;
  }

  throw new Error("未能通过微信搜索或快捷入口打开 QQ经典农场 小程序");
}

function summarizeCommandOutput(result: CommandResult): string | undefined {
  const combined = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!combined) {
    return undefined;
  }
  return combined.replace(/\s+/g, " ").slice(0, 160);
}

function resolveRequiredIosCommand(command: string | undefined, envName: string, actionLabel: string): string {
  if (!command) {
    throw new Error(
      `已检测到 iOS 设备，但未配置 ${envName}，无法执行${actionLabel}。请先配置对应的 iPhone 自动化命令。`,
    );
  }
  return command;
}

function platformLabel(platform: DevicePlatform): string {
  return platform === "ios" ? "iPhone" : "Android";
}

function shouldClearIosDingTalkAfterClockIn(): boolean {
  return resolveBooleanEnv(
    [
      process.env.WEIXIN_IOS_CLEAR_DINGTALK_AFTER_CLOCK_IN,
      process.env.WEIXIN_CLEAR_DINGTALK_AFTER_CLOCK_IN,
    ],
    true,
  );
}

function buildAttendanceSuccessText(args: {
  device: ConnectedDevice;
  closedDingTalk: boolean;
  clearedRecents: boolean;
  extraNote?: string;
}): string {
  const parts = [
    `已识别 ${platformLabel(args.device.platform)} 设备 ${args.device.name}`,
    "已执行钉钉打卡流程",
  ];

  if (args.closedDingTalk) {
    parts.push("并在后台关闭钉钉");
  }
  if (args.clearedRecents) {
    parts.push("并清理后台任务");
  }
  if (args.extraNote) {
    parts.push(args.extraNote);
  }

  return `${parts.join("，")}。`;
}

function buildExitDingTalkSuccessText(device: ConnectedDevice): string {
  return `已识别 ${platformLabel(device.platform)} 设备 ${device.name}，已在后台关闭钉钉。`;
}

function buildQqFarmSuccessText(args: {
  device: ConnectedDevice;
  openedOnly?: boolean;
  extraNote?: string;
}): string {
  if (args.openedOnly) {
    return `已识别 ${platformLabel(args.device.platform)} 设备 ${args.device.name}，已打开 QQ经典农场，但尚未执行收菜/偷菜点击${args.extraNote ? `：${args.extraNote}` : ""}。`;
  }

  if (args.extraNote) {
    return `已识别 ${platformLabel(args.device.platform)} 设备 ${args.device.name}，已执行 QQ经典农场 流程：${args.extraNote}。`;
  }

  return `已识别 ${platformLabel(args.device.platform)} 设备 ${args.device.name}，已执行 QQ经典农场 流程。`;
}

async function runIosAutomationCommand(args: {
  device: ConnectedDevice;
  command: string;
  action: string;
  clockInSlot?: ClockInSlotConfig;
}): Promise<CommandResult> {
  const env: Record<string, string> = {
    WEIXIN_CONNECTED_DEVICE_PLATFORM: args.device.platform,
    WEIXIN_CONNECTED_DEVICE_ID: args.device.id,
    WEIXIN_CONNECTED_DEVICE_NAME: args.device.name,
    WEIXIN_IOS_DEVICE_ID: args.device.id,
    WEIXIN_IOS_DEVICE_NAME: args.device.name,
    WEIXIN_AUTOMATION_ACTION: args.action,
  };

  if (args.clockInSlot) {
    env.WEIXIN_CLOCK_IN_SLOT_ID = args.clockInSlot.id;
    env.WEIXIN_CLOCK_IN_SLOT_LABEL = args.clockInSlot.label;
  }
  if (args.action === "qq-farm") {
    env.WEIXIN_IOS_QQ_FARM_RESULT_COORD = IOS_QQ_FARM_RESULT_COORD;
  }

  log(`running iOS automation action=${args.action} device=${args.device.name} (${args.device.id})`);
  return await runShellCommand(args.command, { env });
}

export async function runAttendanceCommand(opts?: {
  headless?: boolean;
  enforceTimeWindow?: boolean;
  throwOnOutsideWindow?: boolean;
  overrideSlotId?: ClockInSlotId;
}): Promise<ChatResponse> {
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

  const device = await resolveConnectedDevice();
  if (device.platform === "ios") {
    await runIosAutomationCommand({
      device,
      command: resolveRequiredIosCommand(
        IOS_DINGTALK_CLOCK_IN_COMMAND,
        "WEIXIN_IOS_DINGTALK_CLOCK_IN_COMMAND",
        "钉钉打卡",
      ),
      action: "dingtalk-clock-in",
      clockInSlot: activeSlot,
    });
    return {
      text: buildAttendanceSuccessText({
        device,
        closedDingTalk: shouldClearIosDingTalkAfterClockIn(),
        clearedRecents: false,
      }),
    };
  }

  const scrcpyStatus = opts?.headless
    ? "已切换为纯后台执行"
    : await ensureScrcpyRunning(device.id);

  await maybeEnsureFastClockEnabled(device.id);
  await openAttendancePageFromWorkbench(device.id);
  await sleep(OPEN_DELAY_MS);
  await clickPunchButton(device.id, activeSlot);
  await sleep(1_500);
  let clearedRecents = false;
  let extraNote: string | undefined;
  if (CLEAR_ANDROID_DINGTALK_AFTER_CLOCK_IN) {
    await exitDingTalk(device.id);
    if (CLEAR_ANDROID_RECENT_APPS_AFTER_CLOCK_IN) {
      const clearResult = await clearRecentApps(device.id);
      clearedRecents = clearResult.cleared;
      if (!clearResult.cleared) {
        extraNote = "未找到“清除全部”，已跳过后台清理";
      }
    }
  } else {
    extraNote = "已保留钉钉前台状态";
  }

  return {
    text: buildAttendanceSuccessText({
      device,
      closedDingTalk: CLEAR_ANDROID_DINGTALK_AFTER_CLOCK_IN,
      clearedRecents,
      extraNote: `${scrcpyStatus}，约等待 ${Math.round(OPEN_DELAY_MS / 1000)} 秒${extraNote ? `，${extraNote}` : ""}`,
    }),
  };
}

export async function runQqFarmCommand(): Promise<ChatResponse> {
  const device = await resolveConnectedDevice();
  if (device.platform === "ios") {
    const result = await runIosAutomationCommand({
      device,
      command: resolveRequiredIosCommand(
        IOS_QQ_FARM_COMMAND,
        "WEIXIN_IOS_QQ_FARM_COMMAND",
        "QQ 农场偷菜",
      ),
      action: "qq-farm",
    });
    const summary = summarizeCommandOutput(result);
    return {
      text:
        summary?.includes("暂未执行收菜/偷菜画布点击")
          ? buildQqFarmSuccessText({
              device,
              openedOnly: true,
              extraNote: "请配置 WEIXIN_IOS_QQ_FARM_CANVAS_STEPS",
            })
          : buildQqFarmSuccessText({
              device,
              extraNote: summary,
            }),
    };
  }

  await openQqFarmMiniProgram(device.id);
  const routineResult = await runQqFarmRoutine(device.id);
  return {
    text: buildQqFarmSuccessText({
      device,
      extraNote: routineResult.notes.join("，"),
    }),
  };
}

async function handleExitDingTalkCommand(): Promise<ChatResponse> {
  const device = await resolveConnectedDevice();
  if (device.platform === "ios") {
    await runIosAutomationCommand({
      device,
      command: resolveRequiredIosCommand(
        IOS_EXIT_DINGTALK_COMMAND,
        "WEIXIN_IOS_EXIT_DINGTALK_COMMAND",
        "退出钉钉",
      ),
      action: "exit-dingtalk",
    });
    return {
      text: buildExitDingTalkSuccessText(device),
    };
  }

  await exitDingTalk(device.id);
  return { text: buildExitDingTalkSuccessText(device) };
}

export class LocalCommandAgent implements Agent {
  constructor(private delegate: Agent) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const text = request.text.trim();
    if (text === "打卡") {
      return await runAttendanceCommand({
        enforceTimeWindow: false,
      });
    }
    if (text === "偷菜") {
      return await runQqFarmCommand();
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
