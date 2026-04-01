import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { sendProactiveTextMessageCompat } from "./proactive-sdk-compat.js";

const DAILY_CRYPTO_BRIEFING_HOUR = 8;
const DAILY_CRYPTO_BRIEFING_MINUTE = 0;
const STATE_FILE = path.join(homedir(), ".openclaw", "weixin-agent-sdk", "daily-crypto-briefing-state.json");
const BINANCE_API_BASE_URL =
  process.env.WEIXIN_CRYPTO_API_BASE_URL?.trim() || "https://api.binance.com/api/v3";
const LBMA_GOLD_PM_URL =
  process.env.WEIXIN_GOLD_PM_URL?.trim() || "https://prices.lbma.org.uk/json/gold_pm.json";
const DEFAULT_QUOTE_ASSET = process.env.WEIXIN_CRYPTO_QUOTE_ASSET?.trim().toUpperCase() || "USDT";

type SchedulerHandle = {
  stop(): void;
};

type DailyCryptoBriefingState = {
  lastSentDate?: string;
  lastSentAt?: string;
};

type DailyCryptoBriefingSchedulerOptions = {
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
};

type CryptoAsset = {
  symbol: string;
};

type BinanceTicker = {
  symbol?: string;
  lastPrice?: string;
  priceChangePercent?: string;
};

type LbmaGoldFix = {
  d?: string;
  v?: number[];
};

const DEFAULT_CRYPTO_ASSETS: CryptoAsset[] = [
  { symbol: "BTC" },
  { symbol: "ETH" },
  { symbol: "SOL" },
  { symbol: "BNB" },
  { symbol: "XRP" },
  { symbol: "DOGE" },
];

function isDailyCryptoBriefingEnabled(): boolean {
  const raw = process.env.WEIXIN_DAILY_CRYPTO_BRIEFING?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveNextRun(now: Date): Date {
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    DAILY_CRYPTO_BRIEFING_HOUR,
    DAILY_CRYPTO_BRIEFING_MINUTE,
    0,
    0,
  );
  if (now.getTime() < target.getTime()) {
    return target;
  }
  target.setDate(target.getDate() + 1);
  return target;
}

function resolveCryptoAssets(): CryptoAsset[] {
  const raw = process.env.WEIXIN_CRYPTO_IDS?.trim();
  if (!raw) {
    return DEFAULT_CRYPTO_ASSETS;
  }

  const ids = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (ids.length === 0) {
    return DEFAULT_CRYPTO_ASSETS;
  }

  return ids.map((id) => ({ symbol: id.toUpperCase() }));
}

async function loadState(): Promise<DailyCryptoBriefingState> {
  try {
    const content = await readFile(STATE_FILE, "utf8");
    return JSON.parse(content) as DailyCryptoBriefingState;
  } catch {
    return {};
  }
}

