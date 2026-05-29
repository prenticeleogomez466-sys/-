/**
 * Free Injury Source(Y 档 — 免授权伤停源,激活休眠的 injury 信号)
 * ────────────────────────────────────────────────────────────
 * 全球范围实测后筛出的**真能免 key 抓、且现在有数据**的伤停源:
 *   FPL(英超官方 Fantasy API,fantasy.premierleague.com/api/bootstrap-static/)
 *   —— 无需任何授权,球员级 status(i伤/d疑/s停)+ chance_of_playing_next_round
 *      + 伤情文字 + now_cost(身价=重要性代理),实时更新。
 *   (同测 ESPN injuries 五大联赛全空=休赛期/feed 稀疏;Understat 反爬;故先只用 FPL。)
 *
 * 把 FPL 不可用球员归一成 injury-impact-model 需要的 { position, importance, role },
 * 经 advanced-data injuries 层喂给 signal-fusion-layer 的 injury 信号 —— 该信号此前
 * 因「无确诊伤停数据」长期休眠,这是它第一次有真实数据可 fire。
 *
 * ⚠️ 诚实边界:① 仅覆盖英超;② 公开伤停大多已被收盘赔率定价(见 X 档结论),
 * 边际 alpha 小,真正价值是「补齐一条死信号 + 偶尔领先市场的晚到伤情(50% 疑似→确认)」;
 * ③ 排除转会离队的 'u' 状态(非伤停),避免噪声。
 */

import { canonicalTeamName } from "./team-aliases.js";

const FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
// FPL element_type → injury-impact-model 位置(粗映射:FPL 只分 GK/DEF/MID/FWD)
const POSITION_MAP = { 1: "GK", 2: "CB", 3: "CM", 4: "ST" };
// 真伤停状态:i=injured d=doubtful s=suspended。排除 u(转会/未注册)、a(可用)。
const INJURY_STATUSES = new Set(["i", "d", "s"]);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function round(v) {
  return Math.round(v * 1000) / 1000;
}

// 身价(now_cost,£×10)→ importance 0..1。£4.0(40)→0.35,£13.0(130)→1.0。
function importanceFromCost(nowCost) {
  const costImp = clamp((Number(nowCost) - 40) / (130 - 40), 0, 1);
  return clamp(0.35 + 0.65 * costImp, 0.35, 1);
}
// chance_of_playing 折算缺阵权重:null/0 → 全缺(1);50 → 半缺(0.5)。
function absenceWeight(status, chance) {
  if (status === "a") return 0;
  if (chance == null) return 1;
  return clamp((100 - Number(chance)) / 100, 0, 1);
}
function roleOf(importance) {
  return importance >= 0.85 ? "star" : importance >= 0.65 ? "key" : "rotation";
}

/**
 * 把 FPL bootstrap-static 归一成按 canonical 队名分组的伤停名单。
 * @param {Object} bootstrap  FPL bootstrap-static JSON
 * @param {{minEffectiveImportance?:number}} opts
 * @returns {{ source, byTeam: Record<string, Array<{name,position,importance,role,status,chanceOfPlaying}>> }}
 */
export function normalizeFplInjuries(bootstrap, opts = {}) {
  const minEff = opts.minEffectiveImportance ?? 0.1;
  const teams = Object.fromEntries((bootstrap?.teams ?? []).map((t) => [t.id, t.name]));
  const byTeam = {};
  for (const p of bootstrap?.elements ?? []) {
    if (!INJURY_STATUSES.has(p.status)) continue;
    const weight = absenceWeight(p.status, p.chance_of_playing_next_round);
    if (weight <= 0) continue;
    const baseImp = importanceFromCost(p.now_cost);
    const effective = round(baseImp * weight);
    if (effective < minEff) continue;
    const canon = canonicalTeamName(teams[p.team] ?? "");
    if (!canon) continue;
    const absence = {
      name: p.web_name,
      position: POSITION_MAP[p.element_type] ?? "CM",
      importance: effective,
      role: roleOf(effective),
      status: p.status,
      chanceOfPlaying: p.chance_of_playing_next_round ?? 0,
      news: (p.news ?? "").slice(0, 120)
    };
    (byTeam[canon] ??= []).push(absence);
  }
  return { source: "fpl-bootstrap-static", byTeam };
}

/**
 * 抓 FPL 并归一。网络失败安全返回 ok:false。
 * @param {{fetch?:Function, minEffectiveImportance?:number}} opts
 */
export async function fetchFplInjuries(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let bootstrap;
  try {
    const r = await fetchImpl(FPL_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return { ok: false, reason: `FPL HTTP ${r.status}` };
    bootstrap = await r.json();
  } catch (e) {
    return { ok: false, reason: `FPL 抓取失败:${e.message}` };
  }
  const normalized = normalizeFplInjuries(bootstrap, opts);
  const teamCount = Object.keys(normalized.byTeam).length;
  const total = Object.values(normalized.byTeam).reduce((s, a) => s + a.length, 0);
  return { ok: true, ...normalized, teamCount, totalAbsences: total };
}

/**
 * 为单场比赛装出 injury 层:{ home:[...], away:[...] }。
 * 队名经 canonicalTeamName 对齐;无伤停的一侧给空数组。
 */
export function injuriesForFixture(fixture, byTeam) {
  if (!fixture || !byTeam) return null;
  const home = byTeam[canonicalTeamName(fixture.homeTeam)] ?? [];
  const away = byTeam[canonicalTeamName(fixture.awayTeam)] ?? [];
  if (!home.length && !away.length) return null;
  return { home, away };
}
