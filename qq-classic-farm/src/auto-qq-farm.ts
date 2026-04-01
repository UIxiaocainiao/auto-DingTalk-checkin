import { runQqFarmCommand } from "../../packages/agent-acp/src/local-command-agent.js";

const DEFAULT_INTERVAL_MINUTES = Number.parseInt(process.env.WEIXIN_QQ_FARM_INTERVAL_MINUTES ?? "5", 10);

type AutoQqFarmSchedulerOptions = {
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
};

type SchedulerHandle = {
  stop(): void;
};

function isAutoQqFarmEnabled(): boolean {
  const raw = process.env.WEIXIN_AUTO_QQ_FARM?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function resolveIntervalMinutes(): number {
  if (Number.isFinite(DEFAULT_INTERVAL_MINUTES) && DEFAULT_INTERVAL_MINUTES > 0) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return 5;
}

function resolveNextRun(now: Date, intervalMinutes: number): Date {
  const target = new Date(now);
  target.setSeconds(0, 0);

  const remainder = target.getMinutes() % intervalMinutes;
  const deltaMinutes = remainder === 0 ? intervalMinutes : intervalMinutes - remainder;
  target.setMinutes(target.getMinutes() + deltaMinutes);
  return target;
}

export function startAutoQqFarmScheduler(
  opts?: AutoQqFarmSchedulerOptions,
): SchedulerHandle | undefined {
  if (!isAutoQqFarmEnabled()) {
    return undefined;
  }

  const intervalMinutes = resolveIntervalMinutes();
  const log = opts?.log ?? console.log;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
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

  const scheduleNextRun = () => {
    if (stopped) {
      return;
    }

    clearTimer();
    const target = resolveNextRun(new Date(), intervalMinutes);
    log(`[auto-qq-farm] 下一次执行时间: ${target.toLocaleString("zh-CN", { hour12: false })}`);
    timer = setTimeout(() => {
      void runScheduledOpen();
    }, Math.max(target.getTime() - Date.now(), 0));
  };

  const runScheduledOpen = async () => {
    if (stopped) {
      return;
    }

    if (running) {
      log("[auto-qq-farm] 上一次执行仍未结束，本轮跳过");
      scheduleNextRun();
      return;
    }

    running = true;
    try {
      log("[auto-qq-farm] 开始执行 QQ经典农场自动流程");
      const result = await runQqFarmCommand();
      log(`[auto-qq-farm] 执行完成: ${result.text ?? "已执行 QQ经典农场自动流程"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[auto-qq-farm] 执行失败: ${message}`);
    } finally {
      running = false;
      scheduleNextRun();
    }
  };

  opts?.abortSignal?.addEventListener("abort", stop, { once: true });
  scheduleNextRun();

  return { stop };
}
