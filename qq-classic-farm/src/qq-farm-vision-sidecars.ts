import { PNG } from "pngjs";

import { normalizeOcrText } from "../../packages/agent-acp/src/ocr-fallback.js";
import type { QqFarmSceneId } from "./qq-farm-shared.js";

type PngImage = InstanceType<typeof PNG>;

type QqFarmVisionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type QqFarmVisionElement = QqFarmVisionRect & {
  label: string;
  score: number;
  provider: "omniparser" | "moondream";
};

export type QqFarmVisionSidecarPoint = {
  x: number;
  y: number;
  score: number;
  provider: "omniparser" | "moondream";
  label: string;
};

export type QqFarmVisionSidecarScene = {
  scene: QqFarmSceneId;
  provider: "moondream";
  matchedTexts: string[];
};

export type QqFarmVisionSidecarOptions = {
  minXRatio?: number;
  maxXRatio?: number;
  minYRatio?: number;
  maxYRatio?: number;
  log?: (message: string) => void;
};

const DEFAULT_MOONDREAM_BASE_URL = "http://127.0.0.1:2020/v1";
const DEFAULT_OMNIPARSER_ENDPOINT = "http://127.0.0.1:7861/parse";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.WEIXIN_QQ_FARM_VISION_TIMEOUT_MS ?? "5000", 10);

function bufferFromSource(source: Buffer | PngImage): Buffer {
  return Buffer.isBuffer(source) ? source : PNG.sync.write(source);
}

function pngFromSource(source: Buffer | PngImage): PngImage {
  return Buffer.isBuffer(source) ? PNG.sync.read(source) : source;
}

