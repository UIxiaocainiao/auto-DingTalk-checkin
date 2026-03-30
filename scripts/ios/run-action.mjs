#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { remote } from "webdriverio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const workspaceRequire = createRequire(path.join(REPO_ROOT, "packages", "agent-acp", "package.json"));
const STATE_DIR = path.join(homedir(), ".openclaw", "weixin-agent-sdk");
const APPIUM_LOG_FILE = path.join(STATE_DIR, "ios-appium.log");
const APPIUM_BINARY = path.join(REPO_ROOT, "node_modules", ".bin", "appium");
const APPIUM_EXTENSIONS_FILE = path.join(REPO_ROOT, "node_modules", ".cache", "appium", "extensions.yaml");
const XCUITEST_DRIVER_PATH = path.join(REPO_ROOT, "node_modules", "appium-xcuitest-driver");
const DEFAULT_APPIUM_SERVER_URL = process.env.WEIXIN_IOS_APPIUM_SERVER_URL?.trim() || "http://127.0.0.1:4723";
let PNG;
try {
  ({ PNG } = workspaceRequire("pngjs"));
} catch {}

function resolveBooleanEnv(values, defaultValue) {
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

function detectConnectedDeviceId() {
  try {
    const output = execFileSync("idevice_id", ["-l"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

const DEFAULT_DEVICE_ID =
  process.env.WEIXIN_IOS_DEVICE_ID?.trim() ||
  process.env.WEIXIN_CONNECTED_DEVICE_ID?.trim() ||
  detectConnectedDeviceId();
const DEFAULT_DEVICE_NAME =
  process.env.WEIXIN_IOS_DEVICE_NAME?.trim() ||
  process.env.WEIXIN_CONNECTED_DEVICE_NAME?.trim() ||
  "iPhone";
const XCODE_ORG_ID = process.env.WEIXIN_IOS_XCODE_ORG_ID?.trim();
const XCODE_SIGNING_ID = process.env.WEIXIN_IOS_XCODE_SIGNING_ID?.trim() || "Apple Development";
const UPDATED_WDA_BUNDLE_ID = process.env.WEIXIN_IOS_UPDATED_WDA_BUNDLE_ID?.trim();
const ALLOW_PROVISIONING_DEVICE_REGISTRATION = resolveBooleanEnv(
  [process.env.WEIXIN_IOS_ALLOW_PROVISIONING_DEVICE_REGISTRATION],
  true,
);
const CLEAR_DINGTALK_AFTER_CLOCK_IN = resolveBooleanEnv(
  [
    process.env.WEIXIN_IOS_CLEAR_DINGTALK_AFTER_CLOCK_IN,
    process.env.WEIXIN_CLEAR_DINGTALK_AFTER_CLOCK_IN,
  ],
  true,
);
const DINGTALK_BUNDLE_ID = process.env.WEIXIN_IOS_DINGTALK_BUNDLE_ID?.trim() || "com.laiwang.DingTalk";
const WECHAT_BUNDLE_ID = process.env.WEIXIN_IOS_WECHAT_BUNDLE_ID?.trim() || "com.tencent.xin";
const DEFAULT_QQ_FARM_RESULT_COORD = JSON.stringify({ xRatio: 0.5, yRatio: 0.24 });
const QQ_FARM_QUERY = process.env.WEIXIN_IOS_QQ_FARM_QUERY?.trim() || "QQ经典农场";
const QQ_FARM_QUERY_CANDIDATES = [
  ...new Set(
    [QQ_FARM_QUERY, "QQ经典农场", "QQ农场", "经典农场"]
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];
const QQ_FARM_RESULT_TEXTS = [
  ...new Set(
    [...QQ_FARM_QUERY_CANDIDATES, "QQ经典农场", "QQ农场", "经典农场"]
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];
const QQ_FARM_RESULT_COORD =
  process.env.WEIXIN_IOS_QQ_FARM_RESULT_COORD?.trim() || DEFAULT_QQ_FARM_RESULT_COORD;
const DEFAULT_QQ_FARM_REWARD_COORD = JSON.stringify({ xRatio: 0.91282, yRatio: 0.20498 });
const DEFAULT_QQ_FARM_PRIMARY_ACTION_COORD = JSON.stringify({ xRatio: 0.5, yRatio: 0.74645 });
const DEFAULT_QQ_FARM_FRIEND_ENTRY_COORD = JSON.stringify({ xRatio: 0.9641, yRatio: 0.94076 });
const DEFAULT_QQ_FARM_FRIEND_VISIT_COORD = JSON.stringify({ xRatio: 0.85128, yRatio: 0.43128 });
const DEFAULT_QQ_FARM_FRIEND_POPUP_CLOSE_COORD = JSON.stringify({ xRatio: 0.86667, yRatio: 0.21801 });
const QQ_FARM_REWARD_COORD =
  process.env.WEIXIN_IOS_QQ_FARM_REWARD_COORD?.trim() || DEFAULT_QQ_FARM_REWARD_COORD;
const QQ_FARM_PRIMARY_ACTION_COORD =
  process.env.WEIXIN_IOS_QQ_FARM_PRIMARY_ACTION_COORD?.trim() || DEFAULT_QQ_FARM_PRIMARY_ACTION_COORD;
const QQ_FARM_FRIEND_ENTRY_COORD =
  process.env.WEIXIN_IOS_QQ_FARM_FRIEND_ENTRY_COORD?.trim() || DEFAULT_QQ_FARM_FRIEND_ENTRY_COORD;
const QQ_FARM_FRIEND_VISIT_COORD =
  process.env.WEIXIN_IOS_QQ_FARM_FRIEND_VISIT_COORD?.trim() || DEFAULT_QQ_FARM_FRIEND_VISIT_COORD;
const QQ_FARM_FRIEND_POPUP_CLOSE_COORD =
  process.env.WEIXIN_IOS_QQ_FARM_FRIEND_POPUP_CLOSE_COORD?.trim() || DEFAULT_QQ_FARM_FRIEND_POPUP_CLOSE_COORD;
const QQ_FARM_FRIEND_PAGE_DELAY_MS = Number.parseInt(
  process.env.WEIXIN_IOS_QQ_FARM_FRIEND_PAGE_DELAY_MS ?? "1200",
  10,
);
const QQ_FARM_POST_VISIT_DELAY_MS = Number.parseInt(
  process.env.WEIXIN_IOS_QQ_FARM_POST_VISIT_DELAY_MS ?? "3500",
  10,
);
const QQ_FARM_PRIMARY_ACTION_DELAY_MS = Number.parseInt(
  process.env.WEIXIN_IOS_QQ_FARM_PRIMARY_ACTION_DELAY_MS ?? "1200",
  10,
);
const QQ_FARM_PRIMARY_ACTION_REPEAT = Number.parseInt(
  process.env.WEIXIN_IOS_QQ_FARM_PRIMARY_ACTION_REPEAT ?? "2",
  10,
);
const AUTO_START_APPIUM = !["0", "false", "off"].includes(
  process.env.WEIXIN_IOS_AUTO_START_APPIUM?.trim().toLowerCase() || "",
);

const cliArgs = process.argv.slice(2);
const normalizedCliArgs = cliArgs[0] === "--" ? cliArgs.slice(1) : cliArgs;
const action = normalizedCliArgs[0];

function log(message) {
  console.log(`[ios-automation] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function printUsage() {
  console.log(`Usage:
  node scripts/ios/run-action.mjs doctor
  node scripts/ios/run-action.mjs dingtalk-clock-in
  node scripts/ios/run-action.mjs qq-farm
  node scripts/ios/run-action.mjs exit-dingtalk

Environment:
  WEIXIN_IOS_DEVICE_ID                iPhone UDID
  WEIXIN_IOS_APPIUM_SERVER_URL        Appium server URL (default: http://127.0.0.1:4723)
  WEIXIN_IOS_XCODE_ORG_ID             Apple Developer Team ID for WebDriverAgent signing
  WEIXIN_IOS_XCODE_SIGNING_ID         Signing certificate name (default: Apple Development)
  WEIXIN_IOS_UPDATED_WDA_BUNDLE_ID    Unique WebDriverAgentRunner bundle id for your Apple ID
  WEIXIN_IOS_ALLOW_PROVISIONING_DEVICE_REGISTRATION
                                      Let xcodebuild create/sign WDA profiles automatically (default: on)
  WEIXIN_CLEAR_DINGTALK_AFTER_CLOCK_IN
                                      Shared Android/iPhone switch for closing DingTalk after clock-in (default: on)
  WEIXIN_IOS_CLEAR_DINGTALK_AFTER_CLOCK_IN
                                      Terminate DingTalk after clock-in on iPhone (default: on)
  WEIXIN_IOS_DINGTALK_BUNDLE_ID       DingTalk bundle id (default: com.laiwang.DingTalk)
  WEIXIN_IOS_WECHAT_BUNDLE_ID         WeChat bundle id (default: com.tencent.xin)
  WEIXIN_IOS_QQ_FARM_QUERY            Search text for QQ farm (default: QQ经典农场)
  WEIXIN_IOS_QQ_FARM_CANVAS_STEPS     JSON array of coordinate steps for farm canvas taps
  WEIXIN_IOS_DINGTALK_WORKBENCH_TAB_COORD
  WEIXIN_IOS_DINGTALK_ATTENDANCE_ENTRY_COORD
  WEIXIN_IOS_DINGTALK_MORNING_PUNCH_COORD
  WEIXIN_IOS_DINGTALK_EVENING_PUNCH_COORD
  WEIXIN_IOS_DINGTALK_GENERIC_PUNCH_COORD
  WEIXIN_IOS_WECHAT_SEARCH_COORD
  WEIXIN_IOS_QQ_FARM_RESULT_COORD     Fallback result tap point (default: ${DEFAULT_QQ_FARM_RESULT_COORD})`);
}

function requiredDeviceId() {
  if (!DEFAULT_DEVICE_ID) {
    fail("缺少 WEIXIN_IOS_DEVICE_ID 或 WEIXIN_CONNECTED_DEVICE_ID，无法连接 iPhone。");
  }
  return DEFAULT_DEVICE_ID;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "") {
    return "/";
  }
  return pathname.endsWith("/") && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
}

function parseServerUrl(rawUrl) {
  const url = new URL(rawUrl);
  return {
    protocol: url.protocol.replace(":", ""),
    hostname: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    pathname: normalizePathname(url.pathname),
  };
}

function buildStatusUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.pathname = `${normalizePathname(url.pathname)}/status`.replace(/\/{2,}/g, "/");
  return url.toString();
}

async function isAppiumServerReady(rawUrl) {
  try {
    const response = await fetch(buildStatusUrl(rawUrl), {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForAppiumServer(rawUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAppiumServerReady(rawUrl)) {
      return true;
    }
    await sleep(750);
  }
  return false;
}

async function waitForAppiumServerToStop(rawUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAppiumServerReady(rawUrl))) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

function canManageExistingAppiumServer(rawUrl) {
  const server = parseServerUrl(rawUrl);
  return server.protocol === "http" && ["127.0.0.1", "localhost"].includes(server.hostname);
}

function findListeningPids(port) {
  try {
    const output = execFileSync("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function stopManagedAppiumServer(rawUrl) {
  if (!canManageExistingAppiumServer(rawUrl)) {
    return false;
  }

  const server = parseServerUrl(rawUrl);
  const pids = findListeningPids(server.port);
  if (pids.length === 0) {
    return false;
  }

  log(`检测到端口 ${server.port} 上已有 Appium 进程，准备停止后重启: ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  if (await waitForAppiumServerToStop(rawUrl, 5_000)) {
    return true;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  const stopped = await waitForAppiumServerToStop(rawUrl, 3_000);
  if (!stopped) {
    fail(`无法停止已占用端口 ${server.port} 的 Appium 进程`);
  }
  return true;
}

function repairAppiumExtensionCache() {
  if (!existsSync(APPIUM_EXTENSIONS_FILE) || !existsSync(XCUITEST_DRIVER_PATH)) {
    return false;
  }

  const content = readFileSync(APPIUM_EXTENSIONS_FILE, "utf8");
  const match = content.match(/^(\s*installPath:\s*)(.+)$/m);
  if (!match) {
    return false;
  }

  const currentInstallPath = match[2].trim();
  if (currentInstallPath === XCUITEST_DRIVER_PATH || existsSync(currentInstallPath)) {
    return false;
  }

  writeFileSync(
    APPIUM_EXTENSIONS_FILE,
    content.replace(match[0], `${match[1]}${XCUITEST_DRIVER_PATH}`),
    "utf8",
  );
  log(`已修复 Appium xcuitest driver 路径: ${currentInstallPath} -> ${XCUITEST_DRIVER_PATH}`);
  return true;
}

async function ensureAppiumServer(rawUrl) {
  repairAppiumExtensionCache();

  if (await isAppiumServerReady(rawUrl)) {
    return;
  }

  if (!AUTO_START_APPIUM) {
    fail(`Appium 服务未启动: ${rawUrl}`);
  }
  if (!existsSync(APPIUM_BINARY)) {
    fail(`未找到 Appium 可执行文件: ${APPIUM_BINARY}`);
  }

  const server = parseServerUrl(rawUrl);
  await mkdir(STATE_DIR, { recursive: true });
  const logFd = openSync(APPIUM_LOG_FILE, "a");
  const args = [
    "server",
    "--address",
    server.hostname,
    "--port",
    String(server.port),
  ];
  if (server.pathname !== "/") {
    args.push("--base-path", server.pathname);
  }

  log(`Appium 未运行，正在后台启动: ${rawUrl}`);
  const child = spawn(APPIUM_BINARY, args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  const ready = await waitForAppiumServer(rawUrl, 20_000);
  if (!ready) {
    fail(`Appium 启动超时，请检查日志 ${APPIUM_LOG_FILE}`);
  }
}

function shouldRecoverByRestartingAppium(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not find a driver for automationName 'XCUITest'") ||
    message.includes("Could not read the driver manifest")
  );
}

function escapePredicateText(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function predicateContains(texts, elementTypes) {
  const escapedTexts = texts.map((text) => escapePredicateText(text));
  const textClause = escapedTexts
    .map((text) => `(name CONTAINS[c] "${text}" OR label CONTAINS[c] "${text}" OR value CONTAINS[c] "${text}")`)
    .join(" OR ");
  if (!elementTypes || elementTypes.length === 0) {
    return `-ios predicate string:${textClause}`;
  }
  const typeClause = elementTypes
    .map((type) => `type == "${type}"`)
    .join(" OR ");
  return `-ios predicate string:(${typeClause}) AND (${textClause})`;
}

function predicateEquals(texts, elementTypes) {
  const escapedTexts = texts.map((text) => escapePredicateText(text));
  const textClause = escapedTexts
    .map((text) => `(name == "${text}" OR label == "${text}" OR value == "${text}")`)
    .join(" OR ");
  if (!elementTypes || elementTypes.length === 0) {
    return `-ios predicate string:${textClause}`;
  }
  const typeClause = elementTypes
    .map((type) => `type == "${type}"`)
    .join(" OR ");
  return `-ios predicate string:(${typeClause}) AND (${textClause})`;
}

function accessibilitySelectors(texts) {
  return texts.map((text) => `~${text}`);
}

function selectorsForTexts(texts, elementTypes = []) {
  return [
    ...accessibilitySelectors(texts),
    predicateContains(texts, elementTypes),
    predicateContains(texts, []),
  ];
}

function parsePointValue(rawValue) {
  if (!rawValue) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const [first, second] = trimmed.split(",").map((part) => Number(part.trim()));
  if (Number.isFinite(first) && Number.isFinite(second)) {
    if (Math.abs(first) <= 1 && Math.abs(second) <= 1) {
      return { xRatio: first, yRatio: second };
    }
    return { x: Math.round(first), y: Math.round(second) };
  }

  fail(`无法解析坐标值: ${rawValue}`);
}

async function resolvePoint(browser, rawValue) {
  const point = parsePointValue(rawValue);
  if (!point) {
    return undefined;
  }

  if (typeof point.x === "number" && typeof point.y === "number") {
    return { x: point.x, y: point.y };
  }

  if (typeof point.xRatio === "number" && typeof point.yRatio === "number") {
    const size = await browser.getWindowSize();
    return {
      x: Math.round(size.width * point.xRatio),
      y: Math.round(size.height * point.yRatio),
    };
  }

  fail(`坐标配置缺少 x/y 或 xRatio/yRatio: ${rawValue}`);
}

async function tapPointValue(browser, rawValue, description, sourceLabel) {
  const resolved = await resolvePoint(browser, rawValue);
  if (!resolved) {
    return false;
  }
  await browser.tap(resolved);
  log(`已通过 ${sourceLabel} 点击${description}: (${resolved.x}, ${resolved.y})`);
  return true;
}

async function tapConfiguredPoint(browser, envName, description) {
  return await tapPointValue(browser, process.env[envName], description, envName);
}

async function mobileTapPoint(browser, point, description, sourceLabel) {
  await browser.execute("mobile: tap", point);
  log(`已通过 ${sourceLabel} 点击${description}: (${point.x}, ${point.y})`);
}

async function mobileTapPointValue(browser, rawValue, description, sourceLabel) {
  const resolved = await resolvePoint(browser, rawValue);
  if (!resolved) {
    return false;
  }
  await mobileTapPoint(browser, resolved, description, sourceLabel);
  return true;
}

async function hasAnySelector(browser, selectors) {
  for (const selector of selectors) {
    try {
      const element = await browser.$(selector);
      if (await element.isExisting()) {
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

async function waitForAnySelector(browser, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasAnySelector(browser, selectors)) {
      return true;
    }
    await sleep(250);
  }
  return await hasAnySelector(browser, selectors);
}

async function tapElementCenter(browser, element, description, selector) {
  const location = await element.getLocation();
  const size = await element.getSize();
  if (
    !Number.isFinite(location.x) ||
    !Number.isFinite(location.y) ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error(`无法获取 ${description} 的可点击区域: ${selector}`);
  }

  const point = {
    x: Math.round(location.x + size.width / 2),
    y: Math.round(location.y + size.height / 2),
  };
  await browser.tap(point);
  log(`已点击${description}: ${selector} @ (${point.x}, ${point.y})`);
}

async function tapAnySelector(browser, selectors, description, options = {}) {
  for (const selector of selectors) {
    try {
      const element = await browser.$(selector);
      if (!(await element.isExisting())) {
        continue;
      }
      if (options.rawTap) {
        await tapElementCenter(browser, element, description, selector);
      } else {
        await element.tap({
          direction: options.direction ?? "up",
          maxScrolls: options.maxScrolls ?? 3,
        });
        log(`已点击${description}: ${selector}`);
      }
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function setValueBySelectors(browser, selectors, value, description, options = {}) {
  for (const selector of selectors) {
    try {
      const element = await browser.$(selector);
      if (!(await element.isExisting())) {
        continue;
      }
      if (options.rawTap) {
        await tapElementCenter(browser, element, description, selector);
      } else {
        await element.tap({
          direction: "down",
          maxScrolls: 2,
        });
      }
      await element.clearValue().catch(() => {});
      await element.setValue(value);
      log(`已填写${description}: ${selector}`);
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

function parseCanvasSteps() {
  const raw = process.env.WEIXIN_IOS_QQ_FARM_CANVAS_STEPS?.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    fail("WEIXIN_IOS_QQ_FARM_CANVAS_STEPS 必须是 JSON 数组");
  }

  return parsed.map((step, index) => {
    if (!step || typeof step !== "object") {
      fail(`WEIXIN_IOS_QQ_FARM_CANVAS_STEPS[${index}] 不是对象`);
    }

    const normalized = {};
    if (typeof step.name === "string" && step.name.trim()) {
      normalized.name = step.name.trim();
    }
    if (typeof step.delayMs === "number") {
      normalized.delayMs = step.delayMs;
    }
    if (typeof step.x === "number" && typeof step.y === "number") {
      normalized.x = step.x;
      normalized.y = step.y;
      return normalized;
    }
    if (typeof step.xRatio === "number" && typeof step.yRatio === "number") {
      normalized.xRatio = step.xRatio;
      normalized.yRatio = step.yRatio;
      return normalized;
    }

    fail(`WEIXIN_IOS_QQ_FARM_CANVAS_STEPS[${index}] 缺少坐标`);
  });
}

async function executeCanvasSteps(browser, steps) {
  for (const step of steps) {
    const point = await resolvePoint(browser, JSON.stringify(step));
    await browser.tap(point);
    log(`已执行画布点击${step.name ? ` ${step.name}` : ""}: (${point.x}, ${point.y})`);
    if (step.delayMs) {
      await sleep(step.delayMs);
    }
  }
}

async function capturePngScreenshot(browser) {
  if (!PNG) {
    return undefined;
  }
  const base64 = await browser.takeScreenshot();
  return PNG.sync.read(Buffer.from(base64, "base64"));
}

function findGreenButtonCenters(png) {
  if (!png) {
    return [];
  }

  const { width, height, data } = png;
  const visited = new Uint8Array(width * height);
  const minX = Math.floor(width * 0.55);
  const maxX = Math.floor(width * 0.98);
  const minY = Math.floor(height * 0.35);
  const maxY = Math.floor(height * 0.9);
  const minWidth = Math.floor(width * 0.08);
  const minHeight = Math.floor(height * 0.025);
  const centers = [];

  const isCandidate = (x, y) => {
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

      const queue = [[x, y]];
      visited[start] = 1;
      let minComponentX = x;
      let maxComponentX = x;
      let minComponentY = y;
      let maxComponentY = y;
      let pixelCount = 0;

      while (queue.length > 0) {
        const [currentX, currentY] = queue.pop();
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
        ]) {
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

async function detectFriendVisitButtons(browser) {
  const png = await capturePngScreenshot(browser);
  if (!png) {
    return [];
  }

  const logicalSize = await browser.getWindowSize();
  return findGreenButtonCenters(png).map((center) => ({
    pixelCount: center.pixelCount,
    x: Math.round((center.centerX / png.width) * logicalSize.width),
    y: Math.round((center.centerY / png.height) * logicalSize.height),
  }));
}

async function createBrowserForAction(actionName) {
  const buildRemoteOptions = () => {
    const server = parseServerUrl(DEFAULT_APPIUM_SERVER_URL);
    const bundleId =
      actionName === "qq-farm" ? WECHAT_BUNDLE_ID : DINGTALK_BUNDLE_ID;
    const capabilities = {
      platformName: "iOS",
      "appium:automationName": "XCUITest",
      "appium:udid": requiredDeviceId(),
      "appium:deviceName": DEFAULT_DEVICE_NAME,
      "appium:noReset": true,
      "appium:newCommandTimeout": 180,
      "appium:autoAcceptAlerts": true,
      "appium:bundleId": bundleId,
    };

    if (XCODE_ORG_ID) {
      capabilities["appium:xcodeOrgId"] = XCODE_ORG_ID;
      capabilities["appium:xcodeSigningId"] = XCODE_SIGNING_ID;
      capabilities["appium:allowProvisioningDeviceRegistration"] =
        ALLOW_PROVISIONING_DEVICE_REGISTRATION;
    }

    if (UPDATED_WDA_BUNDLE_ID) {
      capabilities["appium:updatedWDABundleId"] = UPDATED_WDA_BUNDLE_ID;
    }

    return {
      protocol: server.protocol,
      hostname: server.hostname,
      port: server.port,
      path: server.pathname,
      logLevel: "error",
      waitforTimeout: 8_000,
      capabilities,
    };
  };

  await ensureAppiumServer(DEFAULT_APPIUM_SERVER_URL);

  try {
    return await remote(buildRemoteOptions());
  } catch (error) {
    if (!shouldRecoverByRestartingAppium(error) || !AUTO_START_APPIUM) {
      throw error;
    }

    log("检测到当前 Appium 缺少 XCUITest driver，尝试切换到本仓库的 Appium 并重试一次。");
    await stopManagedAppiumServer(DEFAULT_APPIUM_SERVER_URL);
    await ensureAppiumServer(DEFAULT_APPIUM_SERVER_URL);
    return await remote(buildRemoteOptions());
  }
}

async function runDoctor() {
  const status = {
    appiumBinary: existsSync(APPIUM_BINARY),
    appiumServerUrl: DEFAULT_APPIUM_SERVER_URL,
    deviceId: DEFAULT_DEVICE_ID || null,
    xcodeOrgId: XCODE_ORG_ID || null,
    xcodeSigningId: XCODE_ORG_ID ? XCODE_SIGNING_ID : null,
    updatedWdaBundleId: UPDATED_WDA_BUNDLE_ID || null,
    allowProvisioningDeviceRegistration: XCODE_ORG_ID
      ? ALLOW_PROVISIONING_DEVICE_REGISTRATION
      : null,
    clearDingTalkAfterClockIn: CLEAR_DINGTALK_AFTER_CLOCK_IN,
    dingTalkBundleId: DINGTALK_BUNDLE_ID,
    weChatBundleId: WECHAT_BUNDLE_ID,
    qqFarmQuery: QQ_FARM_QUERY,
  };
  console.log(JSON.stringify(status, null, 2));
}

async function clearDingTalkInBackground(browser, sourceLabel) {
  const terminated = await browser
    .execute("mobile: terminateApp", { bundleId: DINGTALK_BUNDLE_ID })
    .catch(() => null);

  if (terminated !== true) {
    await browser.closeApp({ bundleId: DINGTALK_BUNDLE_ID }).catch(() => {});
  }

  await browser.activateApp("com.apple.springboard").catch(() => {});
  log(`已在 iPhone 后台关闭钉钉${sourceLabel ? `（${sourceLabel}）` : ""}。`);
}

async function runDingTalkClockIn(browser) {
  const slotId = process.env.WEIXIN_CLOCK_IN_SLOT_ID?.trim();
  const slotLabel = process.env.WEIXIN_CLOCK_IN_SLOT_LABEL?.trim() || slotId || "打卡";
  const workbenchSelectors = selectorsForTexts(
    ["工作台", "工作台应用"],
    ["XCUIElementTypeButton", "XCUIElementTypeStaticText"],
  );
  const attendanceSelectors = selectorsForTexts(
    ["考勤打卡", "签到", "打卡"],
    ["XCUIElementTypeButton", "XCUIElementTypeStaticText", "XCUIElementTypeCell"],
  );
  const slotSpecificTexts =
    slotId === "morning"
      ? ["上班打卡", "上班", "极速打卡"]
      : slotId === "evening"
        ? ["下班打卡", "下班", "极速打卡"]
        : ["打卡", "极速打卡"];
  const genericPunchTexts = ["打卡", "极速打卡", "签到"];

  await browser.launchApp({ bundleId: DINGTALK_BUNDLE_ID });
  await sleep(2_000);

  await tapAnySelector(browser, workbenchSelectors, "钉钉工作台", {
    maxScrolls: 1,
  }).catch(() => {});
  await tapConfiguredPoint(browser, "WEIXIN_IOS_DINGTALK_WORKBENCH_TAB_COORD", "钉钉工作台").catch(() => false);

  const openedAttendance =
    await tapAnySelector(browser, attendanceSelectors, "考勤打卡入口", {
      direction: "up",
      maxScrolls: 6,
    }) ||
    await tapConfiguredPoint(browser, "WEIXIN_IOS_DINGTALK_ATTENDANCE_ENTRY_COORD", "考勤打卡入口");

  if (!openedAttendance) {
    fail("未找到钉钉“考勤打卡”入口，请先用 Appium Inspector 确认选择器或配置 WEIXIN_IOS_DINGTALK_ATTENDANCE_ENTRY_COORD。");
  }

  await sleep(3_000);

  const punched =
    await tapAnySelector(
      browser,
      selectorsForTexts(slotSpecificTexts, ["XCUIElementTypeButton", "XCUIElementTypeStaticText"]),
      `${slotLabel}按钮`,
      { direction: "up", maxScrolls: 2 },
    ) ||
    await tapConfiguredPoint(
      browser,
      slotId === "morning"
        ? "WEIXIN_IOS_DINGTALK_MORNING_PUNCH_COORD"
        : slotId === "evening"
          ? "WEIXIN_IOS_DINGTALK_EVENING_PUNCH_COORD"
          : "WEIXIN_IOS_DINGTALK_GENERIC_PUNCH_COORD",
      `${slotLabel}按钮`,
    ) ||
    await tapAnySelector(
      browser,
      selectorsForTexts(genericPunchTexts, ["XCUIElementTypeButton", "XCUIElementTypeStaticText"]),
      "通用打卡按钮",
      { direction: "up", maxScrolls: 1 },
    ) ||
    await tapConfiguredPoint(browser, "WEIXIN_IOS_DINGTALK_GENERIC_PUNCH_COORD", "通用打卡按钮");

  if (!punched) {
    fail(`已进入钉钉考勤页，但未定位到${slotLabel}按钮。请先配置对应坐标或补充选择器。`);
  }

  await sleep(1_500);
  if (CLEAR_DINGTALK_AFTER_CLOCK_IN) {
    await clearDingTalkInBackground(browser, `钉钉${slotLabel}后`);
  }
  console.log(`已在 iPhone 上执行钉钉${slotLabel}流程。`);
}

const WECHAT_SEARCH_INPUT_SELECTORS = [
  '-ios predicate string:type == "XCUIElementTypeSearchField"',
  '-ios predicate string:type == "XCUIElementTypeTextField"',
  '-ios predicate string:type == "XCUIElementTypeTextView"',
];

const WECHAT_SEARCH_FOCUS_SELECTORS = [
  ...WECHAT_SEARCH_INPUT_SELECTORS,
  predicateContains(
    ["搜索本地或网络结果", "搜索"],
    ["XCUIElementTypeStaticText", "XCUIElementTypeOther", "XCUIElementTypeButton"],
  ),
];

const WECHAT_SEARCH_PAGE_SELECTORS = [
  ...WECHAT_SEARCH_INPUT_SELECTORS,
  predicateContains(
    ["搜索本地或网络结果", "最近在搜", "搜索"],
    ["XCUIElementTypeStaticText", "XCUIElementTypeOther", "XCUIElementTypeButton"],
  ),
];

const WECHAT_SEARCH_ENTRY_SELECTORS = [
  '-ios predicate string:type == "XCUIElementTypeSearchField"',
  predicateContains(
    ["搜索"],
    ["XCUIElementTypeButton", "XCUIElementTypeStaticText", "XCUIElementTypeTextField", "XCUIElementTypeOther"],
  ),
];

const WECHAT_SEARCH_SUBMIT_SELECTORS = [
  ...accessibilitySelectors(["搜索"]),
  predicateEquals(["搜索"], ["XCUIElementTypeButton", "XCUIElementTypeStaticText", "XCUIElementTypeOther"]),
  predicateContains(["搜索"], ["XCUIElementTypeButton", "XCUIElementTypeStaticText", "XCUIElementTypeOther"]),
];

const QQ_FARM_RESULT_FALLBACK_SELECTORS = [
  '-ios class chain:**/XCUIElementTypeCollectionView/**/XCUIElementTypeCell[1]',
  '-ios class chain:**/XCUIElementTypeCollectionView/**/XCUIElementTypeButton[1]',
  '-ios class chain:**/XCUIElementTypeTable/**/XCUIElementTypeCell[1]',
  '-ios class chain:**/XCUIElementTypeTable/**/XCUIElementTypeCell[2]',
  '-ios class chain:**/XCUIElementTypeTable/**/XCUIElementTypeButton[1]',
  '-ios class chain:**/XCUIElementTypeCell[1]',
  '-ios class chain:**/XCUIElementTypeButton[1]',
];
const QQ_FARM_FORWARD_SELECTORS = [
  ...accessibilitySelectors(["前往", "游戏入口"]),
  predicateEquals(["前往", "游戏入口"], ["XCUIElementTypeButton"]),
  predicateContains(["前往", "游戏入口"], ["XCUIElementTypeButton", "XCUIElementTypeStaticText"]),
];
const QQ_FARM_MINI_PROGRAM_READY_SELECTORS = [
  ...accessibilitySelectors(["关闭"]),
  predicateEquals(["关闭"], ["XCUIElementTypeButton"]),
  predicateContains(["关闭"], ["XCUIElementTypeButton"]),
];
const QQ_FARM_OFFICIAL_ACCOUNT_SELECTORS = [
  ...accessibilitySelectors(["关注公众号", "私信"]),
  predicateEquals(["关注公众号", "私信"], ["XCUIElementTypeButton"]),
  predicateContains(["关注公众号", "私信"], ["XCUIElementTypeButton"]),
];
const WECHAT_BACK_SELECTORS = [
  ...accessibilitySelectors(["返回"]),
  predicateEquals(["返回"], ["XCUIElementTypeButton"]),
  predicateContains(["返回"], ["XCUIElementTypeButton"]),
];

function buildQqFarmResultSelectors(query) {
  const texts = [
    ...new Set(
      [query, ...QQ_FARM_RESULT_TEXTS]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return selectorsForTexts(
    texts,
    ["XCUIElementTypeButton", "XCUIElementTypeStaticText", "XCUIElementTypeCell", "XCUIElementTypeOther"],
  );
}

function buildQqFarmMiniGameResultSelectors(query) {
  const texts = [
    ...new Set(
      [
        `${query} - 小游戏`,
        "QQ经典农场 - 小游戏",
        "小游戏畅销榜",
        "最近玩过",
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return selectorsForTexts(
    texts,
    ["XCUIElementTypeButton", "XCUIElementTypeStaticText", "XCUIElementTypeCell", "XCUIElementTypeOther"],
  );
}

async function focusWeChatSearchInput(browser) {
  return await tapAnySelector(browser, WECHAT_SEARCH_FOCUS_SELECTORS, "微信搜索输入框", {
    rawTap: true,
  });
}

async function ensureWeChatSearchPage(browser) {
  if (await waitForAnySelector(browser, WECHAT_SEARCH_PAGE_SELECTORS, 500)) {
    return true;
  }

  const openAttempts = [
    async () =>
      await tapAnySelector(browser, WECHAT_SEARCH_ENTRY_SELECTORS, "微信搜索入口", {
        rawTap: true,
      }),
    async () => await tapConfiguredPoint(browser, "WEIXIN_IOS_WECHAT_SEARCH_COORD", "微信搜索入口"),
    async () => await focusWeChatSearchInput(browser),
  ];

  for (const openAttempt of openAttempts) {
    const triggered = await openAttempt().catch(() => false);
    if (!triggered) {
      continue;
    }
    if (await waitForAnySelector(browser, WECHAT_SEARCH_PAGE_SELECTORS, 1_500)) {
      return true;
    }
  }

  return false;
}

async function submitWeChatSearch(browser, query) {
  for (const selector of WECHAT_SEARCH_INPUT_SELECTORS) {
    try {
      const element = await browser.$(selector);
      await element.addValue("\n");
      log(`已通过换行提交微信搜索: ${selector} (${query})`);
      return true;
    } catch {
      // try next strategy
    }
  }

  for (const keyValue of ["\n", "Enter"]) {
    try {
      await browser.keys([keyValue]);
      log(`已通过 browser.keys 提交微信搜索: ${JSON.stringify(keyValue)} (${query})`);
      return true;
    } catch {
      // try next strategy
    }
  }

  return await tapAnySelector(browser, WECHAT_SEARCH_SUBMIT_SELECTORS, "微信键盘搜索键", {
    rawTap: true,
  });
}

async function openWeChatSearchForQuery(browser, query) {
  if (!(await ensureWeChatSearchPage(browser))) {
    return false;
  }

  if (!(await setValueBySelectors(browser, WECHAT_SEARCH_INPUT_SELECTORS, query, "微信搜索框", { rawTap: true }))) {
    return false;
  }

  await sleep(500);
  await submitWeChatSearch(browser, query);
  return true;
}

async function prepareWeChatForSearch(browser) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await hasAnySelector(browser, QQ_FARM_OFFICIAL_ACCOUNT_SELECTORS)) {
      await navigateBack(browser, "公众号页返回按钮").catch(() => false);
      await sleep(800);
      continue;
    }
    if (await hasAnySelector(browser, WECHAT_SEARCH_PAGE_SELECTORS)) {
      return;
    }
    if (
      (await hasAnySelector(browser, WECHAT_SEARCH_ENTRY_SELECTORS)) &&
      !(await hasAnySelector(browser, WECHAT_BACK_SELECTORS))
    ) {
      return;
    }
    if (!(await hasAnySelector(browser, WECHAT_BACK_SELECTORS))) {
      return;
    }
    await navigateBack(browser, "微信返回按钮").catch(() => false);
    await sleep(800);
  }
}

async function waitForQqFarmResultState(browser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasAnySelector(browser, QQ_FARM_MINI_PROGRAM_READY_SELECTORS)) {
      return "mini-program";
    }
    if (await hasAnySelector(browser, QQ_FARM_FORWARD_SELECTORS)) {
      return "detail";
    }
    await sleep(250);
  }

  if (await hasAnySelector(browser, QQ_FARM_MINI_PROGRAM_READY_SELECTORS)) {
    return "mini-program";
  }
  if (await hasAnySelector(browser, QQ_FARM_FORWARD_SELECTORS)) {
    return "detail";
  }
  return undefined;
}

async function ensureQqFarmMiniProgramOpened(browser) {
  const state = await waitForQqFarmResultState(browser, 5_000);
  if (state === "mini-program") {
    return true;
  }
  if (state !== "detail") {
    return false;
  }

  const opened =
    await tapAnySelector(browser, QQ_FARM_FORWARD_SELECTORS, "QQ经典农场前往按钮", {
      rawTap: true,
    });
  if (!opened) {
    return false;
  }

  await sleep(1_000);
  return await waitForAnySelector(browser, QQ_FARM_MINI_PROGRAM_READY_SELECTORS, 8_000);
}

async function navigateBack(browser, description = "返回上一页") {
  return await tapAnySelector(browser, WECHAT_BACK_SELECTORS, description, {
    rawTap: true,
  });
}

async function tryOpenQqFarmSearchResult(browser, query) {
  const attempts = [
    async () =>
      await tapAnySelector(browser, buildQqFarmMiniGameResultSelectors(query), "QQ经典农场小游戏结果", {
        direction: "up",
        maxScrolls: 1,
      }),
    async () =>
      await tapAnySelector(browser, QQ_FARM_RESULT_FALLBACK_SELECTORS, "QQ经典农场首个搜索结果", {
        direction: "up",
        maxScrolls: 1,
      }),
    async () =>
      await tapAnySelector(browser, buildQqFarmResultSelectors(query), "QQ经典农场搜索结果", {
        direction: "up",
        maxScrolls: 2,
      }),
    async () =>
      await tapPointValue(
        browser,
        QQ_FARM_RESULT_COORD,
        "QQ经典农场搜索结果",
        process.env.WEIXIN_IOS_QQ_FARM_RESULT_COORD?.trim()
          ? "WEIXIN_IOS_QQ_FARM_RESULT_COORD"
          : "默认 QQ 农场结果坐标",
      ),
  ];

  for (const attempt of attempts) {
    const clicked = await attempt().catch(() => false);
    if (!clicked) {
      continue;
    }

    if (await ensureQqFarmMiniProgramOpened(browser)) {
      return true;
    }

    if (await hasAnySelector(browser, QQ_FARM_OFFICIAL_ACCOUNT_SELECTORS)) {
      log("当前命中 QQ经典农场公众号页，返回搜索结果后尝试下一个小游戏入口。");
      await navigateBack(browser, "公众号页返回按钮").catch(() => false);
      await sleep(800);
      continue;
    }

    await navigateBack(browser, "结果页返回按钮").catch(() => false);
    await sleep(800);
  }

  return false;
}

async function tapFriendVisitButton(browser) {
  const candidates = await detectFriendVisitButtons(browser);
  if (candidates.length > 0) {
    const first = candidates[0];
    log(`QQ农场好友页识别到 ${candidates.length} 个绿色按钮，首个候选: (${first.x}, ${first.y})`);
    await mobileTapPoint(browser, first, "QQ农场好友页拜访按钮", "截图识别");
    return true;
  }

  return await mobileTapPointValue(
    browser,
    QQ_FARM_FRIEND_VISIT_COORD,
    "QQ农场好友页拜访按钮",
    process.env.WEIXIN_IOS_QQ_FARM_FRIEND_VISIT_COORD?.trim()
      ? "WEIXIN_IOS_QQ_FARM_FRIEND_VISIT_COORD"
      : "默认 QQ 农场拜访坐标",
  );
}

async function runPrimaryFarmAction(browser, sourceLabel, repeat = QQ_FARM_PRIMARY_ACTION_REPEAT) {
  for (let index = 0; index < Math.max(1, repeat); index += 1) {
    await mobileTapPointValue(
      browser,
      QQ_FARM_PRIMARY_ACTION_COORD,
      "QQ农场一键操作按钮",
      sourceLabel,
    );
    if (index < repeat - 1) {
      await sleep(QQ_FARM_PRIMARY_ACTION_DELAY_MS);
    }
  }
}

async function runDefaultQqFarmRoutine(browser) {
  await mobileTapPointValue(
    browser,
    QQ_FARM_REWARD_COORD,
    "QQ农场奖励入口",
    process.env.WEIXIN_IOS_QQ_FARM_REWARD_COORD?.trim()
      ? "WEIXIN_IOS_QQ_FARM_REWARD_COORD"
      : "默认 QQ 农场奖励坐标",
  ).catch(() => false);
  await sleep(800);

  await runPrimaryFarmAction(
    browser,
    process.env.WEIXIN_IOS_QQ_FARM_PRIMARY_ACTION_COORD?.trim()
      ? "WEIXIN_IOS_QQ_FARM_PRIMARY_ACTION_COORD"
      : "默认 QQ 农场一键操作坐标",
  );
  await sleep(1_000);

  const openedFriendList = await mobileTapPointValue(
    browser,
    QQ_FARM_FRIEND_ENTRY_COORD,
    "QQ农场好友入口",
    process.env.WEIXIN_IOS_QQ_FARM_FRIEND_ENTRY_COORD?.trim()
      ? "WEIXIN_IOS_QQ_FARM_FRIEND_ENTRY_COORD"
      : "默认 QQ 农场好友入口坐标",
  );
  if (!openedFriendList) {
    return {
      friendVisited: false,
      message: "已执行自家农场动作，但未打开好友列表。",
    };
  }

  await sleep(QQ_FARM_FRIEND_PAGE_DELAY_MS);
  await mobileTapPointValue(
    browser,
    QQ_FARM_FRIEND_POPUP_CLOSE_COORD,
    "QQ农场好友申请弹窗关闭点",
    process.env.WEIXIN_IOS_QQ_FARM_FRIEND_POPUP_CLOSE_COORD?.trim()
      ? "WEIXIN_IOS_QQ_FARM_FRIEND_POPUP_CLOSE_COORD"
      : "默认 QQ 农场好友弹窗关闭坐标",
  ).catch(() => false);
  await sleep(600);

  const visited = await tapFriendVisitButton(browser);
  if (!visited) {
    return {
      friendVisited: false,
      message: "已执行自家农场动作，但未识别到好友拜访按钮。",
    };
  }

  await sleep(QQ_FARM_POST_VISIT_DELAY_MS);
  await runPrimaryFarmAction(
    browser,
    process.env.WEIXIN_IOS_QQ_FARM_PRIMARY_ACTION_COORD?.trim()
      ? "WEIXIN_IOS_QQ_FARM_PRIMARY_ACTION_COORD"
      : "默认 QQ 农场一键操作坐标",
  );
  return {
    friendVisited: true,
    message: "已执行领取奖励、自家农场一键操作，并完成好友拜访与偷菜动作。",
  };
}

async function runQqFarm(browser) {
  await browser.launchApp({ bundleId: WECHAT_BUNDLE_ID });
  await sleep(2_000);
  await tapAnySelector(browser, QQ_FARM_MINI_PROGRAM_READY_SELECTORS, "QQ农场小程序关闭按钮", {
    rawTap: true,
  }).catch(() => false);
  await sleep(1_000);
  await prepareWeChatForSearch(browser);

  let openedSearchResult = false;
  let searchReadyOnce = false;
  for (const query of QQ_FARM_QUERY_CANDIDATES) {
    const searchReady = await openWeChatSearchForQuery(browser, query);
    if (!searchReady) {
      continue;
    }
    searchReadyOnce = true;

    await sleep(1_800);

    openedSearchResult = await tryOpenQqFarmSearchResult(browser, query);

    if (!openedSearchResult) {
      log(`查询词 ${query} 未命中 QQ经典农场 结果，尝试下一个候选搜索词。`);
      await sleep(800);
      continue;
    }
    break;
  }

  if (!searchReadyOnce) {
    fail("未找到微信搜索框，请先配置 WEIXIN_IOS_WECHAT_SEARCH_COORD。");
  }

  if (!openedSearchResult) {
    fail("未找到 QQ经典农场 小程序入口，请检查查询词、搜索结果或前往按钮。");
  }

  await sleep(3_000);

  const canvasSteps = parseCanvasSteps();
  if (canvasSteps.length > 0) {
    await executeCanvasSteps(browser, canvasSteps);
    console.log("已打开 QQ经典农场，并执行配置的画布点击步骤。");
    return;
  }

  const routineResult = await runDefaultQqFarmRoutine(browser);
  console.log(`已打开 QQ经典农场 小程序，${routineResult.message}`);
}

async function runExitDingTalk(browser) {
  await clearDingTalkInBackground(browser, "退出命令");
  console.log("已关闭 iPhone 上的钉钉。");
}

async function main() {
  if (!action || action === "--help" || action === "-h") {
    printUsage();
    return;
  }

  if (action === "doctor") {
    await runDoctor();
    return;
  }

  if (!["dingtalk-clock-in", "qq-farm", "exit-dingtalk"].includes(action)) {
    fail(`不支持的动作: ${action}`);
  }

  let browser;
  try {
    browser = await createBrowserForAction(action);
    if (action === "dingtalk-clock-in") {
      await runDingTalkClockIn(browser);
      return;
    }
    if (action === "qq-farm") {
      await runQqFarm(browser);
      return;
    }
    await runExitDingTalk(browser);
  } finally {
    await browser?.deleteSession().catch(() => {});
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ios-automation] ${message}`);
  process.exit(1);
});
