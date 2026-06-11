#!/usr/bin/env node
/**
 * 世界杯 match-odds.json 开赛前 ESPN core odds 全量续鲜(2026-06-11 对抗审计落地)。
 *
 * 背景:超算市场融合(α=0.65)读 match-odds.json,但 24 场存盘 collectedAt 最晚
 *   2026-06-10T16:22Z(开幕场开球前 ~27h 的旧快照),且仅 2/24 场走 ESPN,其余 22 场为
 *   500/新浪缓存 → 开赛前市场已漂移(实测墨西哥/南非客胜 8.125→8.50,~4.6%)。
 *   ESPN core odds 端点免 key 免配额(scoreboard 按日期枚举 event id → core odds 拿
 *   DraftKings 三向 decimal),可在开赛前把 24 场全部刷成临场新盘。
 *
 * 铁律:
 *   · 只写真实抓到的三向欧赔(parseEspnCoreOdds 三项>1 才收),抓不到的场保留旧盘并 ⚠️ 列明;
 *   · 已开球的场不刷(in-play 赔率口径不同,混入会污染赛前融合),保留赛前最后快照;
 *   · 每条落盘前过 eloContradiction 常识闸(F1 防错映射再犯);
 *   · 不碰冻结基线 worldcup-*-baseline-2026-06-10.json,只写 match-odds.json。
 *
 * 用法:node scripts/refresh-wc-match-odds-espn.mjs [--dry] [--league fifa.world]
 */
import "../src/env.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDataSubdir } from "../src/paths.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { parseEspnCoreOdds } from "../src/espn-odds-source.js";
import { eloContradiction } from "./ingest-worldcup-match-odds.mjs";

// ── ESPN displayName ↔ groups.json 英文规范名的缺口补丁(canonicalTeamName 覆盖不到的 4 队,
//    2026-06-11 实测:South Korea≠Korea Republic / Bosnia-Herzegovina≠Bosnia and Herzegovina /
//    Cote d'Ivoire≠Ivory Coast / Cabo Verde≠Cape Verde)。只在本世界杯脚本内 overlay,
//    不动共享 team-aliases.js(足球大模型每日管线也用它,边界铁律)。 ──
export const WC_ESPN_ALIAS = {
  "south korea": "Korea Republic",
  "bosnia-herzegovina": "Bosnia and Herzegovina",
  "bosnia & herzegovina": "Bosnia and Herzegovina",
  "cote d'ivoire": "Ivory Coast",
  "côte d'ivoire": "Ivory Coast",
  "cote d’ivoire": "Ivory Coast",
  "côte d’ivoire": "Ivory Coast",
  "cabo verde": "Cape Verde",
};

export function wcCanon(name) {
  const raw = String(name ?? "").trim();
  const aliased = WC_ESPN_ALIAS[raw.toLowerCase()] ?? raw;
  return canonicalTeamName(aliased);
}

export const pairKey = (a, b) => [wcCanon(a), wcCanon(b)].sort().join("|");

/** scoreboard event → {homeName, awayName, eventId, dateIso}。纯函数,解析失败返回 null。 */
export function parseScoreboardEvent(event) {
  const competition = event?.competitions?.[0];
  const competitors = competition?.competitors ?? [];
  const homeC = competitors.find((c) => c.homeAway === "home") ?? competitors[0];
  const awayC = competitors.find((c) => c.homeAway === "away") ?? competitors[1];
  const nameOf = (c) => c?.team?.displayName ?? c?.team?.name ?? c?.team?.shortDisplayName ?? "";
  if (!homeC || !awayC || !event?.id) return null;
  return { eventId: String(event.id), homeName: nameOf(homeC), awayName: nameOf(awayC), dateIso: event.date ?? competition?.date ?? null };
}

/** 把 ESPN event 匹配到 match-odds fixtures(无序对 + swap 判定)。纯函数。 */
export function matchEventToFixture(parsedEvent, fixtures) {
  if (!parsedEvent) return null;
  const eh = wcCanon(parsedEvent.homeName), ea = wcCanon(parsedEvent.awayName);
  for (const fx of fixtures ?? []) {
    const fh = wcCanon(fx.home), fa = wcCanon(fx.away);
    if (fh === eh && fa === ea) return { fixture: fx, swap: false };
    if (fh === ea && fa === eh) return { fixture: fx, swap: true };
  }
  return null;
}

/** 目标比赛日期(UTC YYYY-MM-DD)→ ESPN scoreboard 日期戳集合(当天 + 前一天,scoreboard 按美东日分组)。纯函数。 */
export function scoreboardStamps(dateStrs) {
  const stamps = new Set();
  for (const d of dateStrs ?? []) {
    const base = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) continue;
    for (const off of [-1, 0]) {
      const t = new Date(base.getTime() + off * 86400e3);
      stamps.add(`${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`);
    }
  }
  return [...stamps].sort();
}

/** 单条续鲜决策:返回 {action:'refresh'|'skip', reason?, entry?}。纯函数(now 注入便于测)。 */
export function refreshDecision(fx, parsedEvent, coreParsed, { now = new Date(), gate = eloContradiction } = {}) {
  if (!coreParsed) return { action: "skip", reason: "ESPN core odds 无完整三向赔率(不臆造,保留旧盘)" };
  const kickoff = parsedEvent?.dateIso ? new Date(parsedEvent.dateIso) : null;
  if (kickoff && !Number.isNaN(kickoff.getTime()) && kickoff.getTime() <= now.getTime()) {
    return { action: "skip", reason: `已开球(${parsedEvent.dateIso}),in-play 赔率不混入赛前融合,保留赛前最后快照` };
  }
  const entry = {
    home: fx.home, away: fx.away, odds: coreParsed.european,
    collectedAt: now.toISOString(),
    source: `ESPN core odds (${coreParsed.provider}, event ${parsedEvent.eventId}) 开赛前续鲜`,
    espnEventId: parsedEvent.eventId,
  };
  const contradiction = gate(entry);
  if (contradiction) return { action: "skip", reason: `常识闸拦截:${contradiction}` };
  return { action: "refresh", entry };
}

