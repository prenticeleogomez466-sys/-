/**
 * TheSportsDB 免授权赛果源(2026-05-31)—— 补 ESPN/football-data 都不覆盖的联赛(首用:韩K)。
 * ────────────────────────────────────────────────────────────
 * TheSportsDB 免费 key=3:`eventsseason` 被截到 15 场/季(免费限制),但 **`eventsround`
 *   按轮次返回整轮赛果**(不受 15 场限制),逐轮 1..N 拼出整季。实测 K League 1(id=4689)可用。
 * 无半场比分(intHomeScoreHT 多为空)→ halfFull 优雅缺省;无赔率 → 只进经验库联赛级(同 ESPN 纯赛果)。
 *
 * 纯归一(normalizeTsdbEvents)可单测;fetchTsdbRoundResults 是带网络的编排,安全失败。
 */

const BASE = "https://www.thesportsdb.com/api/v1/json/3";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

/**
 * 归一 TheSportsDB events → 经验库 match shape(只取带比分的完赛场)。
 * @param {Array} events  eventsround/eventsseason 的 events
 * @param {string} label  中文联赛名(如 "韩K")
 * @returns {Array} 统一 match:{league,homeGoals,awayGoals,halfHome,halfAway,odds,oddsClose,asian,date,home,away,id}
 */
export function normalizeTsdbEvents(events, label) {
  const out = [];
  const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  for (const e of Array.isArray(events) ? events : []) {
    // ⚠️ Number(null)===0:未完赛 intHomeScore=null 会被误算成 0-0。先排除 null/空再转。
    const hg = numOrNull(e?.intHomeScore);
    const ag = numOrNull(e?.intAwayScore);
    if (hg === null || ag === null) continue;                          // 未完赛/无比分跳过
    const htH = numOrNull(e?.intHomeScoreHT);
    const htA = numOrNull(e?.intAwayScoreHT);
    out.push({
      league: label,
      homeGoals: hg,
      awayGoals: ag,
      halfHome: htH,
      halfAway: htA,
      odds: null, oddsClose: null, asian: null,
      date: e.dateEvent ?? null,
      home: e.strHomeTeam ?? null,
      away: e.strAwayTeam ?? null,
      id: e.idEvent ?? null
    });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 逐轮抓某联赛多季赛果,按 idEvent / (date,home,away) 去重。
 * @param {{leagueId:string, label:string, seasons:string[], maxRound?:number, fetch?:Function, throttleMs?:number}} opts
 * @returns {Promise<{ok:boolean, label:string, matches:Array, count:number, bySeasonRoundsTried:number}>}
 */
export async function fetchTsdbRoundResults(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const { leagueId, label } = opts;
  const seasons = opts.seasons ?? [];
  const maxRound = opts.maxRound ?? 45;
  const throttleMs = opts.throttleMs ?? 120;
  const seen = new Set();
  const matches = [];
  let roundsTried = 0;
  for (const s of seasons) {
    let emptyStreak = 0;
    for (let r = 1; r <= maxRound; r++) {
      roundsTried += 1;
      let events;
      try {
        const resp = await fetchImpl(`${BASE}/eventsround.php?id=${leagueId}&r=${r}&s=${s}`, { headers: UA });
        if (!resp.ok) { emptyStreak += 1; if (emptyStreak >= 4) break; await sleep(throttleMs); continue; }
        events = (await resp.json())?.events;
      } catch { emptyStreak += 1; if (emptyStreak >= 4) break; await sleep(throttleMs); continue; }
      await sleep(throttleMs);
      const rows = normalizeTsdbEvents(events, label);
      if (!rows.length) { emptyStreak += 1; if (emptyStreak >= 4) break; continue; }
      emptyStreak = 0;
      for (const m of rows) {
        const key = m.id ?? `${m.date}|${m.home}|${m.away}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(m);
      }
    }
  }
  return { ok: matches.length > 0, label, matches, count: matches.length, roundsTried };
}
