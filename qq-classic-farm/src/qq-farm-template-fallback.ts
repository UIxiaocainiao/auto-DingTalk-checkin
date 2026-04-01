import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const REPO_ROOT = path.resolve(PROJECT_ROOT, "..");
const DEFAULT_TEMPLATE_DIR = path.join(PROJECT_ROOT, "templates");
const TEMPLATE_EXT = ".png";
const PROJECT_LOCAL_PYTHON = path.join(PROJECT_ROOT, ".venv-paddleocr", "bin", "python");
const REPO_LOCAL_PYTHON = path.join(REPO_ROOT, ".venv-paddleocr", "bin", "python");
const DEFAULT_OPENCV_SCRIPT = path.join(PROJECT_ROOT, "scripts", "opencv_template_match.py");

type PngImage = InstanceType<typeof PNG>;

export type QqFarmTemplateMatch = {
  templateName: string;
  score: number;
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  scale: number;
};

export type QqFarmTemplateMatchOptions = {
  minXRatio?: number;
  maxXRatio?: number;
  minYRatio?: number;
  maxYRatio?: number;
  scales?: number[];
  minScore?: number;
  maxMatches?: number;
};

export type QqFarmTemplateQuery = {
  id: string;
  templates: string[];
  options?: QqFarmTemplateMatchOptions;
};

type MatcherResponse = {
  results?: Array<{
    id?: string;
    match?: QqFarmTemplateMatch | null;
    matches?: QqFarmTemplateMatch[];
  }>;
};

export type QqFarmTemplateBatchResult = {
  match?: QqFarmTemplateMatch;
  matches: QqFarmTemplateMatch[];
};

function resolveTemplateDir(): string {
  return process.env.WEIXIN_QQ_FARM_TEMPLATE_DIR?.trim() || DEFAULT_TEMPLATE_DIR;
}

function resolvePythonCommand(): string {
  if (process.env.WEIXIN_QQ_FARM_OPENCV_PYTHON?.trim()) {
    return process.env.WEIXIN_QQ_FARM_OPENCV_PYTHON.trim();
  }
  if (existsSync(PROJECT_LOCAL_PYTHON)) {
    return PROJECT_LOCAL_PYTHON;
  }
  if (existsSync(REPO_LOCAL_PYTHON)) {
    return REPO_LOCAL_PYTHON;
  }
  return "python3";
}

function resolveOpenCvScriptPath(): string {
  return process.env.WEIXIN_QQ_FARM_OPENCV_SCRIPT?.trim() || DEFAULT_OPENCV_SCRIPT;
}

function bufferFromSource(source: Buffer | PngImage): Buffer {
  return Buffer.isBuffer(source) ? source : PNG.sync.write(source);
}

export function listQqFarmTemplateNames(prefix?: string): string[] {
  const templateDir = resolveTemplateDir();
  if (!existsSync(templateDir)) {
    return [];
  }

  return readdirSync(templateDir)
    .filter((name) => name.endsWith(TEMPLATE_EXT))
    .map((name) => name.slice(0, -TEMPLATE_EXT.length))
    .filter((name) => (prefix ? name.startsWith(prefix) : true))
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

export function detectQqFarmTemplateBatchDetailed(
  source: Buffer | PngImage,
  queries: QqFarmTemplateQuery[],
): Record<string, QqFarmTemplateBatchResult> {
  if (queries.length === 0) {
    return {};
  }

  const scriptPath = resolveOpenCvScriptPath();
  const templateDir = resolveTemplateDir();
  if (!existsSync(scriptPath) || !existsSync(templateDir)) {
    return {};
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "qq-farm-opencv-"));
  const imagePath = path.join(tempDir, "screen.png");
  const payload = JSON.stringify({
    templatesDir: templateDir,
    queries: queries.map((query) => ({
      id: query.id,
      templates: query.templates,
      ...(query.options ?? {}),
    })),
  });

  try {
    writeFileSync(imagePath, bufferFromSource(source));
    const stdout = execFileSync(resolvePythonCommand(), [scriptPath, "--image", imagePath, "--query-json", payload], {
      encoding: "utf8",
      env: {
        ...process.env,
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK ?? "True",
      },
    });
    const parsed = JSON.parse(stdout) as MatcherResponse;
    const matches: Record<string, QqFarmTemplateBatchResult> = {};
    for (const result of parsed.results ?? []) {
      if (!result.id) {
        continue;
      }
      matches[result.id] = {
        match: result.match ?? undefined,
        matches: result.matches ?? (result.match ? [result.match] : []),
      };
    }
    return matches;
  } catch {
    return {};
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function detectQqFarmTemplateBatch(
  source: Buffer | PngImage,
  queries: QqFarmTemplateQuery[],
): Record<string, QqFarmTemplateMatch | undefined> {
  const detailed = detectQqFarmTemplateBatchDetailed(source, queries);
  const matches: Record<string, QqFarmTemplateMatch | undefined> = {};
  for (const query of queries) {
    matches[query.id] = detailed[query.id]?.match;
  }
  return matches;
}

export function detectBestQqFarmTemplateMatch(
  source: Buffer | PngImage,
  templateNames: string[],
  options: QqFarmTemplateMatchOptions = {},
): QqFarmTemplateMatch | undefined {
  return detectQqFarmTemplateBatch(source, [
    {
      id: "best",
      templates: templateNames,
      options,
    },
  ]).best;
}

export function detectQqFarmTemplateMatches(
  source: Buffer | PngImage,
  templateNames: string[],
  options: QqFarmTemplateMatchOptions = {},
): QqFarmTemplateMatch[] {
  return (
    detectQqFarmTemplateBatchDetailed(source, [
      {
        id: "all",
        templates: templateNames,
        options: {
          ...options,
          maxMatches: options.maxMatches ?? 8,
        },
      },
    ]).all?.matches ?? []
  );
}
