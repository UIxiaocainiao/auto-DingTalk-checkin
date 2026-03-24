import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";

type ActiveConversationRecord = {
  userId: string;
  contextToken: string;
  updatedAt: string;
};

function resolveActiveConversationDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "active-conversations");
}

function resolveActiveConversationPath(accountId: string): string {
  return path.join(resolveActiveConversationDir(), `${accountId}.json`);
}

export function saveActiveConversation(params: {
  accountId: string;
  userId: string;
  contextToken: string;
}): void {
  const userId = params.userId.trim();
  const contextToken = params.contextToken.trim();
  if (!userId || !contextToken) {
    return;
  }

  fs.mkdirSync(resolveActiveConversationDir(), { recursive: true });
  const filePath = resolveActiveConversationPath(params.accountId);
  const record: ActiveConversationRecord = {
    userId,
    contextToken,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
}

export function loadActiveConversation(accountId: string): ActiveConversationRecord | null {
  const filePath = resolveActiveConversationPath(accountId);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<ActiveConversationRecord>;
    if (
      typeof parsed.userId !== "string" ||
      !parsed.userId.trim() ||
      typeof parsed.contextToken !== "string" ||
      !parsed.contextToken.trim()
    ) {
      return null;
    }
    return {
      userId: parsed.userId.trim(),
      contextToken: parsed.contextToken.trim(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}
