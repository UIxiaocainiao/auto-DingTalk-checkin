import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectQqFarmTemplateBatch } from "./qq-farm-template-fallback.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const workspaceRequire = createRequire(path.join(PROJECT_ROOT, "package.json"));
const { PNG } = workspaceRequire("pngjs");

const MARKERS = [
  {
    id: "buy_confirm",
    templates: ["btn_buy_confirm"],
    options: { minXRatio: 0.22, maxXRatio: 0.85, minYRatio: 0.48, maxYRatio: 0.96, minScore: 0.7 },
  },
  {
    id: "shop_close",
    templates: ["btn_shop_close", "btn_close"],
    options: { minXRatio: 0.55, maxXRatio: 0.82, maxYRatio: 0.18, minScore: 0.7 },
  },
  {
    id: "warehouse_sell",
    templates: ["btn_batch_sell", "btn_sell"],
    options: { minXRatio: 0.14, maxXRatio: 0.9, minYRatio: 0.35, maxYRatio: 0.96, minScore: 0.7 },
  },
  {
    id: "warehouse_entry",
    templates: ["btn_warehouse"],
    options: { maxXRatio: 0.25, minYRatio: 0.74, maxYRatio: 0.995, minScore: 0.68 },
  },
  {
    id: "mall_entry",
    templates: ["btn_shop"],
    options: { minXRatio: 0.88, maxXRatio: 0.995, minYRatio: 0.08, maxYRatio: 0.28, minScore: 0.68 },
  },
  {
    id: "friend_home",
    templates: ["btn_home"],
    options: { minXRatio: 0.72, maxXRatio: 0.98, minYRatio: 0.62, maxYRatio: 0.96, minScore: 0.7 },
  },
  {
    id: "farm_action",
    templates: ["btn_harvest", "btn_weed", "btn_bug", "btn_water"],
    options: { minXRatio: 0.3, maxXRatio: 0.7, minYRatio: 0.68, maxYRatio: 0.95, minScore: 0.66 },
  },
  {
    id: "land_empty",
    templates: ["land_empty", "land_empty2"],
    options: { minXRatio: 0.22, maxXRatio: 0.68, minYRatio: 0.3, maxYRatio: 0.76, minScore: 0.68 },
  },
];

function resolveVisualScene(markers) {
  if (markers.buy_confirm) {
    return "buy_confirm";
  }
  if (markers.warehouse_sell) {
    return "warehouse";
  }
  if (markers.friend_home) {
    return "friend_farm";
  }
  if (markers.shop_close) {
    return "shop_page";
  }
  if (markers.farm_action || markers.land_empty || markers.warehouse_entry || markers.mall_entry) {
    return "farm_overview";
  }
  return "unknown";
}

export function detectQqFarmVisualSnapshot(source) {
  const png = Buffer.isBuffer(source) ? PNG.sync.read(source) : source;
  const matches = detectQqFarmTemplateBatch(
    png,
    MARKERS.map((marker) => ({
      id: marker.id,
      templates: marker.templates,
      options: marker.options,
    })),
  );
  const markers = {};

  for (const marker of MARKERS) {
    const match = matches[marker.id];
    if (match) {
      markers[marker.id] = match;
    }
  }

  return {
    scene: resolveVisualScene(markers),
    markers,
  };
}
