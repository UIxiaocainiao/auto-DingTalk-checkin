import { listWeixinAccountIds, resolveWeixinAccount } from "./auth/accounts.js";
import { loadActiveConversation } from "./messaging/active-conversation.js";
import { markdownToPlainText, sendMessageWeixin } from "./messaging/send.js";

function resolveSingleAccountId(explicitAccountId?: string): string {
  if (explicitAccountId?.trim()) {
    return explicitAccountId.trim();
  }

  const accountIds = listWeixinAccountIds();
  if (accountIds.length === 0) {
    throw new Error("未找到可用的微信账号，请先完成扫码登录");
  }
  if (accountIds.length > 1) {
    throw new Error("检测到多个微信账号，请显式指定 accountId");
  }
  return accountIds[0];
}

export async function sendProactiveTextMessage(params: {
  text: string;
  accountId?: string;
}): Promise<void> {
  const accountId = resolveSingleAccountId(params.accountId);
  const account = resolveWeixinAccount(accountId);
  if (!account.configured || !account.token) {
    throw new Error(`账号 ${accountId} 未配置可用 token`);
  }

  const activeConversation = loadActiveConversation(account.accountId);
  if (!activeConversation) {
    throw new Error("未找到可用会话，请先给 bot 发一条消息以建立主动发送上下文");
  }

  await sendMessageWeixin({
    to: activeConversation.userId,
    text: markdownToPlainText(params.text),
    opts: {
      baseUrl: account.baseUrl,
      token: account.token,
      contextToken: activeConversation.contextToken,
    },
  });
}

export async function sendLoginSuccessTextMessage(params: {
  text: string;
  accountId: string;
  userId?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const account = resolveWeixinAccount(params.accountId);
  if (!account.configured || !account.token) {
    return { sent: false, reason: `账号 ${params.accountId} 未配置可用 token` };
  }

  const activeConversation = loadActiveConversation(account.accountId);
  if (!activeConversation) {
    return { sent: false, reason: "未找到可用会话，无法主动发送登录成功提示" };
  }

  const expectedUserId = params.userId?.trim();
  if (expectedUserId && activeConversation.userId !== expectedUserId) {
    return { sent: false, reason: "最近活跃会话与当前扫码用户不一致，已跳过登录成功提示" };
  }

  await sendMessageWeixin({
    to: activeConversation.userId,
    text: markdownToPlainText(params.text),
    opts: {
      baseUrl: account.baseUrl,
      token: account.token,
      contextToken: activeConversation.contextToken,
    },
  });

  return { sent: true };
}
