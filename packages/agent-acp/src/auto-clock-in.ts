import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { runAttendanceCommand } from "./local-command-agent.js";

const HOLIDAY_INFO_API_BASE_URL =
  process.env.WEIXIN_HOLIDAY_API_BASE_URL?.trim() || "https://timor.tech/api/holiday/info";
const NEXT_WORKDAY_API_BASE_URL =
  process.env.WEIXIN_HOLIDAY_NEXT_WORKDAY_API_BASE_URL?.trim() || "https://timor.tech/api/holiday/workday/next";
const RETRY_DELAY_MS = 5 * 60_000;
const STATE_FILE = path.join(homedir(), ".openclaw", "weixin-agent-sdk", "auto-clock-in-state.json");
const RUN_HISTORY_RETENTION_DAYS = 14;

type AutoClockInSlotId = "morning" | "evening";

type AutoClockInSlotConfig = {
  id: AutoClockInSlotId;
  label: string;
  hour: number;
  startMinute: number;
  endMinute: number;
};

const AUTO_CLOCK_IN_SLOTS: AutoClockInSlotConfig[] = [
  {
    id: "morning",
    label: "上班",
    hour: 9,
    startMinute: 1,
    endMinute: 10,
  },
  {
    id: "evening",
    label: "下班",
    hour: 18,
    startMinute: 10,
    endMinute: 20,
  },
];

type AutoClockInSchedulerOptions = {
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
};

type AutoClockInState = {
  lastRunDate?: string;
  lastRunAt?: string;
  runs?: Record<string, Partial<Record<AutoClockInSlotId, string>>>;
};

type HolidayInfoResponse = {
  code?: number;
  type?: {
    type?: number;
    name?: string;
  };
};

type NextWorkdayResponse = {
  code?: number;
  workday?: {
    date?: string;
  } | null;
};

type SchedulerHandle = {
  stop(): void;
};

type ScheduledClockIn = {
  dateString: string;
  slot: AutoClockInSlotConfig;
  targetAt: Date;
};

