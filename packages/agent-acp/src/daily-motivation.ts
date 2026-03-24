import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { sendProactiveTextMessage } from "weixin-agent-sdk";

const DAILY_MOTIVATION_HOUR = 9;
const DAILY_MOTIVATION_MINUTE = 5;
const STATE_FILE = path.join(homedir(), ".openclaw", "weixin-agent-sdk", "daily-motivation-state.json");

const DAILY_MOTIVATIONS = [
  "早上好。今天先把眼前最重要的一件事做好，节奏稳住，后面的事情会顺很多。",
  "新的一天开始了。你不需要一下子完成很多，只要持续往前走，今天就会很有收获。",
  "今天也值得认真对待。状态可以慢慢热起来，但方向要清晰，行动会带来底气。",
  "早安。别低估稳定输出的力量，你今天认真完成的每一步，都会在后面体现价值。",
  "今天继续稳住心气，把该做的事情一件件推进，你会看到自己比想象中更可靠。",
  "不用追求一开始就完美，先动起来、先推进，很多好结果都是这样慢慢做出来的。",
  "今天比昨天又多了一点经验和判断，把这份清醒用在行动上，事情会越来越顺。",
  "今天也别内耗，专注、利索、持续往前推，你会看到自己正在慢慢进入状态。",
  "新的一天，新的机会。把精神提起来，今天依然有机会把很多事情做漂亮。",
  "真正让人发光的不是一时爆发，而是日复一日的靠谱。你今天继续稳稳做好就够了。",
  "今天不是在碰运气，而是在积累胜率。把自己的节奏走稳，结果自然会向你靠近。",
  "别怕今天有难度，很多厉害的结果都来自再坚持一点、再往前一步。",
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
