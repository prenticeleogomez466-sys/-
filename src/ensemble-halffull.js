/**
 * 半全场集成生产加载层(2026-06-01)——多路融合的生产入口。
 * ════════════════════════════════════════════════════════════════════
 * 权重由 backtest-ensemble-halffull.mjs 前向逐步在 val 学得、leak-safe test 验:
 *   model_notau(rho=0)80% + 经验 HT-FT 频率 20% → 9类 LL 1.9624→1.9488(Δ0.0136)真增益。
 * 富集后 store 有 9万+ 真实半场,经验频率成有效互补信号。
 * 返回与 halfFullJoint 同形的中文键 9 类 dict;profile/经验表 不可用则 null,引擎回退 halfFullJoint。
 * 仅依赖 halftime-fulltime-model(避免与 prediction-engine 循环依赖)。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";
import { halfFullJoint } from "./halftime-fulltime-model.js";
import { collectHistoricalMatches } from "./ratings-bootstrap.js";

const CLASSES = ["主胜-主胜", "主胜-平局", "主胜-客胜", "平局-主胜", "平局-平局", "平局-客胜", "客胜-主胜", "客胜-平局", "客胜-客胜"];
const cn = (x, y) => (x > y ? "主胜" : x === y ? "平局" : "客胜");

let _profile = null, _profLoaded = false;
let _emp = null, _empLoaded = false;

function loadProfile() {
  if (_profLoaded) return _profile;
  _profLoaded = true;
  try {
    const p = join(getExportDir(), "ensemble-weights-halffull-profile.json");
    if (existsSync(p)) { const prof = JSON.parse(readFileSync(p, "utf8")); if (prof?.usable && prof.weights && Object.keys(prof.weights).length) _profile = prof; }
  } catch { _profile = null; }
  return _profile;
}

// 经验 HT-FT 频率表(league→中文键概率 + __global__),从 fixture-store 真实半场构建,缓存。
function loadEmpirical() {
  if (_empLoaded) return _emp;
  _empLoaded = true;
  try {
    const matches = collectHistoricalMatches(4000).filter((m) => m.halfHome != null && m.halfAway != null && m.homeGoals != null && m.awayGoals != null);
    if (matches.length < 1000) { _emp = null; return _emp; }
    const byLeague = new Map();
    const global = Object.fromEntries(CLASSES.map((c) => [c, 1])); // laplace
    for (const m of matches) {
      const c = `${cn(m.halfHome, m.halfAway)}-${cn(m.homeGoals, m.awayGoals)}`;
      global[c]++;
      const lg = m.league ?? "?";
      let e = byLeague.get(lg); if (!e) { e = Object.fromEntries(CLASSES.map((x) => [x, 1])); byLeague.set(lg, e); }
      e[c]++;
    }
    const normM = (e) => { const t = CLASSES.reduce((s, c) => s + e[c], 0); return Object.fromEntries(CLASSES.map((c) => [c, e[c] / t])); };
    const leagueN = new Map();
    for (const [lg, e] of byLeague) { const n = CLASSES.reduce((s, c) => s + e[c], 0) - 9; if (n >= 200) leagueN.set(lg, normM(e)); }
    _emp = { league: leagueN, global: normM(global) };
  } catch { _emp = null; }
  return _emp;
}

function producerDist(key, lh, la, league, emp) {
  switch (key) {
    case "model_default": return halfFullJoint(lh, la);
    case "model_notau": return halfFullJoint(lh, la, { rho: 0 });
    case "model_indep": return halfFullJoint(lh, la, { chase: 0 });
    case "empirical": return emp ? (emp.league.get(league) ?? emp.global) : null;
    default: return null; // old_fixed/model_fitted 未在学得权重中,跳过
  }
}

/**
 * 融合后半全场 9 类分布(中文键),供引擎替换裸 halfFullJoint。
 * @returns {Record<string,number>|null} null=profile/经验表不可用 → 调用方回退 halfFullJoint。
 */
export function ensembleHalfFull(lambdaHome, lambdaAway, league) {
  const prof = loadProfile();
  if (!prof || !Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return null;
  const emp = loadEmpirical();
  const out = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  let tw = 0;
  for (const [key, w] of Object.entries(prof.weights)) {
    if (!(w > 0)) continue;
    const d = producerDist(key, lambdaHome, lambdaAway, league, emp);
    if (!d) continue;
    let s = 0; for (const c of CLASSES) s += Number(d[c]) || 0;
    if (s <= 0) continue;
    tw += w; for (const c of CLASSES) out[c] += w * (Number(d[c]) || 0) / s;
  }
  if (tw <= 0) return null;
  for (const c of CLASSES) out[c] /= tw;
  return out;
}

export function __resetEnsembleHalfFullForTests() { _profile = null; _profLoaded = false; _emp = null; _empLoaded = false; }
