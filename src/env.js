import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_ENV = {
  BANKROLL_RISK_POLICY: "1",
  BANKROLL_MAX_KELLY_FRACTION: "0.25",
  BANKROLL_MAX_STAKE_PCT: "0.02",
  BANKROLL_MIN_EV: "0.02",
  BANKROLL_DRAWDOWN_GUARD: "0.35",
  SOURCE_GATE_REQUIRE_FULL_ODDS: "1"
};

export function loadLocalEnv(paths = [join(rootDir, ".env"), join(getDataDir(), "local.env")]) {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (parsed && !process.env[parsed.key]) process.env[parsed.key] = parsed.value;
    }
  }
}

function parseEnvLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const index = trimmed.indexOf("=");
  if (index <= 0) return null;
  const key = trimmed.slice(0, index).trim();
  const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  return /^[A-Z_][A-Z0-9_]*$/i.test(key) ? { key, value } : null;
}

export function applyDefaultEnv(defaults = DEFAULT_ENV) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();
applyDefaultEnv();