/** 三向最大漂移百分比(报告用)。纯函数。 */
export function maxDriftPct(oldOdds, newOdds) {
  let max = 0;
  for (const k of ["home", "draw", "away"]) {
    const o = Number(oldOdds?.[k]), n = Number(newOdds?.[k]);
    if (o > 1 && n > 1) max = Math.max(max, Math.abs(n - o) / o * 100);
  }
  return Math.round(max * 10) / 10;
}

async function main() {
  const args = process.argv.slice(2);
  const DRY = args.includes("--dry");
  const li = args.indexOf("--league");
  const LEAGUE = args.find((a) => a.startsWith("--league="))?.split("=")[1]
    ?? (li >= 0 ? args[li + 1] : null) ?? "fifa.world";

  const wcDir = join(getDataSubdir("world-cup"), "2026");
  const oddsFile = join(wcDir, "match-odds.json");
  const doc = JSON.parse(readFileSync(oddsFile, "utf8"));
  const fixtures = doc.fixtures ?? [];
  if (!fixtures.length) { console.log("match-odds.json 无 fixtures,无可续鲜"); return; }

  // 扫描日期 = match-dates.json 中与 fixtures 对得上的场次的 UTC 日期(精确,不盲扫整月)。
  const wantedPairs = new Set(fixtures.map((f) => pairKey(f.home, f.away)));
  const dates = new Set();
  const mdFile = join(wcDir, "match-dates.json");
  if (existsSync(mdFile)) {
    const md = JSON.parse(readFileSync(mdFile, "utf8"));
    for (const m of Object.values(md.matchDate ?? {})) {
      if (m?.homeTeam && m?.awayTeam && wantedPairs.has(pairKey(m.homeTeam, m.awayTeam))) {
        const d = String(m.dateUtc ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
        if (d) dates.add(d);
      }
    }
  }
  if (!dates.size) { // match-dates 缺位时退化为今天起 7 天窗(仍真实枚举,不臆造)
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) dates.add(new Date(t0 + i * 86400e3).toISOString().slice(0, 10));
  }
  const stamps = scoreboardStamps([...dates]);
  console.log(`目标 ${fixtures.length} 场 / scoreboard 日期戳 ${stamps.length} 个(${stamps[0]}..${stamps[stamps.length - 1]}),league=${LEAGUE}`);

  // ① scoreboard 枚举 event id(免 key)。
  const headers = { "User-Agent": "Mozilla/5.0 football-ai-copilot/wc-odds-refresh" };
  const eventByPair = new Map();
  for (const stamp of stamps) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/scoreboard?dates=${stamp}`, { headers });
      if (!res.ok) { console.warn(`⚠️ scoreboard ${stamp} HTTP ${res.status}`); continue; }
      const json = await res.json();
      for (const ev of json.events ?? []) {
        const parsed = parseScoreboardEvent(ev);
        const m = matchEventToFixture(parsed, fixtures);
        if (m) {
          const key = pairKey(m.fixture.home, m.fixture.away);
          if (!eventByPair.has(key)) eventByPair.set(key, { parsed, ...m });
        }
      }
    } catch (err) { console.warn(`⚠️ scoreboard ${stamp} 失败:${err.message}`); }
  }
  console.log(`scoreboard 匹配到 ${eventByPair.size}/${fixtures.length} 场`);

  // ② 逐场拉 core odds → 决策 → 原位更新。
  const now = new Date();
  let refreshed = 0; const skipped = [];
  for (const fx of fixtures) {
    const hit = eventByPair.get(pairKey(fx.home, fx.away));
    if (!hit) { skipped.push(`${fx.home} vs ${fx.away}:ESPN scoreboard 未匹配到(保留旧盘 ${fx.collectedAt})`); continue; }
    let coreParsed = null;
    try {
      const url = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/${LEAGUE}/events/${hit.parsed.eventId}/competitions/${hit.parsed.eventId}/odds`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const items = Array.isArray(json.items) ? json.items : [];
      const item = items.find((it) => it.homeTeamOdds && it.awayTeamOdds && it.drawOdds) ?? items[0] ?? null;
      coreParsed = parseEspnCoreOdds(item, { swap: hit.swap });
    } catch (err) { skipped.push(`${fx.home} vs ${fx.away}:core odds 拉取失败(${err.message}),保留旧盘`); continue; }
    const decision = refreshDecision(fx, hit.parsed, coreParsed, { now });
    if (decision.action !== "refresh") { skipped.push(`${fx.home} vs ${fx.away}:${decision.reason}`); continue; }
    const drift = maxDriftPct(fx.odds, decision.entry.odds);
    console.log(`✅ ${fx.home} vs ${fx.away}: ${fx.odds.home}/${fx.odds.draw}/${fx.odds.away} → ${decision.entry.odds.home}/${decision.entry.odds.draw}/${decision.entry.odds.away}(最大漂移 ${drift}%,event ${hit.parsed.eventId})`);
    Object.assign(fx, decision.entry);
    refreshed += 1;
  }

  console.log(`\n续鲜 ${refreshed}/${fixtures.length} 场;未刷 ${skipped.length} 场:`);
  for (const s of skipped) console.log(`  ⚠️ ${s}`);
  if (!DRY) { writeFileSync(oddsFile, JSON.stringify(doc, null, 1)); console.log(`✅ 写 ${oddsFile}`); }
  else console.log("(--dry 不写盘)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
