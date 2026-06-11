#!/usr/bin/env node
/**
 * 世界杯赔率"盘口变化"快照追加器(2026-06-11 用户裁决:现在起定时抓快照,逐步攒出开盘→收盘序列)。
 * ════════════════════════════════════════════════════════════════════════════════
 * 设计:读当前 match-odds.json(由 refresh:wc-odds-espn 续鲜的真实 ESPN/DraftKings 三向欧赔),
 *   把 24 场赔率带时间戳【追加】进 wc-odds-movement.jsonl(每行一个快照)。比赛未开球前持续累积,
 *   开赛后该场最后一条即"收盘盘"。绝不编赔率(铁律):只记真实抓到的盘,源/时间戳全留痕。
 *
 * 与已开球场:不另抓 in-play(口径不同);movement 视图按 kickoff 判,开球后冻结该场最后一条为收盘。
 * 建议调度:每日多次(如 09/15/21/赛前)先跑 refresh:wc-odds-espn 再跑本脚本。
 * 用法: node scripts/wc-odds-snapshot.mjs [--view]   (--view 打印每场 开盘→最新 漂移)
 */
import "../src/env.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDataSubdir } from "../src/paths.js";

const WC_DIR = join(getDataSubdir("world-cup"), "2026");
const ODDS = join(WC_DIR, "match-odds.json");
const LOG = join(WC_DIR, "wc-odds-movement.jsonl");

/** 读 movement 日志全部快照。 */
export function loadMovement() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** 每场 开盘(首条)→最新(末条)漂移 + 全部中间点。key=home|away。 */
export function movementByMatch(snapshots = loadMovement()) {
  const byMatch = new Map();
  for (const snap of snapshots) {
    for (const f of snap.fixtures || []) {
      const k = `${f.home}|${f.away}`;
      if (!byMatch.has(k)) byMatch.set(k, []);
      byMatch.get(k).push({ at: snap.capturedAt, odds: f.odds });
    }
  }
  const out = new Map();
  for (const [k, series] of byMatch) {
    const open = series[0], latest = series[series.length - 1];
    const drift = (s) => ["home", "draw", "away"].map((side) => {
      const o = open.odds[side], l = latest.odds[side];
      return o && l ? Number((((l - o) / o) * 100).toFixed(1)) : null;
    });
    out.set(k, { points: series.length, open, latest, driftPct: { home: drift()[0], draw: drift()[1], away: drift()[2] }, series });
  }
  return out;
}

function runMain() {
  if (process.argv.includes("--view")) {
    const mv = movementByMatch();
    if (!mv.size) { console.log("⚠️ 暂无快照(先跑几次本脚本累积)。"); return; }
    console.log(`=== 世界杯赔率盘口变化(${mv.size} 场,开盘→最新)===`);
    for (const [k, m] of mv) {
      const o = m.open.odds, l = m.latest.odds;
      const d = m.driftPct;
      console.log(`${k.replace("|", " vs ").padEnd(26)} ${m.points}点 | 主 ${o.home}→${l.home}(${d.home > 0 ? "+" : ""}${d.home}%) 平 ${o.draw}→${l.draw} 客 ${o.away}→${l.away}(${d.away > 0 ? "+" : ""}${d.away}%)`);
    }
    return;
  }

  if (!existsSync(ODDS)) { console.log("⚠️ 无 match-odds.json,先跑 refresh:wc-odds-espn。"); process.exit(0); }
  const o = JSON.parse(readFileSync(ODDS, "utf8"));
  const fixtures = (o.fixtures || []).filter((f) => f.odds && f.odds.home > 1 && f.odds.away > 1)
    .map((f) => ({ home: f.home, away: f.away, odds: f.odds, source: f.source, espnEventId: f.espnEventId, collectedAt: f.collectedAt }));
  if (!fixtures.length) { console.log("⚠️ match-odds.json 无可用真实赔率,不追加(铁律:不编)。"); process.exit(0); }

  // capturedAt:用赔率文件里最新 collectedAt(真实抓取时刻),无则不追加(避免 Date.now 不可追溯臆造时刻)。
  const capturedAt = fixtures.map((f) => f.collectedAt).filter(Boolean).sort().pop() || null;
  if (!capturedAt) { console.log("⚠️ 赔率无 collectedAt 时间戳,拒绝追加(不臆造时刻)。"); process.exit(0); }

  // 去重:若与日志最后一条 capturedAt 相同则跳过(同一次抓取别重复记)。
  const existing = loadMovement();
  const lastAt = existing.length ? existing[existing.length - 1].capturedAt : null;
  if (lastAt === capturedAt) { console.log(`⏭ 快照 ${capturedAt} 已记录(${existing.length} 条),跳过。先 refresh 出新盘再抓。`); return; }

  appendFileSync(LOG, JSON.stringify({ capturedAt, n: fixtures.length, fixtures }) + "\n", "utf8");
  console.log(`✅ 追加快照 ${capturedAt}(${fixtures.length}场)→ ${LOG}(累计 ${existing.length + 1} 条)`);
  const mv = movementByMatch();
  const moved = [...mv.values()].filter((m) => m.points > 1 && (Math.abs(m.driftPct.home || 0) > 2 || Math.abs(m.driftPct.away || 0) > 2));
  if (moved.length) console.log(`📈 已有 ${moved.length} 场出现 >2% 盘口移动(--view 看详情)。`);
  else if (existing.length) console.log("盘口暂稳(<2% 漂移)。");
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) runMain();
