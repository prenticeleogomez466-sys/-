/**
 * Sofascore 免授权伤停源(2026-05-30,实测验证可用)
 * ────────────────────────────────────────────────────────────
 * 突破 FPL「只有英超」的墙:Sofascore 隐藏 JSON API 免 key 提供**多联赛**结构化缺阵名单
 * (球员+位置+缺阵/存疑),实测覆盖五大联赛/巴甲等(见会话验证:Arsenal 3 缺、巴甲多缺)。
 *
 * 架构(诚实):
 *   - api.sofascore.com 有 Cloudflare,Node 直连 403 → **抓取必须走浏览器**(Playwright MCP / 系统 Chrome)。
 *   - 本模块只做**纯逻辑**:赛程 event↔fixture 模糊匹配 + missingPlayers 归一成 injury-impact 格式 +
 *     装配 injuries 层。无网络、可单测。raw JSON 由浏览器层喂进来(见 scripts/sync-sofascore-injuries.mjs)。
 *
 * ⚠️ 诚实边界:
 *   ① lineups.missingPlayers **不带球员身价/重要性** → importance 用保守默认值并标 estimated:true,
 *      绝不假装知道谁是核心;真实影响交由 injury-impact-model 按位置 + 融合层 LR 上下封顶来约束。
 *   ② missingPlayers 含长期/边缘缺阵(实测巴甲单队 10 缺),count 偏大,不等于「重创」——
 *      只作「缺阵规模 + 位置」的有界信号,不夸大。
 *   ③ 公开伤停大多已被收盘赔率定价(X 档结论),边际 alpha 小;价值是补齐死信号 + 偶尔领先。
 */

import { canonicalTeamName } from "./team-aliases.js";

// Sofascore 位置单字母 → injury-impact-model 位置(GK/CB/CM/ST)。
const POSITION_MAP = { G: "GK", D: "CB", M: "CM", F: "ST" };
// type: "missing"=确定缺阵(记为 i 伤/停)、"doubtful"=存疑(记为 d)。其余忽略。
const TYPE_STATUS = { missing: "i", doubtful: "d" };
// 缺阵权重:确定缺阵=1,存疑=0.5。
const TYPE_WEIGHT = { missing: 1, doubtful: 0.5 };
// 无身价数据 → 保守默认重要性(标 estimated)。按位置略分:前场略高、门将略低。
const DEFAULT_IMPORTANCE_BY_POS = { ST: 0.55, CM: 0.5, CB: 0.5, GK: 0.45 };

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v) { return Math.round(v * 1000) / 1000; }

function roleOf(importance) {
  return importance >= 0.85 ? "star" : importance >= 0.65 ? "key" : "rotation";
}

/**
 * 归一单侧 missingPlayers → injury-impact 格式数组。
 * @param {Array} missingPlayers Sofascore event/lineups 的 home.missingPlayers / away.missingPlayers
 * @returns {Array<{name,position,importance,role,status,type,importanceEstimated}>}
 */
export function normalizeSofascoreMissing(missingPlayers = []) {
  const out = [];
  for (const m of Array.isArray(missingPlayers) ? missingPlayers : []) {
    const type = String(m?.type ?? "").toLowerCase();
    if (!TYPE_STATUS[type]) continue;                         // 只取 missing / doubtful
    const pos = POSITION_MAP[m?.player?.position] ?? "CM";
    const weight = TYPE_WEIGHT[type];
    const baseImp = DEFAULT_IMPORTANCE_BY_POS[pos] ?? 0.5;
    const importance = round(baseImp * weight);
    out.push({
      name: m?.player?.name ?? "",
      position: pos,
      importance,
      role: roleOf(importance),
      status: TYPE_STATUS[type],
      type,
      importanceEstimated: true                                // 诚实标注:重要性是默认值,非真身价
    });
  }
  return out;
}

/**
 * 把 Sofascore 一场赛事的 lineups(含 home/away.missingPlayers)装成 injuries 层。
 * @returns {{home:Array, away:Array, source, importanceEstimated}|null} 两侧都无缺阵 → null
 */
