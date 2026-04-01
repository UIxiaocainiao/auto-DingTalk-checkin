import * as weixinAgentSdk from "weixin-agent-sdk";

type SendProactiveTextMessage = (params: {
  text: string;
  accountId?: string;
}) => Promise<void>;

function resolveSendProactiveTextMessage(): SendProactiveTextMessage | undefined {
  const candidate = (weixinAgentSdk as {
    sendProactiveTextMessage?: SendProactiveTextMessage;
  }).sendProactiveTextMessage;

  return typeof candidate === "function" ? candidate : undefined;
}

export async function sendProactiveTextMessageCompat(params: {
  text: string;
  accountId?: string;
}): Promise<void> {
  const sendProactiveTextMessage = resolveSendProactiveTextMessage();
  if (!sendProactiveTextMessage) {
    throw new Error(
      "当前安装的 weixin-agent-sdk 不支持主动消息，请升级到包含 sendProactiveTextMessage 导出的版本。",
    );
  }

  await sendProactiveTextMessage(params);
}
