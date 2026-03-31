import type { OcrTextBlock } from "./ocr-fallback.js";

export type QqFarmStoreSeed = {
  quality?: number;
  label: string;
  locked: boolean;
  unlockLevel?: number;
  centerX: number;
  centerY: number;
  tapX: number;
  tapY: number;
  rawTexts: string[];
};

type ParseStoreSeedOptions = {
  minY?: number;
  maxY?: number;
};

function uniqueTexts(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseSeedQuality(text: string): number | undefined {
  const match = text.match(/^(\d+)\s*品$/);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseUnlockLevel(text: string): number | undefined {
  const match = text.match(/(\d+)\s*级解锁/);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function isSeedLabelText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (typeof parseSeedQuality(trimmed) === "number") {
    return false;
  }
  if (typeof parseUnlockLevel(trimmed) === "number") {
    return false;
  }
  if (/^[\d\s]+$/.test(trimmed)) {
    return false;
  }
  if (["商店", "商城", "种子", "宠物", "装扮", "确定", "购买"].includes(trimmed)) {
    return false;
  }
  return true;
}

function compareBlocksTopLeft(left: OcrTextBlock, right: OcrTextBlock): number {
  return left.centerY - right.centerY || left.centerX - right.centerX;
}

function findSeedCardBlocks(blocks: OcrTextBlock[], qualityBlock: OcrTextBlock): OcrTextBlock[] {
  return blocks.filter(
    (block) =>
      Math.abs(block.centerX - qualityBlock.centerX) <= 150 &&
      block.centerY >= qualityBlock.centerY - 25 &&
      block.centerY <= qualityBlock.centerY + 240,
  );
}

function findSeedLabelBlock(blocks: OcrTextBlock[], qualityBlock: OcrTextBlock): OcrTextBlock | undefined {
  return blocks
    .filter(
      (block) =>
        isSeedLabelText(block.text) &&
        Math.abs(block.centerX - qualityBlock.centerX) <= 140 &&
        block.centerY >= qualityBlock.centerY - 15 &&
        block.centerY <= qualityBlock.centerY + 80,
    )
    .sort(
      (left, right) =>
        Math.abs(left.centerY - qualityBlock.centerY) - Math.abs(right.centerY - qualityBlock.centerY) ||
        Math.abs(left.centerX - qualityBlock.centerX) - Math.abs(right.centerX - qualityBlock.centerX),
    )[0];
}

function findSeedDetailBlock(blocks: OcrTextBlock[], qualityBlock: OcrTextBlock): OcrTextBlock | undefined {
  return blocks
    .filter(
      (block) =>
        Math.abs(block.centerX - qualityBlock.centerX) <= 170 &&
        block.centerY >= qualityBlock.centerY + 120 &&
        block.centerY <= qualityBlock.centerY + 220 &&
        (typeof parseUnlockLevel(block.text) === "number" || /[\d]/.test(block.text)),
    )
    .sort(
      (left, right) =>
        Math.abs(left.centerY - (qualityBlock.centerY + 170)) - Math.abs(right.centerY - (qualityBlock.centerY + 170)) ||
        Math.abs(left.centerX - qualityBlock.centerX) - Math.abs(right.centerX - qualityBlock.centerX),
    )[0];
}

function resolveSeedTapPoint(
  qualityBlock: OcrTextBlock,
  labelBlock: OcrTextBlock | undefined,
  detailBlock: OcrTextBlock | undefined,
): { tapX: number; tapY: number } {
  const anchorX = labelBlock?.centerX ?? qualityBlock.centerX + 120;
  const anchorY = detailBlock?.centerY ?? qualityBlock.centerY + 180;
  return {
    tapX: Math.round((qualityBlock.centerX + anchorX) / 2),
    tapY: Math.round((qualityBlock.centerY + anchorY) / 2),
  };
}

export function parseQqFarmStoreSeeds(
  blocks: OcrTextBlock[],
  options: ParseStoreSeedOptions = {},
): QqFarmStoreSeed[] {
  const qualityBlocks = blocks
    .filter((block) => typeof parseSeedQuality(block.text) === "number")
    .filter((block) => (typeof options.minY === "number" ? block.centerY >= options.minY : true))
    .filter((block) => (typeof options.maxY === "number" ? block.centerY <= options.maxY : true))
    .sort(compareBlocksTopLeft);

  const seeds = qualityBlocks.map((qualityBlock) => {
    const cardBlocks = findSeedCardBlocks(blocks, qualityBlock);
    const labelBlock = findSeedLabelBlock(cardBlocks, qualityBlock);
    const unlockBlock = cardBlocks.find((block) => typeof parseUnlockLevel(block.text) === "number");
    const detailBlock = findSeedDetailBlock(cardBlocks, qualityBlock);
    const tapPoint = resolveSeedTapPoint(qualityBlock, labelBlock, detailBlock);
    return {
      quality: parseSeedQuality(qualityBlock.text),
      label: labelBlock?.text.trim() ?? `${parseSeedQuality(qualityBlock.text) ?? "?"}品种子`,
      locked: Boolean(unlockBlock),
      unlockLevel: unlockBlock ? parseUnlockLevel(unlockBlock.text) : undefined,
      centerX: qualityBlock.centerX,
      centerY: qualityBlock.centerY,
      tapX: tapPoint.tapX,
      tapY: tapPoint.tapY,
      rawTexts: uniqueTexts(cardBlocks.sort(compareBlocksTopLeft).map((block) => block.text)),
    };
  });

  return seeds.sort(
    (left, right) =>
      (left.quality ?? 0) - (right.quality ?? 0) ||
      left.centerY - right.centerY ||
      left.centerX - right.centerX,
  );
}

export function pickLatestUnlockedQqFarmStoreSeed(seeds: QqFarmStoreSeed[]): QqFarmStoreSeed | undefined {
  return [...seeds]
    .filter((seed) => !seed.locked)
    .sort(
      (left, right) =>
        (right.quality ?? 0) - (left.quality ?? 0) ||
        right.centerY - left.centerY ||
        right.centerX - left.centerX,
    )[0];
}

export function describeQqFarmStoreSeeds(seeds: QqFarmStoreSeed[]): string {
  if (seeds.length === 0) {
    return "未识别到商店种子";
  }

  return seeds
    .map((seed) => {
      const qualityText = typeof seed.quality === "number" ? `${seed.quality}品` : "未知品级";
      const stateText = seed.locked ? `${seed.unlockLevel ?? "?"}级解锁` : "已解锁";
      return `${qualityText} ${seed.label} (${stateText})`;
    })
    .join("；");
}
