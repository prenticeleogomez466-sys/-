// 球队全维度画像层(2026-06-06 神选独立设计)——从历史 fixture-store 为每支队算真实画像:
// 综合实力(场均积分)/进攻(场均进球)/防守(场均失球)/主场战绩/客场战绩/近5状态。再据"主队主场强度 vs
// 客队客场强度"识别【市场存疑场】(主客场数据与市场倾向相左→避坑视角)。
// 永久铁律:样本不足的队=标缺(profile=null)不臆造。回测纪律:本层是情景/避坑展示,不驱动 wld 概率。
import { listFixtureDates, loadFixtures } from "./fixture-store.js";
import { canonicalTeamName } from "./team-aliases.js";

// 纯函数:一组比赛 → 每队画像 Map(canonical→profile)。matches: {home,away,hg,ag,date}
export function computeProfiles(matches, { minGames = 6 } = {}) {
  const acc = new Map();
  const g = (t) => { if (!acc.has(t)) acc.set(t, { gp: 0, pts: 0, gf: 0, ga: 0, hN: 0, hPts: 0, hGf: 0, hGa: 0, aN: 0, aPts: 0, aGf: 0, aGa: 0, seq: [] }); return acc.get(t); };
  for (const m of matches) {
    const hC = canonicalTeamName(m.home), aC = canonicalTeamName(m.away);
    const hg = Number(m.hg), ag = Number(m.ag);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const h = g(hC), a = g(aC);
    const hp = hg > ag ? 3 : hg === ag ? 1 : 0, ap = ag > hg ? 3 : hg === ag ? 1 : 0;
    h.gp++; h.pts += hp; h.gf += hg; h.ga += ag; h.hN++; h.hPts += hp; h.hGf += hg; h.hGa += ag; h.seq.push({ d: m.date, r: hp === 3 ? "胜" : hp === 1 ? "平" : "负" });
    a.gp++; a.pts += ap; a.gf += ag; a.ga += hg; a.aN++; a.aPts += ap; a.aGf += ag; a.aGa += hg; a.seq.push({ d: m.date, r: ap === 3 ? "胜" : ap === 1 ? "平" : "负" });
  }
  const out = new Map();
  for (const [t, p] of acc) {
    if (p.gp < minGames) continue; // 样本不足→标缺(不进 Map)
    p.seq.sort((x, y) => String(x.d).localeCompare(String(y.d)));
    out.set(t, {
      gp: p.gp, ppg: round(p.pts / p.gp), atk: round(p.gf / p.gp), def: round(p.ga / p.gp),
      homePpg: p.hN ? round(p.hPts / p.hN) : null, homeGf: p.hN ? round(p.hGf / p.hN) : null, homeGa: p.hN ? round(p.hGa / p.hN) : null, homeN: p.hN,
      awayPpg: p.aN ? round(p.aPts / p.aN) : null, awayGf: p.aN ? round(p.aGf / p.aN) : null, awayGa: p.aN ? round(p.aGa / p.aN) : null, awayN: p.aN,
      last5: p.seq.slice(-5).map((x) => x.r).join(""),
    });
  }
  return out;
}
const round = (x) => Math.round(x * 100) / 100;

// 主队主场强度 vs 客队客场强度 → 情景判断 + 是否"市场存疑"线索。
//   均无=null;返回 {homeEdge(主场分-客场分), note, marketWatch(主队主场明显占优却非热门时供避坑)}
export function homeAwayEdge(homeP, awayP) {
  if (!homeP?.homePpg && !awayP?.awayPpg) return null;
  const hp = homeP?.homePpg, ap = awayP?.awayPpg;
  if (hp == null || ap == null) return { note: "主客场样本不足", marketWatch: false };
  const edge = round(hp - ap); // 正=主队主场实力强于客队客场
  let note;
  if (edge >= 0.6) note = `主队主场强势(${hp}分) 明显高于客队客场(${ap}分)`;
  else if (edge <= -0.6) note = `客队客场强势(${ap}分) 高于主队主场(${hp}分)`;
  else note = `主客场实力接近(主${hp}/客${ap})`;
  return { homeEdge: edge, homePpg: hp, awayPpg: ap, note, marketWatch: Math.abs(edge) >= 0.6 };
}

// 缓存:整库画像构建一次(与 DC 同源 fixture-store)。
let _cache = null, _cacheKey = null;
export function loadTeamProfiles({ maxDates = 700, beforeDate = null, recentSeasonsFrom = null } = {}) {
  const key = `${maxDates}|${beforeDate}|${recentSeasonsFrom}`;
  if (_cache && _cacheKey === key) return _cache;
  const allDates = listFixtureDates();
  const dates = (beforeDate ? allDates.filter((d) => d < beforeDate) : allDates).slice(0, maxDates);
  const matches = [];
  for (const date of dates) {
    if (recentSeasonsFrom && date < recentSeasonsFrom) continue;
    const { fixtures } = loadFixtures(date);
    for (const f of fixtures) {
      if (!f.result || !Number.isFinite(f.result.home) || !Number.isFinite(f.result.away)) continue;
      matches.push({ home: f.homeTeam, away: f.awayTeam, hg: f.result.home, ag: f.result.away, date });
    }
  }
  _cache = computeProfiles(matches);
  _cacheKey = key;
  return _cache;
}

// 给一场比赛取主客双方画像 + 主客场情景。无=各 null(标缺)。
export function profileForFixture(fixture, profiles = loadTeamProfiles()) {
  const h = profiles.get(canonicalTeamName(fixture.homeTeam)) ?? null;
  const a = profiles.get(canonicalTeamName(fixture.awayTeam)) ?? null;
  return { home: h, away: a, edge: homeAwayEdge(h, a) };
}
