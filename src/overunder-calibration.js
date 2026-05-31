/**
 * 大小球(over 2.5)isotonic 校准 —— 自主小模型的生产加载层(2026-05-31)。
 * ──────────────────────────────────────────────────────────────
 * profile 由 scripts/train-overunder-calibration.mjs 自主从 fixture-store 真实总进球拟合,
 * leak-safe holdout 证 Brier 0.2508→0.2494(Δ+0.0014)才落盘(否则 usable 缺失→本层 dormant)。
 *
 * 用途:模型 P(over2.5)(DC λ 总量泊松)校准。**有市场大小球盘口时市场更优**(回测 0.2412),
 *       故仅在无盘口的冷门场用校准模型值,机制同 1X2 isotonic(model-calibration)。
 * 缺 profile → 返回 null,调用方退回未校准,绝不编造。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";
import { applyIsotonicMap } from "./model-calibration.js";

let _cache = null;
let _loaded = false;

export function loadOverUnderCalibration() {
  if (_loaded) return _cache;
  _loaded = true;
  try {
    const p = join(getExportDir(), "overunder-calibration-profile.json");
    if (existsSync(p)) {
      const prof = JSON.parse(readFileSync(p, "utf8"));
      if (prof?.usable && prof.isotonicMap?.knots?.length) _cache = prof;
    }
  } catch { _cache = null; }
  return _cache;
}

/** 校准模型 P(over2.5);无 profile 或入参非法 → null(调用方退回未校准)。 */
export function calibrateOver25(pModel) {
  const prof = loadOverUnderCalibration();
  if (!prof || !Number.isFinite(pModel)) return null;
  const c = applyIsotonicMap(prof.isotonicMap, pModel);
  return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
}

// 测试 hook
export function __resetOverUnderCalibrationForTests() { _cache = null; _loaded = false; }