export function injuryLayerFromLineups(lineups) {
  if (!lineups) return null;
  const home = normalizeSofascoreMissing(lineups.home?.missingPlayers);
  const away = normalizeSofascoreMissing(lineups.away?.missingPlayers);
  if (!home.length && !away.length) return null;
  return { home, away, source: "sofascore-lineups", importanceEstimated: true };
}

// 常见英文俱乐部后缀/前缀 token —— 直配不上时剥掉再比(解决 "Molde FK"↔"莫尔德":
//   canonicalTeamName("Molde FK")="moldefk" 无别名,但去掉 FK 后 "Molde"→"莫尔德" 命中)。
const CLUB_AFFIXES = /\b(fk|fc|bk|ff|if|il|sk|cf|sc|ac|afc|cd|ud|kf|aif|bif|gif|sif|fotball|football|club|de|fotbollforening)\b/gi;
function strippedCandidates(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return [];
  const out = new Set([raw]);
  const noAffix = raw.replace(CLUB_AFFIXES, " ").replace(/\s+/g, " ").trim();
  if (noAffix && noAffix !== raw) out.add(noAffix);
  // 取首个实词(多词队名 "Vissel Kobe"→"Vissel";末词 "...Kobe"→"Kobe"),提升异译命中率。
  const words = noAffix.split(" ").filter(Boolean);
  if (words.length > 1) { out.add(words[0]); out.add(words[words.length - 1]); }
  return [...out];
}
// 一个队名的所有候选 canonical(含后缀剥离),用于宽松匹配。
function canonSet(name) {
  return new Set(strippedCandidates(name).map((n) => canonicalTeamName(n)).filter(Boolean));
}

/**
 * 在 Sofascore 当日赛程里给 fixture 模糊匹配出 event id。
 * 先严格 canonical 直配;不中再用后缀容错(剥 FK/BK/FF… + 首/末词)宽松匹配。
 * 主客两队都匹配上才算(防误配)。
 * @returns {number|null}
 */
export function matchEventToFixture(events, fixture) {
  if (!Array.isArray(events) || !fixture) return null;
  const fh = canonicalTeamName(fixture.homeTeam);
  const fa = canonicalTeamName(fixture.awayTeam);
  if (!fh || !fa) return null;
  // 第一轮:严格直配。
  for (const e of events) {
    if (canonicalTeamName(e?.homeTeam?.name ?? "") === fh && canonicalTeamName(e?.awayTeam?.name ?? "") === fa) return e.id;
  }
  // 第二轮:后缀容错宽松匹配(主客两侧 canonical 候选集有交集即算)。
  const fhSet = canonSet(fixture.homeTeam);
  const faSet = canonSet(fixture.awayTeam);
  for (const e of events) {
    const ehSet = canonSet(e?.homeTeam?.name ?? "");
    const eaSet = canonSet(e?.awayTeam?.name ?? "");
    if (intersects(fhSet, ehSet) && intersects(faSet, eaSet)) return e.id;
  }
  return null;
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * 从 Sofascore raw 数据(当日赛程 + 每场 lineups)装配「按 fixture.id 的 injuries 层」。
 * @param {Array} fixtures fixture-store 当日 fixtures
 * @param {Array} events Sofascore scheduled-events.events
 * @param {Record<number, object>} lineupsByEventId { eventId: lineups JSON }
 * @returns {{ byFixtureId: Record<string,object>, matched:number, source }}
 */
export function buildInjuriesFromSofascore(fixtures, events, lineupsByEventId = {}) {
  const byFixtureId = {};
  let matched = 0;
  for (const fx of fixtures ?? []) {
    const eventId = matchEventToFixture(events, fx);
    if (eventId == null) continue;
    const layer = injuryLayerFromLineups(lineupsByEventId[eventId]);
    if (!layer) continue;
    byFixtureId[fx.id] = layer;
    matched++;
  }
  return { byFixtureId, matched, source: "sofascore-lineups" };
}

export { POSITION_MAP, TYPE_STATUS };
