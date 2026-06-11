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
import { fetchOddsApiRotating, listOddsApiKeys } from "../src/odds-api-rotation.js";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SPORT = arg("--sport", "soccer_fifa_world_cup");
const REGION = arg("--region", "eu");
if (!listOddsApiKeys().length) { console.error("缺 ODDS_API_KEY(免费多 key 可配 ODDS_API_KEYS / ODDS_API_KEY_2..9,见记忆 reference_integrable_api_keys)"); process.exit(1); }

const dir = getDataSubdir("market");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const openPath = join(dir, `oddsapi-${SPORT}-open.json`);
const latestPath = join(dir, `oddsapi-${SPORT}-latest.json`);
const quotaStatusPath = join(dir, "oddsapi-quota-status.json");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")); } catch { return null; } };

// 缺陷#11(2026-06-10):多免费 key 轮换;配额全军覆没(401/429)= 优雅降级:
//   不刷新 open/latest(保持上次【真实】快照原样,绝不编数据)、落 quota 状态文件如实标注
//   "外盘缺失",exit 0 —— 配额耗尽是已知月度约束,不该把计划任务打成 0x1 假故障。
//   其他错误(网络/4xx/5xx)仍 fail-loud exit 1。
const rot = await fetchOddsApiRotating((key) => `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${key}&regions=${REGION}&markets=h2h,totals&oddsFormat=decimal`);
if (!rot.ok) {
  if (rot.quotaExhausted) {
    writeFileSync(quotaStatusPath, JSON.stringify({ exhaustedAt: new Date().toISOString(), sport: SPORT, keyCount: rot.attempts.length, attempts: rot.attempts, note: "外盘缺失:The Odds API 免费配额耗尽,本轮未刷新异动(open/latest 保持上次真实快照),等待月度重置;可在 local.env 加 ODDS_API_KEYS/ODDS_API_KEY_2..9 免费 key 轮换" }, null, 2), "utf8");
    console.error(`⚠️ ${rot.error}`);
    console.error(`   状态已落盘:${quotaStatusPath}(open/latest 未动,无伪造)`);
    process.exit(0);
  }
  console.error(rot.error);
  process.exit(1);
}
if (existsSync(quotaStatusPath)) { try { writeFileSync(quotaStatusPath, JSON.stringify({ recoveredAt: new Date().toISOString(), sport: SPORT, remaining: rot.remaining }, null, 2), "utf8"); } catch {} }
const events = await rot.response.json();
const used = rot.used, remaining = rot.remaining;

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
// 缺陷②(2026-06-11):落盘+输出已全部完成,显式退出。
//   原因:本脚本走原生 fetch(undici)keep-alive,Windows 下进程自然退出时残留 libuv async
//   句柄会触发 Assertion `!(handle->flags & UV_HANDLE_CLOSING)`(src\win\async.c:94)→ 进程以
//   0xC0000409 崩溃,污染 CaptureClosing(run-capture-closing.cmd 末步)退出码,把已成功的
//   收盘捕获打成假故障。数据此刻已 writeFileSync 落盘无损;此处同步 exit(0) 在 libuv teardown
//   之前结束进程,既保住正确退出码又不丢数据(绝不兜底/绝不编造)。
process.exit(0);