function toDataUrl(source: Buffer | PngImage): string {
  return `data:image/png;base64,${bufferFromSource(source).toString("base64")}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveMoondreamBaseUrl(): string | undefined {
  const explicit = process.env.WEIXIN_QQ_FARM_MOONDREAM_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const enabled = process.env.WEIXIN_QQ_FARM_MOONDREAM_ENABLE?.trim().toLowerCase();
  if (enabled === "1" || enabled === "true" || enabled === "on") {
    return DEFAULT_MOONDREAM_BASE_URL;
  }

  return undefined;
}

function resolveOmniParserEndpoint(): string | undefined {
  const explicit = process.env.WEIXIN_QQ_FARM_OMNIPARSER_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const enabled = process.env.WEIXIN_QQ_FARM_OMNIPARSER_ENABLE?.trim().toLowerCase();
  if (enabled === "1" || enabled === "true" || enabled === "on") {
    return DEFAULT_OMNIPARSER_ENDPOINT;
  }

  return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function scoreLabelMatch(label: string, candidates: string[]): number {
  const normalizedLabel = normalizeOcrText(label);
  if (!normalizedLabel) {
    return Number.NEGATIVE_INFINITY;
  }

  let best = Number.NEGATIVE_INFINITY;
  const normalizedCandidates = candidates.map((candidate) => normalizeOcrText(candidate)).filter(Boolean);
  for (let index = 0; index < normalizedCandidates.length; index += 1) {
    const candidate = normalizedCandidates[index];
    const exact = normalizedLabel === candidate;
    const fuzzy =
      normalizedLabel.includes(candidate) || (normalizedLabel.length >= 3 && candidate.includes(normalizedLabel));
    if (!exact && !fuzzy) {
      continue;
    }
    const score = (exact ? 100 : 10) - index - Math.abs(normalizedLabel.length - candidate.length) / 100;
    if (score > best) {
      best = score;
    }
  }
  return best;
}

function pointWithinBounds(
  x: number,
  y: number,
  width: number,
  height: number,
  opts: QqFarmVisionSidecarOptions,
): boolean {
  if (typeof opts.minXRatio === "number" && x < width * opts.minXRatio) return false;
  if (typeof opts.maxXRatio === "number" && x > width * opts.maxXRatio) return false;
  if (typeof opts.minYRatio === "number" && y < height * opts.minYRatio) return false;
  if (typeof opts.maxYRatio === "number" && y > height * opts.maxYRatio) return false;
  return true;
}

function parseRect(raw: unknown, width: number, height: number): QqFarmVisionRect | undefined {
  if (Array.isArray(raw) && raw.length >= 4 && raw.slice(0, 4).every(isFiniteNumber)) {
    const [x1, y1, x2, y2] = raw as number[];
    const normalized = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 1.01;
    return {
      left: Math.round((normalized ? x1 * width : x1)),
      top: Math.round((normalized ? y1 * height : y1)),
      right: Math.round((normalized ? x2 * width : x2)),
      bottom: Math.round((normalized ? y2 * height : y2)),
    };
  }

  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const box =
    record.bbox ??
    record.box ??
    record.rect ??
    record.bounds ??
    record.bounding_box ??
    record.xyxy ??
    record.coordinates;
  if (box && box !== raw) {
    const parsed = parseRect(box, width, height);
    if (parsed) {
      return parsed;
    }
  }

  const x1 = record.x1 ?? record.x_min ?? record.left;
  const y1 = record.y1 ?? record.y_min ?? record.top;
  const x2 = record.x2 ?? record.x_max ?? record.right;
  const y2 = record.y2 ?? record.y_max ?? record.bottom;
  if (isFiniteNumber(x1) && isFiniteNumber(y1) && isFiniteNumber(x2) && isFiniteNumber(y2)) {
    const normalized = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 1.01;
    return {
      left: Math.round(normalized ? x1 * width : x1),
      top: Math.round(normalized ? y1 * height : y1),
      right: Math.round(normalized ? x2 * width : x2),
      bottom: Math.round(normalized ? y2 * height : y2),
    };
  }

  const x = record.x;
  const y = record.y;
  const rectWidth = record.width ?? record.w;
  const rectHeight = record.height ?? record.h;
  if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(rectWidth) && isFiniteNumber(rectHeight)) {
    const normalized = Math.max(Math.abs(x), Math.abs(y), Math.abs(rectWidth), Math.abs(rectHeight)) <= 1.01;
    const pixelX = normalized ? x * width : x;
    const pixelY = normalized ? y * height : y;
    const pixelWidth = normalized ? rectWidth * width : rectWidth;
    const pixelHeight = normalized ? rectHeight * height : rectHeight;
    return {
      left: Math.round(pixelX),
      top: Math.round(pixelY),
      right: Math.round(pixelX + pixelWidth),
      bottom: Math.round(pixelY + pixelHeight),
    };
  }

  return undefined;
}

function extractLabel(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const record = raw as Record<string, unknown>;
  const parts = [
    record.label,
    record.text,
    record.name,
    record.content,
    record.description,
    record.type,
    record.caption,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.join(" ").trim();
}

function extractScore(raw: unknown): number {
  if (!raw || typeof raw !== "object") {
    return 0.5;
  }
  const record = raw as Record<string, unknown>;
  const score = record.score ?? record.confidence ?? record.probability;
  return isFiniteNumber(score) ? score : 0.5;
}

function extractOmniParserElements(payload: unknown, width: number, height: number): QqFarmVisionElement[] {
  const containers = [
    payload,
    (payload as Record<string, unknown> | undefined)?.elements,
    (payload as Record<string, unknown> | undefined)?.parsed_elements,
    (payload as Record<string, unknown> | undefined)?.parsed_content_list,
    (payload as Record<string, unknown> | undefined)?.data,
    ((payload as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.elements,
  ];
  const elements: QqFarmVisionElement[] = [];

  for (const container of containers) {
    if (!Array.isArray(container)) {
      continue;
    }

    for (const item of container) {
      const label = extractLabel(item);
      const rect = parseRect(item, width, height);
      if (!label || !rect) {
        continue;
      }

      elements.push({
        ...rect,
        label,
        score: extractScore(item),
        provider: "omniparser",
      });
    }
  }

  return elements;
}

function extractMoondreamElements(
  payload: Record<string, unknown>,
  width: number,
  height: number,
  fallbackLabel: string,
): QqFarmVisionElement[] {
  const containers = [
    payload.objects,
    payload.detections,
    payload.boxes,
    (payload.result as Record<string, unknown> | undefined)?.objects,
  ];
  const elements: QqFarmVisionElement[] = [];

  for (const container of containers) {
    if (!Array.isArray(container)) {
      continue;
    }

    for (const item of container) {
      const rect = parseRect(item, width, height);
      if (!rect) {
        continue;
      }
      const label = extractLabel(item) || fallbackLabel;
      elements.push({
        ...rect,
        label,
        score: extractScore(item),
        provider: "moondream",
      });
    }
  }

  return elements;
}

async function postJson(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`vision sidecar ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function locatePointWithOmniParser(
  source: Buffer | PngImage,
  candidates: string[],
  opts: QqFarmVisionSidecarOptions,
): Promise<QqFarmVisionSidecarPoint | undefined> {
  const endpoint = resolveOmniParserEndpoint();
  if (!endpoint) {
    return undefined;
  }

  const png = pngFromSource(source);
  try {
    const payload = await postJson(endpoint, {
      image_url: toDataUrl(png),
      imageBase64: bufferFromSource(png).toString("base64"),
      imageMimeType: "image/png",
    });
    const elements = extractOmniParserElements(payload, png.width, png.height);
    let best: QqFarmVisionSidecarPoint | undefined;

    for (const element of elements) {
      const x = Math.round((element.left + element.right) / 2);
      const y = Math.round((element.top + element.bottom) / 2);
      if (!pointWithinBounds(x, y, png.width, png.height, opts)) {
        continue;
      }
      const matchScore = scoreLabelMatch(element.label, candidates);
      if (!Number.isFinite(matchScore)) {
        continue;
      }
      const combinedScore = matchScore + element.score;
      if (!best || combinedScore > best.score) {
        best = {
          x,
          y,
          score: combinedScore,
          provider: "omniparser",
          label: element.label,
        };
      }
    }

    if (best) {
      opts.log?.(
        `[vision] OmniParser matched ${best.label} at (${best.x}, ${best.y}) score=${best.score.toFixed(3)}`,
      );
    }
    return best;
  } catch (error) {
    opts.log?.(`[vision] OmniParser unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function locatePointWithMoondream(
  source: Buffer | PngImage,
  candidates: string[],
  opts: QqFarmVisionSidecarOptions,
): Promise<QqFarmVisionSidecarPoint | undefined> {
  const baseUrl = resolveMoondreamBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  const png = pngFromSource(source);
  const endpoint = new URL("point", ensureTrailingSlash(baseUrl)).toString();
  const detectEndpoint = new URL("detect", ensureTrailingSlash(baseUrl)).toString();
  const authToken = process.env.WEIXIN_QQ_FARM_MOONDREAM_API_KEY?.trim();

  for (const candidate of candidates) {
    try {
      const payload = await postJson(
        endpoint,
        {
          image_url: toDataUrl(png),
          object: candidate,
        },
        authToken ? { "X-Moondream-Auth": authToken } : {},
      );
      const points = Array.isArray(payload.points) ? payload.points : [];
      for (const point of points) {
        if (!point || typeof point !== "object") {
          continue;
        }
        const record = point as Record<string, unknown>;
        const rawX = record.x;
        const rawY = record.y;
        if (!isFiniteNumber(rawX) || !isFiniteNumber(rawY)) {
          continue;
        }
        const x = Math.round(rawX <= 1.01 && rawX >= 0 ? rawX * png.width : rawX);
        const y = Math.round(rawY <= 1.01 && rawY >= 0 ? rawY * png.height : rawY);
        if (!pointWithinBounds(x, y, png.width, png.height, opts)) {
          continue;
        }
        opts.log?.(`[vision] Moondream matched ${candidate} at (${x}, ${y})`);
        return {
          x,
          y,
          score: 1,
          provider: "moondream",
          label: candidate,
        };
      }

      const detectPayload = await postJson(
        detectEndpoint,
        {
          image_url: toDataUrl(png),
          object: candidate,
          settings: {
            max_objects: 8,
          },
        },
        authToken ? { "X-Moondream-Auth": authToken } : {},
      );
      const elements = extractMoondreamElements(detectPayload, png.width, png.height, candidate);
      let best: QqFarmVisionSidecarPoint | undefined;
      for (const element of elements) {
        const x = Math.round((element.left + element.right) / 2);
        const y = Math.round((element.top + element.bottom) / 2);
        if (!pointWithinBounds(x, y, png.width, png.height, opts)) {
          continue;
        }
        if (!best || element.score > best.score) {
          best = {
            x,
            y,
            score: element.score,
            provider: "moondream",
            label: element.label,
          };
        }
      }
      if (best) {
        opts.log?.(
          `[vision] Moondream detect matched ${candidate} at (${best.x}, ${best.y}) score=${best.score.toFixed(3)}`,
        );
        return best;
      }
    } catch (error) {
      opts.log?.(`[vision] Moondream unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  return undefined;
}

function parseMoondreamScene(answer: string): QqFarmSceneId {
  const normalized = normalizeOcrText(answer);
  if (!normalized) {
    return "unknown";
  }
  if (normalized === "friendfarm" || normalized.includes("好友农场") || normalized.includes("friendfarm")) {
    return "friend-farm";
  }
  if (normalized === "friends" || normalized.includes("好友列表") || normalized.includes("friends")) {
    return "friends";
  }
  if (
    normalized === "store" ||
    normalized.includes("商店") ||
    normalized.includes("商城") ||
    normalized.includes("仓库") ||
    normalized.includes("购买确认") ||
    normalized.includes("store")
  ) {
    return "store";
  }
  if (normalized === "home" || normalized.includes("自家农场") || normalized.includes("农场主页") || normalized.includes("home")) {
    return "home";
  }
  return "unknown";
}

export async function locateQqFarmUiPointWithSidecars(
  source: Buffer | PngImage,
  candidates: string[],
  opts: QqFarmVisionSidecarOptions = {},
): Promise<QqFarmVisionSidecarPoint | undefined> {
  const omniPoint = await locatePointWithOmniParser(source, candidates, opts);
  if (omniPoint) {
    return omniPoint;
  }
  return await locatePointWithMoondream(source, candidates, opts);
}

export async function classifyQqFarmSceneWithSidecars(
  source: Buffer | PngImage,
  log?: (message: string) => void,
): Promise<QqFarmVisionSidecarScene | undefined> {
  const baseUrl = resolveMoondreamBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  const endpoint = new URL("query", ensureTrailingSlash(baseUrl)).toString();
  const authToken = process.env.WEIXIN_QQ_FARM_MOONDREAM_API_KEY?.trim();

  try {
    const payload = await postJson(
      endpoint,
      {
        image_url: toDataUrl(source),
        question:
          "Classify this WeChat QQ farm screenshot. Return exactly one token: home, friends, store, friend-farm, unknown. home=self farm overview. friends=friends list. store=store, warehouse, mall, or purchase confirmation. friend-farm=friend farm with a home button.",
      },
      authToken ? { "X-Moondream-Auth": authToken } : {},
    );
    const answer = typeof payload.answer === "string" ? payload.answer : typeof payload.result === "string" ? payload.result : "";
    const scene = parseMoondreamScene(answer);
    if (scene === "unknown") {
      return undefined;
    }
    log?.(`[vision] Moondream scene=${scene} answer=${answer}`);
    return {
      scene,
      provider: "moondream",
      matchedTexts: [`moondream:${answer.trim() || scene}`],
    };
  } catch (error) {
    log?.(`[vision] Moondream query unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
