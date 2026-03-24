import { spawn, spawnSync, type ChildProcess } from "node:child_process";

type KeepAwakeHandle = {
  stop(): void;
};

function isKeepAwakeEnabled(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }

  const raw = process.env.WEIXIN_MACOS_KEEP_AWAKE?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function startMacOsKeepAwake(log: (msg: string) => void): KeepAwakeHandle | undefined {
  if (!isKeepAwakeEnabled()) {
    return undefined;
  }

  const probe = spawnSync("caffeinate", ["-h"], { stdio: "ignore" });
  if (probe.error) {
    log(`[weixin] 未启用 macOS 防休眠: ${probe.error.message}`);
    return undefined;
  }

  let child: ChildProcess | undefined;
  try {
    child = spawn("caffeinate", ["-i", "-m", "-s", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[weixin] 启动 macOS 防休眠失败: ${message}`);
    return undefined;
  }

  child.on("error", (error) => {
    log(`[weixin] macOS 防休眠异常退出: ${error.message}`);
  });
  child.unref();

  log("[weixin] macOS 已启用后台防休眠，锁屏后可继续运行（合盖或系统关机除外）");

  return {
    stop() {
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}
