/**
 * ESPN Scoreboard Odds(免授权冗余赔率源 — 主攻国家队/友谊赛)
 * ────────────────────────────────────────────────────────────
 * 痛点:国际赛/友谊赛在新浪、football-data、付费 API 上常年抓不到欧赔,
 * 之前只能靠 500.com 单源 + 派生 fallback。ESPN 公开 JSON 免 key、稳定,
 * core API 直接给 DraftKings 的主/平/客 decimal 赔率 + 大小球盘 —— 正好补这个洞。
 *
 * 两步:① scoreboard 列赛程→按 canonicalTeamName(英↔中归一)匹配 fixtures、定主客;
 *       ② 对匹配上的赛事拉 core odds 拿完整 主/平/客。纯函数与抓取分离,可单测。
 */
import { canonicalTeamName } from "./team-aliases.js";
import { normalizeMarketSnapshot } from "./market-data-store.js";

// ESPN soccer 国际赛事 league slug(友谊赛 + 各大洲世预赛 + 国家队杯赛)。
export const ESPN_INTL_LEAGUES = [
  "fifa.friendly", "uefa.nations", "fifa.world", "fifa.cwc",
  "fifa.worldq.uefa", "fifa.worldq.conmebol", "fifa.worldq.concacaf",
  "fifa.worldq.afc", "fifa.worldq.caf", "fifa.worldq.ofc",
  "uefa.euro", "conmebol.america", "caf.nations", "afc.asian"
];