async function saveState(state: DailyCryptoBriefingState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function formatPrice(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} ${DEFAULT_QUOTE_ASSET}`;
}

function formatChange(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "24h --";
  }
  const sign = value > 0 ? "+" : "";
  return `24h ${sign}${value.toFixed(2)}%`;
}

function formatFixChange(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "较上一定盘 --";
  }
  const sign = value > 0 ? "+" : "";
  return `较上一定盘 ${sign}${value.toFixed(2)}%`;
}

async function fetchGoldSummaryLine(): Promise<string> {
  const response = await fetch(LBMA_GOLD_PM_URL);
  if (!response.ok) {
    throw new Error(`LBMA 接口返回 ${response.status}`);
  }

  const payload = (await response.json()) as LbmaGoldFix[];
  const fixes = payload.filter(
    (item): item is Required<Pick<LbmaGoldFix, "d" | "v">> =>
      typeof item.d === "string" &&
      Array.isArray(item.v) &&
      typeof item.v[0] === "number",
  );

  const latest = fixes[fixes.length - 1];
  const previous = fixes[fixes.length - 2];
  if (!latest || !previous) {
    throw new Error("LBMA 数据不足，无法计算黄金涨跌幅");
  }

  const latestUsd = latest.v[0];
  const previousUsd = previous.v[0];
  const changePercent = previousUsd === 0
    ? null
    : ((latestUsd - previousUsd) / previousUsd) * 100;

  return `黄金(LBMA PM): ${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(latestUsd)} USD/oz | ${formatFixChange(changePercent)} | ${latest.d}`;
}

async function fetchCryptoBriefingText(): Promise<string> {
  const assets = resolveCryptoAssets();
  const symbols = assets.map((asset) => `${asset.symbol}${DEFAULT_QUOTE_ASSET}`);
  const response = await fetch(
    `${BINANCE_API_BASE_URL}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
  );

  if (!response.ok) {
    throw new Error(`Binance 接口返回 ${response.status}`);
  }

  const payload = (await response.json()) as BinanceTicker[];
  const tickerMap = new Map(
    payload
      .filter((item): item is Required<Pick<BinanceTicker, "symbol" | "lastPrice" | "priceChangePercent">> => (
        typeof item.symbol === "string" &&
        typeof item.lastPrice === "string" &&
        typeof item.priceChangePercent === "string"
      ))
      .map((item) => [item.symbol, item]),
  );

  const lines = assets.map((asset) => {
    const item = tickerMap.get(`${asset.symbol}${DEFAULT_QUOTE_ASSET}`);
    const price = item ? Number.parseFloat(item.lastPrice) : Number.NaN;
    const change = item ? Number.parseFloat(item.priceChangePercent) : Number.NaN;

    if (Number.isNaN(price)) {
      return `${asset.symbol}: 数据暂缺 | ${formatChange(null)}`;
    }

    return `${asset.symbol}: ${formatPrice(price)} | ${formatChange(
      Number.isNaN(change) ? null : change,
    )}`;
  });

  let goldLine = "黄金(LBMA PM): 数据暂缺 | 较上一定盘 --";
  try {
    goldLine = await fetchGoldSummaryLine();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    goldLine = `黄金(LBMA PM): 数据暂缺 | ${message}`;
  }

  return [
    `早报 | 主流虚拟货币行情 (${DEFAULT_QUOTE_ASSET})`,
    goldLine,
    ...lines,
    "数据源: LBMA PM Fix, Binance 24hr Ticker",
  ].join("\n");
}

export function startDailyCryptoBriefingScheduler(
  opts?: DailyCryptoBriefingSchedulerOptions,
): SchedulerHandle | undefined {
  if (!isDailyCryptoBriefingEnabled()) {
    return undefined;
  }

  const log = opts?.log ?? console.log;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const stop = () => {
    stopped = true;
    clearTimer();
    opts?.abortSignal?.removeEventListener("abort", stop);
  };

  const scheduleNextRun = async () => {
    if (stopped) {
      return;
    }

    clearTimer();
    const target = resolveNextRun(new Date());
    log(`[daily-crypto] 下一次发送时间: ${target.toLocaleString("zh-CN", { hour12: false })}`);
    timer = setTimeout(() => {
      void runScheduledSend();
    }, Math.max(target.getTime() - Date.now(), 0));
  };

  const runScheduledSend = async () => {
    if (stopped) {
      return;
    }

    try {
      const now = new Date();
      const today = formatDate(now);
      const state = await loadState();

      if (state.lastSentDate === today) {
        log(`[daily-crypto] ${today} 已发送过，跳过重复发送`);
        return;
      }

      const text = await fetchCryptoBriefingText();
      await sendProactiveTextMessageCompat({ text });
      log(`[daily-crypto] ${today} 已发送主流虚拟货币行情`);
      await saveState({
        lastSentDate: today,
        lastSentAt: now.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[daily-crypto] 发送失败: ${message}`);
    } finally {
      await scheduleNextRun();
    }
  };

  opts?.abortSignal?.addEventListener("abort", stop, { once: true });
  void scheduleNextRun();

  return { stop };
}
