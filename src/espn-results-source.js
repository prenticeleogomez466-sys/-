/**
 * ESPN Results Source(Z2 档 — 免授权洲际联赛赛果)
 * ────────────────────────────────────────────────────────────
 * ESPN 隐藏 JSON API(site.api.espn.com)零授权、覆盖全球 ~10 个联赛,补 football-data
 * 只到欧洲的短板:MLS / 巴甲 / 日职 / 沙特联 / 中超 / 阿甲 / 墨超 / 韩K。
 * scoreboard 支持历史范围 ?dates=YYYYMMDD-YYYYMMDD(单次上限 ~100 场),按月分块抓。
 * 每场有队名/比分/完赛状态(STATUS_FULL_TIME, completed:true)。无 xG(那要 summary 逐场,重)。
 *
 * 诚实边界:队名为英文,要被中文竞彩用上需配 team-aliases(本档同时补知名队);
 * 但 DC 全局 baseRate / 联赛多样性即时受益。
 */

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

// 默认抓的洲际联赛(已排除被 football-data 覆盖的荷甲 N1/葡超 P1,避免重复)
export const ESPN_LEAGUES = {
  "usa.1": "美职", "bra.1": "巴甲", "jpn.1": "日职",
  "ksa.1": "沙特联", "chn.1": "中超", "arg.1": "阿甲", "mex.1": "墨超", "kor.1": "韩K"
};

function pad(n) { return String(n).padStart(2, "0"); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

// 枚举 [from, to] 区间内每个自然月的 YYYYMMDD-YYYYMMDD 范围串(防超 100 场上限)。
export function monthRanges(fromIso, toIso) {
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const last = lastDayOfMonth(y, m);
    out.push(`${y}${pad(m)}01-${y}${pad(m)}${pad(last)}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function parseEvents(json, leagueLabel) {
  const out = [];
  for (const ev of json?.events ?? []) {
    if (!ev?.status?.type?.completed) continue;
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const hg = Number(home.score);
    const ag = Number(away.score);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    out.push({
      home: home.team?.displayName ?? home.team?.name,
      away: away.team?.displayName ?? away.team?.name,
      homeGoals: hg,
      awayGoals: ag,
      date: String(ev.date).slice(0, 10),
      league: leagueLabel
    });
  }
  return out;
}

/**
 * 抓单个联赛在 [from, to] 区间的完赛赛果(按月分块)。
 * @param {string} league  ESPN 联赛码,如 "jpn.1"
 * @param {{from:string, to:string, label?:string, fetch?:Function}} opts  from/to = YYYY-MM-DD
 */
export async function fetchEspnResults(league, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const label = opts.label ?? ESPN_LEAGUES[league] ?? league;
  if (!opts.from || !opts.to) return { ok: false, reason: "需提供 from/to(YYYY-MM-DD)" };
  const matches = [];
  for (const range of monthRanges(opts.from, opts.to)) {
    try {
      const r = await fetchImpl(`${BASE}/${league}/scoreboard?dates=${range}`, { headers: UA });
      if (!r.ok) continue;
      matches.push(...parseEvents(await r.json(), label));
    } catch { /* 单月失败跳过 */ }
  }
  return { ok: matches.length > 0, league, label, matches };
}

/**
 * 抓多个联赛。
 * @param {{leagues?:string[], from:string, to:string, fetch?:Function}} opts
 */
export async function loadEspnResults(opts = {}) {
  const leagues = opts.leagues ?? Object.keys(ESPN_LEAGUES);
  const all = [];
  const byLeague = {};
  for (const lg of leagues) {
    const res = await fetchEspnResults(lg, { from: opts.from, to: opts.to, fetch: opts.fetch });
    if (res.ok) { all.push(...res.matches); byLeague[res.label] = res.matches.length; }
  }
  return { ok: all.length > 0, matches: all, byLeague };
}