// 美式 moneyLine → 欧洲小数赔率(core API 缺 decimal 字段时兜底)。
export function moneyLineToDecimal(ml) {
  const value = Number(ml);
  if (!Number.isFinite(value) || value === 0) return Number.NaN;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function competitorName(competitor) {
  return competitor?.team?.displayName ?? competitor?.team?.name ?? competitor?.team?.location ?? competitor?.team?.shortDisplayName ?? "";
}

function americanToDecimal(value) {
  const ml = Number(String(value ?? "").replace(/[^0-9+-]/g, ""));
  return moneyLineToDecimal(ml);
}

/**
 * 从 scoreboard 的 odds 对象解析大小球总进球盘(line + 大/小水位,open→initial、close→current)。纯函数。
 */
export function parseEspnScoreboardTotals(competition) {
  const odds = competition?.odds?.[0];
  if (!odds) return null;
  const line = Number(odds.overUnder);
  if (!Number.isFinite(line)) return null;
  const overOpen = americanToDecimal(odds.total?.over?.open?.odds);
  const overClose = americanToDecimal(odds.total?.over?.close?.odds);
  const underOpen = americanToDecimal(odds.total?.under?.open?.odds);
  const underClose = americanToDecimal(odds.total?.under?.close?.odds);
  const initial = { line, over: Number.isFinite(overOpen) ? round3(overOpen) : null, under: Number.isFinite(underOpen) ? round3(underOpen) : null };
  const current = { line, over: Number.isFinite(overClose) ? round3(overClose) : null, under: Number.isFinite(underClose) ? round3(underClose) : null };
  return { initial, current };
}

/**
 * 在 scoreboard JSON 里把赛事匹配到 fixtures。纯函数。
 * @returns {Array<{fixture, eventId, league, swap}>}
 */
export function matchEspnEvents(json, fixtures, league = "") {
  const events = Array.isArray(json?.events) ? json.events : [];
  const matches = [];
  const seen = new Set();
  for (const event of events) {
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    const homeC = competitors.find((c) => c.homeAway === "home") ?? competitors[0];
    const awayC = competitors.find((c) => c.homeAway === "away") ?? competitors[1];
    if (!homeC || !awayC) continue;
    const homeCanon = canonicalTeamName(competitorName(homeC));
    const awayCanon = canonicalTeamName(competitorName(awayC));
    for (const fixture of fixtures) {
      const fHome = canonicalTeamName(fixture.homeTeam);
      const fAway = canonicalTeamName(fixture.awayTeam);
      let swap = null;
      if (fHome === homeCanon && fAway === awayCanon) swap = false;
      else if (fHome === awayCanon && fAway === homeCanon) swap = true;
      if (swap === null) continue;
      const key = fixture.id || `${fHome}-${fAway}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ fixture, eventId: event.id, league: league || event.leagues?.[0]?.slug || "", date: event.date, swap, totals: parseEspnScoreboardTotals(competition) });
    }
  }
  return matches;
}

function decimalFromSide(side) {
  const dec = Number(side?.current?.decimal ?? side?.current?.value);
  if (Number.isFinite(dec) && dec > 1) return dec;
  return moneyLineToDecimal(side?.moneyLine);
}

/**
 * 把 core odds item 解析成 europeanOdds(主/平/客)。纯函数。
 * @param {object} item core odds 单条
 * @param {boolean} swap 主客是否与我方相反
 */
export function parseEspnCoreOdds(item, { swap = false } = {}) {
  if (!item) return null;
  const homeDec = decimalFromSide(item.homeTeamOdds);
  const awayDec = decimalFromSide(item.awayTeamOdds);
  const drawDec = decimalFromSide(item.drawOdds);
  if (![homeDec, drawDec, awayDec].every((v) => Number.isFinite(v) && v > 1)) return null;
  const european = swap
    ? { home: round3(awayDec), draw: round3(drawDec), away: round3(homeDec) }
    : { home: round3(homeDec), draw: round3(drawDec), away: round3(awayDec) };
  const overUnder = Number(item.overUnder);
  return { european, overUnder: Number.isFinite(overUnder) ? overUnder : null, provider: item.provider?.name ?? "ESPN" };
}

function buildSnapshot(fixture, parsed, date, collectedAtIso, totals = null) {
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt: collectedAtIso,
    europeanOdds: { initial: parsed.european, current: parsed.european },
    totals: totals ?? (parsed.overUnder != null ? { line: parsed.overUnder } : null),
    source: `ESPN scoreboard odds (${parsed.provider})`
  }, date);
}

function stampsAround(dateStr, offsets = [-1, 0, 1]) {
  const out = [];
  const base = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return out;
  for (const offset of offsets) {
    const d = new Date(base.getTime() + offset * 86400e3);
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

function fixtureKickoffDate(fixture) {
  return String(fixture?.kickoff ?? fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

// 抓取日期戳 = crawl 当天±1 ∪ 每场自己的开赛日(及前一天兜时区)。
// 这样未来场次(如 14 场胜负彩 06-06/07)也能提前拿到真实赔率并缓存。
export function espnDateStamps(date, fixtures = []) {
  const stamps = new Set(stampsAround(date));
  for (const fixture of fixtures) {
    const kickoff = fixtureKickoffDate(fixture);
    if (kickoff) for (const s of stampsAround(kickoff, [-1, 0])) stamps.add(s);
  }
  return [...stamps];
}

async function fetchCoreOdds(league, eventId, fetchImpl, headers) {
  const url = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/${league}/events/${eventId}/competitions/${eventId}/odds`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json.items) ? json.items : [];
  // 优先有完整三向 moneyLine 的庄(DraftKings priority=1)。
  return items.find((it) => it.homeTeamOdds && it.awayTeamOdds && it.drawOdds) ?? items[0] ?? null;
}

/**
 * 跨多个国际赛事 league + 日期拉取 ESPN,返回与 fixtures 对齐的快照。
 */
export async function crawlEspnScoreboardOdds(date, fixtures, fetchImpl = globalThis.fetch, options = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const targets = fixtures.filter((f) => options.allFixtures || /国|际|友谊|world|nations|friendly|qual/i.test(`${f.competition ?? ""}`));
  if (!targets.length) return [];
  const leagues = options.leagues ?? ESPN_INTL_LEAGUES;
  const stamps = espnDateStamps(date, targets);
  const headers = { "User-Agent": "Mozilla/5.0 football-ai-copilot/espn-odds" };
  const matchedByFixture = new Map();
  for (const league of leagues) {
    for (const stamp of stamps) {
      try {
        const res = await fetchImpl(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${stamp}`, { headers });
        if (!res.ok) continue;
        const json = await res.json();
        for (const m of matchEspnEvents(json, targets, league)) {
          if (!matchedByFixture.has(m.fixture.id)) matchedByFixture.set(m.fixture.id, m);
        }
      } catch {
        // 单 league/日期失败不影响其余。
      }
    }
    if (matchedByFixture.size >= targets.length) break;
  }
  const rows = [];
  for (const m of matchedByFixture.values()) {
    try {
      const item = await fetchCoreOdds(m.league, m.eventId, fetchImpl, headers);
      const parsed = parseEspnCoreOdds(item, { swap: m.swap });
      const totals = m.totals ?? (Number.isFinite(Number(item?.overUnder)) ? { line: Number(item.overUnder) } : null);
      if (parsed) rows.push(buildSnapshot(m.fixture, parsed, date, m.date ? new Date(m.date).toISOString() : new Date().toISOString(), totals));
    } catch {
      // 个别赛事 core odds 拉取失败,跳过。
    }
  }
  return rows;
}
