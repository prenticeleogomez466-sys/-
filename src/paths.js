import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const defaultDataDir = process.platform === "win32" ? "D:\\football-model-data" : join(rootDir, "data");
const defaultExportDir = process.platform === "win32" ? "D:\\football-model-exports" : join(rootDir, "data", "exports");

export function getDataDir() {
  return resolve(process.env.FOOTBALL_DATA_DIR || defaultDataDir);
}

export function getExportDir() {
  return resolve(process.env.FOOTBALL_EXPORT_DIR || defaultExportDir);
}

export function getDataSubdir(name) {
  return join(getDataDir(), name);
}

// 持久 profile(fusion-signal-weights / league-reliability 等回测学到的生产配置)统一放
// 数据盘 profiles 子目录。绝不放 exports 根——那里有 16:01 计划任务清空史(2026-06-10 缺陷#6 根因)。
export function getProfilesDir() {
  return join(getDataDir(), "profiles");
}
