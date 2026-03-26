#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login only
 *   npx weixin-acp start -- <command> [args...]    # QR-code login + start bot
 *
 * Examples:
 *   npx weixin-acp start -- codex-acp
 *   npx weixin-acp start -- node ./my-agent.js
 */

import { login, start } from "weixin-agent-sdk";

import { AcpAgent } from "./src/acp-agent.js";
import { startAutoClockInScheduler } from "./src/auto-clock-in.js";
import { startDailyCryptoBriefingScheduler } from "./src/daily-crypto-briefing.js";
import { startDailyMotivationScheduler } from "./src/daily-motivation.js";
import { LocalCommandAgent } from "./src/local-command-agent.js";

const command = process.argv[2];
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const CODEX_ACP_NAMES = new Set(["codex-acp", "@zed-industries/codex-acp"]);
const EXIT_AFTER_LOGIN = process.env.WEIXIN_EXIT_AFTER_LOGIN === "1";

function isCodexAcpInvocation(acpCommand: string, acpArgs: string[]): boolean {
  const tokens = [acpCommand, ...acpArgs];
  return tokens.some((token) => {
    const normalized = token.trim().toLowerCase();
    return CODEX_ACP_NAMES.has(normalized);
  });
}

function hasCodexModelOverride(acpArgs: string[]): boolean {
  for (let i = 0; i < acpArgs.length; i += 1) {
    const arg = acpArgs[i];
    if ((arg === "-c" || arg === "--config") && i + 1 < acpArgs.length) {
      if (acpArgs[i + 1].trim().startsWith("model=")) {
        return true;
      }
      continue;
    }
    if (arg.startsWith("--config=") && arg.slice("--config=".length).trim().startsWith("model=")) {
      return true;
    }
  }
  return false;
}

function isNpxLikeCommand(commandName: string): boolean {
  const normalized = commandName.trim().toLowerCase();
  return normalized === "npx" || normalized === "npm";
}

function insertCodexModelArg(acpCommand: string, acpArgs: string[]): string[] {
  const modelArg = `model="${DEFAULT_CODEX_MODEL}"`;

  if (!isNpxLikeCommand(acpCommand)) {
    return ["-c", modelArg, ...acpArgs];
  }

  const packageIndex = acpArgs.findIndex((arg) =>
    CODEX_ACP_NAMES.has(arg.trim().toLowerCase()),
  );
  if (packageIndex === -1) {
    return ["-c", modelArg, ...acpArgs];
  }

  return [
    ...acpArgs.slice(0, packageIndex + 1),
    "-c",
    modelArg,
    ...acpArgs.slice(packageIndex + 1),
  ];
}

function resolveAcpArgs(acpCommand: string, acpArgs: string[]): {
  args: string[];
  defaultCodexModelApplied: boolean;
} {
  if (!isCodexAcpInvocation(acpCommand, acpArgs) || hasCodexModelOverride(acpArgs)) {
    return { args: acpArgs, defaultCodexModelApplied: false };
  }
  return {
    args: insertCodexModelArg(acpCommand, acpArgs),
    defaultCodexModelApplied: true,
  };
}

async function main() {
  switch (command) {
    case "login": {
      const accountId = await login();
      console.log(`[weixin-acp] 扫码成功，已完成登录，account=${accountId}`);
      break;
    }

    case "start": {
      if (EXIT_AFTER_LOGIN) {
        const accountId = await login();
        console.log(`[weixin-acp] 扫码成功，已完成登录，account=${accountId}`);
        console.log("[weixin-acp] WEIXIN_EXIT_AFTER_LOGIN=1，已在登录成功后退出。");
        break;
      }

      const ddIndex = process.argv.indexOf("--");
      if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
        console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
        console.error("示例: npx weixin-acp start -- codex-acp");
        process.exit(1);
      }

      const [acpCommand, ...rawAcpArgs] = process.argv.slice(ddIndex + 1);
      const resolved = resolveAcpArgs(acpCommand, rawAcpArgs);
      const acpArgs = resolved.args;
      if (resolved.defaultCodexModelApplied) {
        console.log(`[weixin-acp] codex-acp 未指定 model，默认使用 ${DEFAULT_CODEX_MODEL}`);
      }

      const ac = new AbortController();
      const baseAgent = new AcpAgent({
        command: acpCommand,
        args: acpArgs,
      });
      const agent = new LocalCommandAgent(baseAgent);
      const autoClockIn = startAutoClockInScheduler({
        abortSignal: ac.signal,
        log: console.log,
      });
      const dailyMotivation = startDailyMotivationScheduler({
        abortSignal: ac.signal,
        log: console.log,
      });
      const dailyCryptoBriefing = startDailyCryptoBriefingScheduler({
        abortSignal: ac.signal,
        log: console.log,
      });

      // Graceful shutdown
      process.on("SIGINT", () => {
        console.log("\n正在停止...");
        baseAgent.dispose();
        autoClockIn?.stop();
        dailyMotivation?.stop();
        dailyCryptoBriefing?.stop();
        ac.abort();
      });
      process.on("SIGTERM", () => {
        baseAgent.dispose();
        autoClockIn?.stop();
        dailyMotivation?.stop();
        dailyCryptoBriefing?.stop();
        ac.abort();
      });

      await start(agent, { abortSignal: ac.signal });
      break;
    }

    default:
      console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          仅扫码登录微信
  npx weixin-acp start -- <command> [args...]    每次启动前重新扫码并启动 bot

示例:
  npx weixin-acp start -- codex-acp
  npx weixin-acp start -- node ./my-agent.js`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
