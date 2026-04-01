import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type OcrTextBlock = {
  text: string;
  score: number | null;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

type OcrScriptOutput = {
  blocks?: Array<{
    text?: string;
    score?: number | null;
    box?: [number, number, number, number];
    center?: [number, number];
  }>;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PADDLE_OCR_SCRIPT = path.resolve(MODULE_DIR, "../../../scripts/ocr/paddleocr.py");
const DEFAULT_PADDLE_OCR_PYTHON = path.resolve(MODULE_DIR, "../../../.venv-paddleocr/bin/python");
const OCR_PYTHON_COMMAND =
  process.env.WEIXIN_OCR_PYTHON?.trim() ||
  (existsSync(DEFAULT_PADDLE_OCR_PYTHON) ? DEFAULT_PADDLE_OCR_PYTHON : "python3");
const OCR_MODEL_VARIANT = process.env.WEIXIN_OCR_PADDLE_MODEL_VARIANT?.trim() || "mobile";
const OCR_SCRIPT_PATH = process.env.WEIXIN_OCR_PADDLE_SCRIPT?.trim() || DEFAULT_PADDLE_OCR_SCRIPT;

let reportedUnavailable = false;

function isOcrDisabled(): boolean {
  const raw = process.env.WEIXIN_OCR?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

function runPythonScript(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(OCR_PYTHON_COMMAND, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:
          process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK ?? "True",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });
  });
}

function normalizeBlock(block: NonNullable<OcrScriptOutput["blocks"]>[number]): OcrTextBlock | undefined {
  if (!block.text?.trim()) {
    return undefined;
  }

  const box = block.box;
  const center = block.center;
  if (
    !box ||
    box.length !== 4 ||
    box.some((value) => typeof value !== "number" || Number.isNaN(value)) ||
    !center ||
    center.length !== 2 ||
    center.some((value) => typeof value !== "number" || Number.isNaN(value))
  ) {
    return undefined;
  }

  return {
    text: block.text.trim(),
    score: typeof block.score === "number" ? block.score : null,
    left: box[0],
    top: box[1],
    right: box[2],
    bottom: box[3],
    centerX: center[0],
    centerY: center[1],
  };
}

export function normalizeOcrText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function isNormalizedOcrMatch(normalizedBlock: string, normalizedCandidate: string): boolean {
  if (!normalizedBlock || !normalizedCandidate) {
    return false;
  }
  if (normalizedBlock === normalizedCandidate) {
    return true;
  }
  if (normalizedBlock.includes(normalizedCandidate)) {
    return true;
  }
  return normalizedBlock.length >= 3 && normalizedCandidate.includes(normalizedBlock);
}

export function findOcrTextBlock(
  blocks: OcrTextBlock[],
  candidates: string[],
  opts?: {
    minX?: number;
    maxX?: number;
    minY?: number;
    maxY?: number;
  },
): OcrTextBlock | undefined {
  const normalizedCandidates = candidates
    .map((candidate) => ({
      raw: candidate,
      normalized: normalizeOcrText(candidate),
    }))
    .filter((candidate) => candidate.normalized.length > 0);

  let best:
    | {
        block: OcrTextBlock;
        score: number;
      }
    | undefined;

  for (const block of blocks) {
    if (typeof opts?.minX === "number" && block.centerX < opts.minX) continue;
    if (typeof opts?.maxX === "number" && block.centerX > opts.maxX) continue;
    if (typeof opts?.minY === "number" && block.centerY < opts.minY) continue;
    if (typeof opts?.maxY === "number" && block.centerY > opts.maxY) continue;

    const normalizedBlock = normalizeOcrText(block.text);
    if (!normalizedBlock) continue;

    for (let index = 0; index < normalizedCandidates.length; index += 1) {
      const candidate = normalizedCandidates[index];
      if (!candidate.normalized) continue;

      const exactMatch = normalizedBlock === candidate.normalized;
      const fuzzyMatch = isNormalizedOcrMatch(normalizedBlock, candidate.normalized);
      if (!exactMatch && !fuzzyMatch) {
        continue;
      }

      const lengthPenalty = Math.abs(normalizedBlock.length - candidate.normalized.length) / 100;
      const blockScore = typeof block.score === "number" ? block.score : 0.5;
      const matchScore = (exactMatch ? 100 : 10) - index - lengthPenalty + blockScore;

      if (!best || matchScore > best.score) {
        best = {
          block,
          score: matchScore,
        };
      }
    }
  }

  return best?.block;
}

export async function recognizeTextBlocks(
  pngBuffer: Buffer,
  log?: (message: string) => void,
): Promise<OcrTextBlock[]> {
  if (isOcrDisabled()) {
    return [];
  }

  if (!existsSync(OCR_SCRIPT_PATH)) {
    if (!reportedUnavailable) {
      log?.(`[ocr] OCR script not found: ${OCR_SCRIPT_PATH}`);
      reportedUnavailable = true;
    }
    return [];
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "weixin-agent-ocr-"));
  const imagePath = path.join(tempDir, "screen.png");

  try {
    await writeFile(imagePath, pngBuffer);
    const result = await runPythonScript([
      OCR_SCRIPT_PATH,
      "--image",
      imagePath,
      "--model-variant",
      OCR_MODEL_VARIANT,
    ]);

    if (result.exitCode !== 0) {
      if (!reportedUnavailable) {
        const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        log?.(`[ocr] PaddleOCR unavailable: ${details}`);
        reportedUnavailable = true;
      }
      return [];
    }

    const parsed = JSON.parse(result.stdout) as OcrScriptOutput;
    return (parsed.blocks ?? [])
      .map((block) => normalizeBlock(block))
      .filter((block): block is OcrTextBlock => Boolean(block));
  } catch (error) {
    if (!reportedUnavailable) {
      const details = error instanceof Error ? error.message : String(error);
      log?.(`[ocr] PaddleOCR invocation failed: ${details}`);
      reportedUnavailable = true;
    }
    return [];
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
