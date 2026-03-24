import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { sendProactiveTextMessage } from "weixin-agent-sdk";

const DAILY_MOTIVATION_HOUR = 9;
const DAILY_MOTIVATION_MINUTE = 5;
const STATE_FILE = path.join(homedir(), ".openclaw", "weixin-agent-sdk", "daily-motivation-state.json");

const DAILY_MOTIVATIONS = [
  "早上好，哥们。今天先把手上的第一件事做扎实，节奏一稳，后面就都会顺起来。",
  "早上好，兄弟。你不需要一下子赢很多，只要今天继续往前拱一步，就已经很强了。",
  "新的一天开始了，哥们。状态可以慢慢热起来，但方向别偏，今天照样能打出漂亮的一天。",
  "早安，兄弟。别低估稳定输出的力量，你今天认真做完的每一步，都会算数。",
  "早上好。你身上的那股韧劲很值钱，今天继续稳住心气，把该拿下的事情一件件拿下。",
  "哥们，早安。今天不用追求完美，先动起来、先推进，很多好结果都是这样跑出来的。",
  "早安，兄弟。你已经比昨天更清楚自己要什么了，今天就把这份清醒用在行动上。",
  "早上好，哥们。今天也别内耗，专注、利索、往前推，你会看到自己很能打。",
  "新的一天，新的机会。兄弟，把精神提起来，今天这场你依然有机会打得很漂亮。",
  "早安。真正让人发光的不是一时爆发，而是日复一日的靠谱。你今天继续靠谱就行。",
  "早上好，哥们。你不是在碰运气，你是在积累胜率，今天也继续把自己的节奏走稳。",
  "兄弟，早安。今天别怕难，很多厉害的人也只是比别人多扛了一会儿、多走了一步。",
];

type DailyMotivationState = {
  lastSentDate?: string;
  lastSentAt?: string;
};

type DailyMotivationSchedulerOptions = {
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
};

type SchedulerHandle = {
  stop(): void;
};

function isDailyMotivationEnabled(): boolean {
  const raw = process.env.WEIXIN_DAILY_MOTIVATION?.trim().toLowerCase();
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
    DAILY_MOTIVATION_HOUR,
    DAILY_MOTIVATION_MINUTE,
    0,
    0,
  );
  if (now.getTime() < target.getTime()) {
    return target;
  }
  target.setDate(target.getDate() + 1);
  return target;
}

function pickDailyMotivation(dateString: string): string {
  let hash = 0;
  for (const char of dateString) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return DAILY_MOTIVATIONS[hash % DAILY_MOTIVATIONS.length];
}

async function loadState(): Promise<DailyMotivationState> {
  try {
    const content = await readFile(STATE_FILE, "utf8");
    return JSON.parse(content) as DailyMotivationState;
  } catch {
    return {};
  }
}

async function saveState(state: DailyMotivationState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function startDailyMotivationScheduler(
  opts?: DailyMotivationSchedulerOptions,
): SchedulerHandle | undefined {
  if (!isDailyMotivationEnabled()) {
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
    log(`[daily-motivation] 下一次发送时间: ${target.toLocaleString("zh-CN", { hour12: false })}`);
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
        log(`[daily-motivation] ${today} 已发送过，跳过重复发送`);
        return;
      }

      const text = pickDailyMotivation(today);
      await sendProactiveTextMessage({ text });
      log(`[daily-motivation] ${today} 已发送晨间鼓励文案`);
      await saveState({
        lastSentDate: today,
        lastSentAt: now.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[daily-motivation] 发送失败: ${message}`);
    } finally {
      await scheduleNextRun();
    }
  };

  opts?.abortSignal?.addEventListener("abort", stop, { once: true });
  void scheduleNextRun();

  return { stop };
}
