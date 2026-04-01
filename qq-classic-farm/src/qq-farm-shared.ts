import { findOcrTextBlock, type OcrTextBlock } from "../../packages/agent-acp/src/ocr-fallback.js";
import qqFarmSpec from "./qq-farm-spec.json" with { type: "json" };

type QqFarmSceneDefinition = {
  groups: string[][];
};

type QqFarmSpec = {
  queryCandidates: string[];
  searchResultTexts: string[];
  openTexts: string[];
  scenes: Record<string, QqFarmSceneDefinition>;
  actions: {
    homeOneKeyActions?: QqFarmOneKeyAction[];
    friendOneKeyActions?: QqFarmOneKeyAction[];
    warehouseEntryTexts?: string[];
    warehouseSellTexts?: string[];
    friendEntryTexts: string[];
    friendVisitTexts: string[];
    friendHelpTexts?: string[];
    returnHomeTexts: string[];
    storeEntryTexts: string[];
    mallEntryTexts?: string[];
    mallFertilizerTexts?: string[];
    purchaseConfirmTexts?: string[];
    rewardEntryTexts: string[];
    primaryActionTexts: string[];
    friendTabTexts: Record<string, string[]>;
    storeTabTexts: Record<string, string[]>;
  };
};

export type QqFarmOneKeyAction = {
  id: string;
  note: string;
  texts: string[];
};

const QQ_FARM_SPEC = qqFarmSpec as QqFarmSpec;

export type QqFarmSceneId = "home" | "friends" | "store" | "friend-farm" | "unknown";

export type QqFarmSceneDetection = {
  scene: QqFarmSceneId;
  matchedTexts: string[];
  matchedGroups: number;
};

const QQ_FARM_SCENE_PRIORITY: Record<Exclude<QqFarmSceneId, "unknown">, number> = {
  friends: 40,
  store: 35,
  "friend-farm": 30,
  home: 10,
};

function uniqueTexts(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function buildQqFarmQueryCandidates(primaryQuery?: string): string[] {
  return uniqueTexts([primaryQuery ?? "", ...QQ_FARM_SPEC.queryCandidates]);
}

export function buildQqFarmResultTexts(primaryQuery?: string): string[] {
  return uniqueTexts([primaryQuery ?? "", ...QQ_FARM_SPEC.searchResultTexts]);
}

export const QQ_FARM_OPEN_TEXTS = uniqueTexts(QQ_FARM_SPEC.openTexts);
export const QQ_FARM_WAREHOUSE_ENTRY_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.warehouseEntryTexts ?? []);
export const QQ_FARM_WAREHOUSE_SELL_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.warehouseSellTexts ?? []);
export const QQ_FARM_FRIEND_ENTRY_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.friendEntryTexts);
export const QQ_FARM_FRIEND_VISIT_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.friendVisitTexts);
export const QQ_FARM_FRIEND_HELP_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.friendHelpTexts ?? []);
export const QQ_FARM_RETURN_HOME_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.returnHomeTexts);
export const QQ_FARM_STORE_ENTRY_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.storeEntryTexts);
export const QQ_FARM_MALL_ENTRY_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.mallEntryTexts ?? []);
export const QQ_FARM_MALL_FERTILIZER_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.mallFertilizerTexts ?? []);
export const QQ_FARM_PURCHASE_CONFIRM_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.purchaseConfirmTexts ?? []);
export const QQ_FARM_REWARD_ENTRY_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.rewardEntryTexts);
export const QQ_FARM_PRIMARY_ACTION_TEXTS = uniqueTexts(QQ_FARM_SPEC.actions.primaryActionTexts);
export const QQ_FARM_HOME_ONE_KEY_ACTIONS = (QQ_FARM_SPEC.actions.homeOneKeyActions ?? []).map((action) => ({
  ...action,
  texts: uniqueTexts(action.texts),
}));
export const QQ_FARM_FRIEND_ONE_KEY_ACTIONS = (QQ_FARM_SPEC.actions.friendOneKeyActions ?? []).map((action) => ({
  ...action,
  texts: uniqueTexts(action.texts),
}));
export const QQ_FARM_FRIEND_TAB_TEXTS = QQ_FARM_SPEC.actions.friendTabTexts;
export const QQ_FARM_STORE_TAB_TEXTS = QQ_FARM_SPEC.actions.storeTabTexts;

export function detectQqFarmScene(blocks: OcrTextBlock[]): QqFarmSceneDetection {
  let best: QqFarmSceneDetection = {
    scene: "unknown",
    matchedTexts: [],
    matchedGroups: 0,
  };
  let bestScore = 0;

  for (const [sceneId, definition] of Object.entries(QQ_FARM_SPEC.scenes)) {
    const matchedTexts: string[] = [];
    let matchedGroups = 0;

    for (const group of definition.groups) {
      const match = findOcrTextBlock(blocks, group);
      if (!match) {
        continue;
      }
      matchedGroups += 1;
      matchedTexts.push(match.text);
    }

    if (matchedGroups === 0) {
      continue;
    }

    const matchedAllGroups = matchedGroups === definition.groups.length;
    const score =
      matchedGroups * 100 +
      (matchedAllGroups ? 1_000 : 0) +
      (QQ_FARM_SCENE_PRIORITY[sceneId as Exclude<QqFarmSceneId, "unknown">] ?? 0);
    if (score <= bestScore) {
      continue;
    }

    best = {
      scene: sceneId as QqFarmSceneId,
      matchedTexts,
      matchedGroups,
    };
    bestScore = score;
  }

  return best;
}