function isAutoClockInEnabled(): boolean {
  const raw = process.env.WEIXIN_AUTO_CLOCK_IN?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(date: Date): string {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${formatDate(date)} ${hour}:${minute}:${second}`;
}

function parseLocalDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function pickRandomMinute(minMinute: number, maxMinute: number): number {
  const span = maxMinute - minMinute + 1;
  return minMinute + Math.floor(Math.random() * span);
}

async function loadState(): Promise<AutoClockInState> {
  try {
    const content = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(content) as AutoClockInState;
    const runs: Record<string, Partial<Record<AutoClockInSlotId, string>>> = {
      ...(parsed.runs ?? {}),
    };

    // Compatibility with the previous "once per day" scheduler.
    if (parsed.lastRunDate && !runs[parsed.lastRunDate]?.morning) {
      runs[parsed.lastRunDate] = {
        ...(runs[parsed.lastRunDate] ?? {}),
        morning: parsed.lastRunAt ?? `${parsed.lastRunDate}T09:00:00`,
      };
    }

    return {
      ...parsed,
      runs,
    };
  } catch {
    return {};
  }
}

async function saveState(state: AutoClockInState): Promise<void> {
  const runs = pruneRuns(state.runs ?? {});
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(
    STATE_FILE,
    `${JSON.stringify(
      {
        ...state,
        runs,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function pruneRuns(
  runs: Record<string, Partial<Record<AutoClockInSlotId, string>>>,
): Record<string, Partial<Record<AutoClockInSlotId, string>>> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RUN_HISTORY_RETENTION_DAYS);
  const cutoffDate = formatDate(cutoff);

  return Object.fromEntries(
    Object.entries(runs).filter(([dateString]) => dateString >= cutoffDate),
  );
}

function hasRunSlot(state: AutoClockInState, dateString: string, slotId: AutoClockInSlotId): boolean {
  return Boolean(state.runs?.[dateString]?.[slotId]);
}

function markRunSlot(
  state: AutoClockInState,
  dateString: string,
  slotId: AutoClockInSlotId,
  ranAt: Date,
): AutoClockInState {
  const runs = {
    ...(state.runs ?? {}),
    [dateString]: {
      ...(state.runs?.[dateString] ?? {}),
      [slotId]: ranAt.toISOString(),
    },
  };

  return {
    ...state,
    lastRunDate: dateString,
    lastRunAt: ranAt.toISOString(),
    runs,
  };
}

async function fetchHolidayType(dateString: string): Promise<number> {
  const response = await fetch(`${HOLIDAY_INFO_API_BASE_URL}/${dateString}`);
  if (!response.ok) {
    throw new Error(`节假日接口返回 ${response.status}`);
  }

  const json = (await response.json()) as HolidayInfoResponse;
  if (json.code !== 0 || typeof json.type?.type !== "number") {
    throw new Error(`节假日接口返回异常数据: ${JSON.stringify(json)}`);
  }
  return json.type.type;
}

async function isChinaLegalWorkday(dateString: string): Promise<boolean> {
  const holidayType = await fetchHolidayType(dateString);
  return holidayType === 0 || holidayType === 3;
}

async function fetchNextWorkday(dateString: string): Promise<string> {
  const response = await fetch(`${NEXT_WORKDAY_API_BASE_URL}/${dateString}`);
  if (!response.ok) {
    throw new Error(`下一个工作日接口返回 ${response.status}`);
  }

  const json = (await response.json()) as NextWorkdayResponse;
  const nextDate = json.workday?.date;
  if (json.code !== 0 || !nextDate) {
    throw new Error(`下一个工作日接口返回异常数据: ${JSON.stringify(json)}`);
  }
  return nextDate;
}

function resolveMinuteRange(
  now: Date,
  candidateDateString: string,
  slot: AutoClockInSlotConfig,
): { min: number; max: number } | undefined {
  let minMinute = slot.startMinute;
  const maxMinute = slot.endMinute;

  if (formatDate(now) !== candidateDateString) {
    return { min: minMinute, max: maxMinute };
  }

  if (now.getHours() > slot.hour) {
    return undefined;
  }

  if (now.getHours() === slot.hour) {
    minMinute = Math.max(minMinute, now.getMinutes() + 1);
  }

  if (minMinute > maxMinute) {
    return undefined;
  }

  return { min: minMinute, max: maxMinute };
}

async function findNextTargetDateTime(args: {
  now: Date;
  state: AutoClockInState;
}): Promise<ScheduledClockIn> {
  const { now, state } = args;
  const todayDate = formatDate(now);

  if (await isChinaLegalWorkday(todayDate)) {
    for (const slot of AUTO_CLOCK_IN_SLOTS) {
      if (hasRunSlot(state, todayDate, slot.id)) {
        continue;
      }

      const minuteRange = resolveMinuteRange(now, todayDate, slot);
      if (!minuteRange) {
        continue;
      }

      const minute = pickRandomMinute(minuteRange.min, minuteRange.max);
      const targetDay = parseLocalDate(todayDate);
      return {
        dateString: todayDate,
        slot,
        targetAt: new Date(
          targetDay.getFullYear(),
          targetDay.getMonth(),
          targetDay.getDate(),
          slot.hour,
          minute,
          0,
          0,
        ),
      };
    }
  }

  const nextWorkdayDate = await fetchNextWorkday(todayDate);
  const firstSlot = AUTO_CLOCK_IN_SLOTS[0];
  const targetDay = parseLocalDate(nextWorkdayDate);
  return {
    dateString: nextWorkdayDate,
    slot: firstSlot,
    targetAt: new Date(
      targetDay.getFullYear(),
      targetDay.getMonth(),
      targetDay.getDate(),
      firstSlot.hour,
      pickRandomMinute(firstSlot.startMinute, firstSlot.endMinute),
      0,
      0,
    ),
  };
}

export function startAutoClockInScheduler(opts?: AutoClockInSchedulerOptions): SchedulerHandle | undefined {
  if (!isAutoClockInEnabled()) {
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

  const scheduleRetry = () => {
    if (stopped) {
      return;
    }
    clearTimer();
    log(`[auto-clock-in] 将在 ${Math.round(RETRY_DELAY_MS / 60_000)} 分钟后重试排期`);
    timer = setTimeout(() => {
      void scheduleNextRun();
    }, RETRY_DELAY_MS);
  };

  const scheduleNextRun = async () => {
    if (stopped) {
      return;
    }

    clearTimer();

    try {
      const state = await loadState();
      const now = new Date();
      const target = await findNextTargetDateTime({
        now,
        state,
      });

      const delayMs = Math.max(target.targetAt.getTime() - now.getTime(), 0);
      log(`[auto-clock-in] 下一次自动打卡时间: ${formatDateTime(target.targetAt)} (${target.slot.label})`);
      timer = setTimeout(() => {
        void runScheduledClockIn(target);
      }, delayMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[auto-clock-in] 计算下一次自动打卡时间失败: ${message}`);
      scheduleRetry();
    }
  };

  const runScheduledClockIn = async (scheduled: ScheduledClockIn) => {
    if (stopped) {
      return;
    }

    try {
      const now = new Date();
      const state = await loadState();
      const today = formatDate(now);

      if (today !== scheduled.dateString) {
        log(`[auto-clock-in] 已错过 ${scheduled.dateString} ${scheduled.slot.label}打卡窗口，重新排期`);
        return;
      }

      if (hasRunSlot(state, today, scheduled.slot.id)) {
        log(`[auto-clock-in] ${today} ${scheduled.slot.label}已自动打卡过，跳过重复执行`);
        return;
      }

      if (!(await isChinaLegalWorkday(today))) {
        log(`[auto-clock-in] ${today} 不是中国法定工作日，跳过自动打卡`);
        return;
      }

      log(`[auto-clock-in] 开始执行 ${today} ${scheduled.slot.label}自动打卡`);
      const result = await runAttendanceCommand({ headless: true });
      log(`[auto-clock-in] ${scheduled.slot.label}自动打卡完成: ${result.text ?? "自动打卡已完成"}`);

      await saveState(markRunSlot(state, today, scheduled.slot.id, now));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[auto-clock-in] 自动打卡失败: ${message}`);
    } finally {
      await scheduleNextRun();
    }
  };

  opts?.abortSignal?.addEventListener("abort", stop, { once: true });
  void scheduleNextRun();

  return { stop };
}
