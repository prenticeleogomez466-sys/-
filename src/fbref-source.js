/**
 * FBref(StatsBomb xG 模型)免费层接入 —— 球队 xG/射门质量/控球 特征源(2026-06-02)。
 * ════════════════════════════════════════════════════════════════════
 * FBref **强反爬**:>1 请求/3秒 封半天、非浏览器 UA 实测 403(见 [[reference-free-team-data-sources]])。
 * 故取数走**浏览器层**(Playwright MCP / 系统 Chrome)抓 squad-stats 表 → 存 dump JSON,
 * 本模块只读 dump 做匹配+归一+写盘(与 sofascore-injury-source 同套路,Node 不直连 FBref)。
 *
 * dump 形状(浏览器步骤产出,见 scripts/sync-fbref.mjs 顶部说明):
 *   {
 *     "collectedAt": "ISO",
 *     "competitions": [
 *       { "name": "UEFA Nations League", "url": "https://fbref.com/en/comps/...",
 *         "teams": { "Norway": { mp, poss, gf, ga, xg, xga, npxg, sh, sot, ... }, ... } }
 *     ]
 *   }
 *
 * 第一版**只做描述性增强**:写进 advancedData.fixtures[].data.**fbref**(独立键,
 *   NOT data.xg —— data.xg 会被 adjustProbabilitiesWithAdvancedData 动概率)。只喂情景层 xG 维度,
 *   不改 pick/概率。要进概率调整须先回测证增益(遵 feedback-hitrate-closed-loop)。
 */

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** 把 dump 拍平成 teamName(norm) → 最优一条 stats(同队多赛事时取场次最多的)。 */
export function flattenFbrefDump(dump) {
  const byTeam = new Map();
  for (const comp of dump?.competitions ?? []) {
    for (const [name, raw] of Object.entries(comp?.teams ?? {})) {
      const k = norm(name);
      if (!k) continue;
      const stat = normalizeTeamStat(raw, { team: name, competition: comp.name });
      if (!stat) continue;
      const prev = byTeam.get(k);
      if (!prev || (stat.matches ?? 0) > (prev.matches ?? 0)) byTeam.set(k, stat);
    }
  }
  return byTeam;
}

/** 单队原始字段 → 归一化 xG 画像(per-match 化,容忍字段缺失)。 */
export function normalizeTeamStat(raw, meta = {}) {
  if (!raw || typeof raw !== "object") return null;
  // 容忍多种列名(FBref 不同表/语言)
  const pick = (...keys) => { for (const key of keys) { const v = num(raw[key]); if (v != null) return v; } return null; };
  const mp = pick("mp", "MP", "matches", "90s", "played");
  const xg = pick("xg", "xG", "xg_for", "expected_goals");
  const xga = pick("xga", "xGA", "xg_against");
  const npxg = pick("npxg", "npxG");
  const gf = pick("gf", "GF", "goals", "goals_for", "gls");
  const ga = pick("ga", "GA", "goals_against");
  const poss = pick("poss", "Poss", "possession");
  const sh = pick("sh", "Sh", "shots");
  const sot = pick("sot", "SoT", "shots_on_target");
  if (xg == null && xga == null && gf == null) return null; // 至少要有一项实质数据
  const per = (v) => (v != null && mp && mp > 0 ? round2(v / mp) : null);
  // per-match 还是总量?FBref squad 表多为赛季总量 → 除场次;若 mp 缺,原样保留并标注。
  const perMatch = Boolean(mp && mp > 0);
  return {
    team: meta.team ?? null,
    competition: meta.competition ?? null,
    matches: mp,
    perMatch,
    xgFor: perMatch ? per(xg) : round2(xg),
    xgAgainst: perMatch ? per(xga) : round2(xga),
    npxgFor: perMatch ? per(npxg) : round2(npxg),
    goalsFor: perMatch ? per(gf) : round2(gf),
    goalsAgainst: perMatch ? per(ga) : round2(ga),
    possession: round2(poss),
    shots: perMatch ? per(sh) : round2(sh),
    shotsOnTarget: perMatch ? per(sot) : round2(sot),
    // 终结效率:进球 − xG(>0 抓得准/运气好;<0 浪费机会)。仅总量口径下可比。
    finishing: gf != null && xg != null ? round2((perMatch ? per(gf) : gf) - (perMatch ? per(xg) : xg)) : null,
  };
}

/** 给一场两队拼 advancedData 的 data.fbref。 */
export function buildFixtureFbref(homeStat, awayStat) {
  if (!homeStat && !awayStat) return null;
  const out = { home: homeStat ?? null, away: awayStat ?? null, source: "fbref" };
  if (homeStat && awayStat && Number.isFinite(homeStat.xgFor) && Number.isFinite(awayStat.xgFor)) {
    // 净 xG 期望(主攻−客防 与 客攻−主防 的对比),仅作画像不入概率
    out.xgEdge = round2((homeStat.xgFor - (awayStat.xgAgainst ?? homeStat.xgFor)) - (awayStat.xgFor - (homeStat.xgAgainst ?? awayStat.xgFor)));
  }
  return out;
}

/** 把 flatten 后的 teamStats 匹配到 fixtures,返回 {byFixtureId, matched, unmatched}。 */
export function buildFbrefForFixtures(fixtures, teamStatsMap) {
  const byFixtureId = {};
  let matched = 0; const unmatched = new Set();
  for (const fx of fixtures ?? []) {
    const h = teamStatsMap.get(norm(fx.homeTeam));
    const a = teamStatsMap.get(norm(fx.awayTeam));
    if (!h) unmatched.add(fx.homeTeam);
    if (!a) unmatched.add(fx.awayTeam);
    const fb = buildFixtureFbref(h, a);
    if (!fb) continue;
    byFixtureId[fx.id] = fb;
    matched++;
  }
  return { byFixtureId, matched, unmatched: [...unmatched] };
}

export { norm as normalizeTeamName };
