import type { Agent } from "./agent/interface.js";
import {
  DEFAULT_BASE_URL,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  saveWeixinAccount,
} from "./auth/accounts.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "./auth/login-qr.js";
import {
  type LoginQrCodeInfo,
  writeLoginQrImage,
} from "./auth/login-qr-output.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import { startMacOsKeepAwake } from "./util/macos-keep-awake.js";

export type LoginOptions = {
  /** Override the API base URL. */
  baseUrl?: string;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
  /** Called whenever a QR code is generated or refreshed. */
  onQrCode?: (info: LoginQrCodeInfo) => Promise<void> | void;
};

export type StartOptions = {
  /** Expected account ID after QR login. */
  accountId?: string;
  /** Override the API base URL used during QR login. */
  baseUrl?: string;
  /** AbortSignal to stop the bot. */
  abortSignal?: AbortSignal;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
  /** Called whenever a QR code is generated or refreshed during startup login. */
  onQrCode?: (info: LoginQrCodeInfo) => Promise<void> | void;
};

let pendingLoggedInAccountId: string | undefined;

/**
 * Interactive QR-code login. Prints the QR code to the terminal and waits
 * for the user to scan it with WeChat.
 *
 * Returns the normalized account ID on success.
 */
export async function login(opts?: LoginOptions): Promise<string> {
  const log = opts?.log ?? console.log;
  const apiBaseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const onQrCode = opts?.onQrCode;

  log("正在启动微信扫码登录...");

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!startResult.qrcodeUrl) {
    throw new Error(startResult.message);
  }

  await announceQrCode({
    sessionKey: startResult.sessionKey,
    qrcodeUrl: startResult.qrcodeUrl,
    refreshed: false,
    log,
    onQrCode,
  });

  log("\n等待扫码...\n");

  const waitResult = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    apiBaseUrl,
    timeoutMs: 480_000,
    botType: DEFAULT_ILINK_BOT_TYPE,
    onQrCode: async (info) => {
      await announceQrCode({
        sessionKey: startResult.sessionKey,
        qrcodeUrl: info.qrcodeUrl,
        refreshed: info.refreshed,
        log,
        onQrCode,
      });
    },
  });

  if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId) {
    throw new Error(waitResult.message);
  }

  const normalizedId = normalizeAccountId(waitResult.accountId);
  saveWeixinAccount(normalizedId, {
    token: waitResult.botToken,
    baseUrl: waitResult.baseUrl,
    userId: waitResult.userId,
  });
  registerWeixinAccountId(normalizedId);
  pendingLoggedInAccountId = normalizedId;

  log("\n✅ 与微信连接成功！");
  return normalizedId;
}

function takePendingLoggedInAccountId(expectedAccountId?: string): string | undefined {
  const accountId = pendingLoggedInAccountId;
  if (!accountId) return undefined;
  if (expectedAccountId && accountId !== expectedAccountId) {
    return undefined;
  }
  pendingLoggedInAccountId = undefined;
  return accountId;
}

async function announceQrCode(args: {
  sessionKey: string;
  qrcodeUrl: string;
  refreshed: boolean;
  log: (msg: string) => void;
  onQrCode?: (info: LoginQrCodeInfo) => Promise<void> | void;
}): Promise<void> {
  const { sessionKey, qrcodeUrl, refreshed, log, onQrCode } = args;
  log(
    refreshed
      ? "\n🔄 新二维码已生成，请重新扫描：\n"
      : "\n使用微信扫描以下二维码，以完成连接：\n",
  );

  try {
    const qrcodeterminal = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrcodeterminal.default.generate(qrcodeUrl, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    // The fallback URL log below is still enough for non-TTY environments.
  }

  const imagePath = await writeLoginQrImage(sessionKey, qrcodeUrl);
  if (imagePath) {
    log(`二维码图片文件: ${imagePath}`);
  }
  log(`二维码链接: ${qrcodeUrl}`);

  await onQrCode?.({
    sessionKey,
    qrcodeUrl,
    refreshed,
    imagePath,
  });
}

/**
 * Start the bot — long-polls for new messages and dispatches them to the agent.
 * Blocks until the abort signal fires or an unrecoverable error occurs.
 */
export async function start(agent: Agent, opts?: StartOptions): Promise<void> {
  const log = opts?.log ?? console.log;
  const expectedAccountId = opts?.accountId
    ? normalizeAccountId(opts.accountId)
    : undefined;
  const keepAwake = startMacOsKeepAwake(log);

  try {
    let accountId = takePendingLoggedInAccountId(expectedAccountId);
    if (accountId) {
      log(`[weixin] 使用当前进程刚完成的扫码登录, account=${accountId}`);
    } else {
      log("[weixin] 启动前需要微信扫码登录...");
      accountId = await login({
        baseUrl: opts?.baseUrl,
        log,
        onQrCode: opts?.onQrCode,
      });
    }

    if (expectedAccountId && accountId !== expectedAccountId) {
      throw new Error(
        `扫码登录的账号 ${accountId} 与指定账号 ${expectedAccountId} 不一致`,
      );
    }
    pendingLoggedInAccountId = undefined;

    const account = resolveWeixinAccount(accountId);
    if (!account.configured) {
      throw new Error(
        `账号 ${accountId} 未配置 (缺少 token)，请先运行 login`,
      );
    }

    log(`[weixin] 启动 bot, account=${account.accountId}`);

    await monitorWeixinProvider({
      baseUrl: account.baseUrl,
      cdnBaseUrl: account.cdnBaseUrl,
      token: account.token,
      accountId: account.accountId,
      agent,
      abortSignal: opts?.abortSignal,
      log,
    });
  } finally {
    keepAwake?.stop();
  }
}
