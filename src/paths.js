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

export function ensureFootballGeneratedDirs() {
  for (const dir of [getDataDir(), getExportDir(), getDataSubdir("fixtures"), getDataSubdir("market"), getDataSubdir("advanced"), getDataSubdir("crawler"), getDataSubdir("logs")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return { dataDir: getDataDir(), exportDir: getExportDir() };
}
