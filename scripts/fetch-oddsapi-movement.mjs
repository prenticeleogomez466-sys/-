// The Odds API → 世界杯赔率异动/CLV 源。替代已死 odds.500.com / 配错的 betexplorer / 宕机 titan007。
//
// 为什么用它(2026-06-08 实证):干净 JSON、无反爬(不用非headless Chrome)、单场 24+ 家盘口、
//   soccer_fifa_world_cup 已 active(72场,首场 6/11 墨西哥vs南非)。免费 key 在 ODDS_API_KEY。
//   局限:免费档只给"即时"多家盘口,无历史端点 → 用"首见即开盘 + 每次刷新当即时"自建异动:
//     · open 基线 write-once(某场首次出现才记开盘,之后只读不覆盖);
//     · latest 每次覆盖;movement = open→latest;收盘由 CaptureClosing 末次刷新充当。
//   故第一次跑 open==latest 无异动(诚实),跨日多次刷新后才攒出真异动+CLV。
//   友谊赛(如今日荷兰vs乌兹别克)The Odds API 无 sport key → 不覆盖,本源只管世界杯。
//
// 用法:node scripts/fetch-oddsapi-movement.mjs [--sport soccer_fifa_world_cup] [--region eu] [--json]
import "../src/env.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SPORT = arg("--sport", "soccer_fifa_world_cup");
const REGION = arg("--region", "eu");
const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error("缺 ODDS_API_KEY(见记忆 reference_integrable_api_keys)"); process.exit(1); }

const dir = getDataSubdir("market");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const openPath = join(dir, `oddsapi-${SPORT}-open.json`);
const latestPath = join(dir, `oddsapi-${SPORT}-latest.json`);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")); } catch { return null; } };

const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${KEY}&regions=${REGION}&markets=h2h,totals&oddsFormat=decimal`;
const res = await fetch(url);
if (res.status !== 200) { console.error(`The Odds API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1); }
const events = await res.json();
const used = res.headers.get("x-requests-used"), remaining = res.headers.get("x-requests-remaining");

// 中位数共识 + de-vig。每场聚合所有盘口的 home/draw/away 十进制赔率取中位,再归一成概率。
const median = (a) => { const s = a.filter((x) => x > 0).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
function consensus(ev) {
  const H = [], D = [], A = [];
  for (const bk of ev.bookmakers ?? []) {
    const m = (bk.markets ?? []).find((x) => x.key === "h2h");
    if (!m) continue;
    for (const o of m.outcomes ?? []) {
      if (o.name === ev.home_team) H.push(o.price);
      else if (o.name === ev.away_team) A.push(o.price);
      else if (/draw/i.test(o.name)) D.push(o.price);
    }
  }
  const r3 = (x) => x == null ? null : Math.round(x * 1000) / 1000;
  const h = r3(median(H)), d = r3(median(D)), a = r3(median(A));
  if (!h || !d || !a) return null;
  const inv = 1 / h + 1 / d + 1 / a; // overround
  return { books: ev.bookmakers?.length ?? 0, oddsHome: h, oddsDraw: d, oddsAway: a,
    pHome: (1 / h) / inv, pDraw: (1 / d) / inv, pAway: (1 / a) / inv, overround: inv };
}

// 大小球 2.5 线共识 de-vig(补齐覆盖 2026-06-09:此前只存 h2h 致大小球无源头可审计)
function totalsConsensus(ev, line = 2.5) {
  const O = [], U = [];
  for (const bk of ev.bookmakers ?? []) {
    const m = (bk.markets ?? []).find((x) => x.key === "totals");
    if (!m) continue;
    const o = (m.outcomes ?? []).find((x) => /over/i.test(x.name) && x.point === line);
    const u = (m.outcomes ?? []).find((x) => /under/i.test(x.name) && x.point === line);
    if (o && u) { O.push(o.price); U.push(u.price); }
  }
  const mo = median(O), mu = median(U);
  if (!mo || !mu) return null;
  const inv = 1 / mo + 1 / mu;
  return { line, books: O.length, oddsOver: +mo.toFixed(3), oddsUnder: +mu.toFixed(3),
    pOver: +((1 / mo) / inv).toFixed(3), pUnder: +((1 / mu) / inv).toFixed(3), overround: +inv.toFixed(4) };
}

const nowSnap = {};
for (const ev of Array.isArray(events) ? events : []) {
  const c = consensus(ev);
  if (!c) continue;
  nowSnap[ev.id] = { id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, ...c, ou: totalsConsensus(ev) };
}

// open 基线:write-once per match
const open = readJson(openPath) ?? { capturedAt: null, byMatch: {} };
let newOpens = 0;
for (const [id, snap] of Object.entries(nowSnap)) {
  if (!open.byMatch[id]) { open.byMatch[id] = { ...snap, openCapturedAt: new Date().toISOString() }; newOpens++; }
}
if (newOpens) { open.capturedAt = open.capturedAt ?? new Date().toISOString(); writeFileSync(openPath, JSON.stringify(open, null, 2), "utf8"); }
writeFileSync(latestPath, JSON.stringify({ capturedAt: new Date().toISOString(), byMatch: nowSnap }, null, 2), "utf8");

// movement = open→latest(基于主胜十进制赔率)
const out = [];
for (const [id, cur] of Object.entries(nowSnap)) {
  const o = open.byMatch[id];
  const sig = (oo, cc) => oo && cc ? (cc < oo - 0.005 ? "↓压入(steam in)" : cc > oo + 0.005 ? "↑走高(drift out)" : "持平") : "—";
  out.push({ match: `${cur.home} vs ${cur.away}`, commence: cur.commence?.slice(0, 16), books: cur.books,
    home: { open: o?.oddsHome ?? null, cur: cur.oddsHome, sig: sig(o?.oddsHome, cur.oddsHome) },
    draw: { open: o?.oddsDraw ?? null, cur: cur.oddsDraw, sig: sig(o?.oddsDraw, cur.oddsDraw) },
    away: { open: o?.oddsAway ?? null, cur: cur.oddsAway, sig: sig(o?.oddsAway, cur.oddsAway) },
    consensusProb: { home: +cur.pHome.toFixed(3), draw: +cur.pDraw.toFixed(3), away: +cur.pAway.toFixed(3) } });
}
out.sort((a, b) => String(a.commence).localeCompare(String(b.commence)));

if (args.includes("--json")) { console.log(JSON.stringify(out, null, 2)); }
else {
  console.log(`The Odds API · ${SPORT} · ${out.length}场 | 本次API用量 used=${used} remaining=${remaining} | 新记开盘${newOpens}场`);
  console.log(`存储: ${openPath} (开盘write-once) / ${latestPath} (每次刷新)`);
  for (const m of out.slice(0, 12)) {
    const mv = (x) => x.open ? `${x.open}→${x.cur} ${x.sig}` : `${x.cur}(无开盘基线)`;
    console.log(`  ${m.commence} ${m.match} [${m.books}家] 主${mv(m.home)} | 平${mv(m.draw)} | 客${mv(m.away)} | 共识 主${(m.consensusProb.home*100).toFixed(0)}/平${(m.consensusProb.draw*100).toFixed(0)}/客${(m.consensusProb.away*100).toFixed(0)}`);
  }
  if (newOpens === out.length) console.log("⚠️ 首次跑:全部为开盘基线,open==cur 无异动(诚实)。跨日多次刷新后才攒出真异动+收盘CLV。");
}
