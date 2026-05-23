import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const advancedDir = join(rootDir, "data", "advanced");

export function loadAdvancedData(date) {
  const path = advancedDataPath(date);
  if (!existsSync(path)) return { date, generatedAt: null, layers: {}, fixtures: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveAdvancedData(date, payload) {
  mkdirSync(advancedDir, { recursive: true });
  const path = advancedDataPath(date);
  const body = { date, generatedAt: new Date().toISOString(), ...payload };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return { path, payload: body };
}

export function advancedDataPath(date) {
  return join(advancedDir, `${date}.json`);
}

export function layerAvailable(advancedData, key) {
  const layer = advancedData?.layers?.[key];
  return Boolean(layer?.ok && layer.count > 0);
}
