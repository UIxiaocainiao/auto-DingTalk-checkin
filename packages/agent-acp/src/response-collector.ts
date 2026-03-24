import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatResponse } from "weixin-agent-sdk";
import type {
  BlobResourceContents,
  ContentBlock,
  SessionNotification,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

const ACP_MEDIA_OUT_DIR = "/tmp/weixin-agent/media/acp-out";
const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

type MediaCandidate =
  | { kind: "inline"; base64: string; mimeType: string }
  | { kind: "url"; url: string };

function isImageMimeType(mimeType?: string | null): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
}

function isImagePathLike(value?: string | null): boolean {
  if (!value) return false;
  const normalized = value.split("?")[0].split("#")[0];
  return IMAGE_FILE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function resolveMediaUrl(uri: string): string {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  return uri;
}

function inferImageMimeType(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const ext = path.extname(uri.split("?")[0].split("#")[0]).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return undefined;
  }
}

function isBlobResourceContents(resource: unknown): resource is BlobResourceContents {
  return Boolean(
    resource &&
      typeof resource === "object" &&
      "blob" in resource &&
      typeof (resource as { blob?: unknown }).blob === "string",
  );
}

/**
 * Collects sessionUpdate notifications for a single prompt round-trip
 * and converts the accumulated result into a ChatResponse.
 */
export class ResponseCollector {
  private textChunks: string[] = [];
  private media: MediaCandidate | null = null;

  private captureMediaFromBlock(content: ContentBlock): void {
    if (content.type === "image") {
      this.media = {
        kind: "inline",
        base64: content.data,
        mimeType: content.mimeType,
      };
      return;
    }

    if (content.type === "resource_link") {
      if (isImageMimeType(content.mimeType) || isImagePathLike(content.uri) || isImagePathLike(content.name)) {
        this.media = {
          kind: "url",
          url: resolveMediaUrl(content.uri),
        };
      }
      return;
    }

    if (content.type !== "resource") {
      return;
    }

    const resource = content.resource;
    if (!isBlobResourceContents(resource)) {
      return;
    }

    const mimeType = resource.mimeType ?? inferImageMimeType(resource.uri);
    if (!isImageMimeType(mimeType) && !isImagePathLike(resource.uri)) {
      return;
    }

    this.media = {
      kind: "inline",
      base64: resource.blob,
      mimeType: mimeType ?? "image/png",
    };
  }

  private captureMediaFromToolCallContent(content: ToolCallContent): void {
    if (content.type !== "content") {
      return;
    }
    this.captureMediaFromBlock(content.content);
  }

  /**
   * Feed a sessionUpdate notification into the collector.
   */
  handleUpdate(notification: SessionNotification): void {
    const update = notification.update;

    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content;

      if (content.type === "text") {
        this.textChunks.push(content.text);
      } else {
        this.captureMediaFromBlock(content);
      }
      return;
    }

    if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.content) {
      for (const content of update.content) {
        this.captureMediaFromToolCallContent(content);
      }
    }
  }

  /**
   * Build a ChatResponse from all collected chunks.
   */
  async toResponse(): Promise<ChatResponse> {
    const response: ChatResponse = {};

    const text = this.textChunks.join("");
    if (text) {
      response.text = text;
    }

    if (this.media?.kind === "url") {
      response.media = { type: "image", url: this.media.url };
    } else if (this.media?.kind === "inline") {
      await fs.mkdir(ACP_MEDIA_OUT_DIR, { recursive: true });
      const ext = this.media.mimeType.split("/")[1] ?? "png";
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(ACP_MEDIA_OUT_DIR, filename);
      await fs.writeFile(filePath, Buffer.from(this.media.base64, "base64"));
      response.media = { type: "image", url: filePath };
    }

    return response;
  }
}
