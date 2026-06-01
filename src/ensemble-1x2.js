/**
 * 胜负平集成生产加载层(2026-06-01)——10 路 producer 的学权融合。
 * ════════════════════════════════════════════════════════════════════
 * 权重由 backtest-ensemble-1x2.mjs 前向逐步在 val 上学得,leak-safe test 验证:
 *   - 有盘口段:融合收敛到 market 100%(模型加不了增量,确认公开数据上限);
 *   - 无盘口冷门段:DC 60% + 经验 40%,RPS 0.2262→0.2228(Δ+0.0034)真增益。
 * 故本层只在**无市场先验的冷门场**改善 1X2(有盘口仍以市场为准)。profile 缺则返回 null 优雅降级。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";
import { PRODUCER_KEYS } from "./ensemble-producers.js";

let _cache = null, _loaded = false;
export function loadEnsemble1x2Profile() {
  if (_loaded) return _cache;
  _loaded = true;
  try {
    const p = join(getExportDir(), "ensemble-weights-1x2-profile.json");
    if (existsSync(p)) { const prof = JSON.parse(readFileSync(p, "utf8")); if (prof?.usable && prof.weights) _cache = prof; }
  } catch { _cache = null; }
  return _cache;
}

function fuse(prodMap, weights) {
  let tw = 0; const s = { home: 0, draw: 0, away: 0 };
  for (const k of PRODUCER_KEYS) {
    const p = prodMap[k], w = weights[k] ?? 0;
    if (!p || w <= 0) continue;
    const t = p.home + p.draw + p.away; if (!(t > 0)) continue;
    tw += w; s.home += w * p.home / t; s.draw += w * p.draw / t; s.away += w * p.away / t;
  }
  if (tw <= 0) return null;
  return { home: s.home / tw, draw: s.draw / tw, away: s.away / tw };
}

/**
 * 用学到的权重融合 10 路 producer。有 market → withMarket 权重(=市场);无 market → noMarket 权重(模型融合)。
 * @returns {{probabilities,{home,draw,away}, weightSet, source}|null}
 */
export function fuseEnsemble1x2(producerMap) {
  const prof = loadEnsemble1x2Profile();
  if (!prof || !producerMap) return null;
  const hasMarket = Boolean(producerMap.market);
  const weights = hasMarket ? prof.weights : (prof.noMarket?.weights ?? null);
  if (!weights) return null;
  const probs = fuse(producerMap, weights);
  if (!probs) return null;
  return { probabilities: probs, weightSet: hasMarket ? "withMarket" : "noMarket(冷门场)", source: "ensemble-1x2" };
}

export function __resetEnsemble1x2ForTests() { _cache = null; _loaded = false; }
