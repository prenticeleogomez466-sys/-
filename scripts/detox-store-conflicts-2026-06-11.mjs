#!/usr/bin/env node
/**
 * detox v2(2026-06-11 ledger-settlement-2 / store-hygiene-2):
 * 清洗 fixture store 跨业务日"同场比分互斥"残留假赛果——ESPN 官方赛果仲裁回写。
 *
 * 背景:0610 detox(detox-ledger-2026-06-10.mjs)判据只有"kickoff>now 却有 result",
 * 这批坏值(摩洛哥4-0挪威×4份 / 英格兰4-0新西兰×4份 等,源=sporttery 公告页错配)在
 * 06-10 时比赛已开赛,伪装成合法 settled 漏网;backfill 跳过已有 result 永不自愈;
 * DC 拟合/球队画像全量消费 → 挪威 attack 被压到 0.351、克罗地亚画像"负负负负胜"。
 *
 * 仲裁规则(铁律:绝不兜底/绝不臆断):
 *   1. 扫描域 = store 全部日期文件,冲突判定 = findCrossFileResultConflicts;
 *   2. 每组冲突 → 按 competition 路由 ESPN 联赛 slug,在真实赛日 UTC 前后两天窗口拉
 *      scoreboard,主客队双边严格匹配(中文名→ESPN displayName 显式映射表,缺映射=不仲裁);
 *      必须恰好命中 1 场 STATUS_FULL_TIME 事件,否则该组跳过并 fail-loud;
 *   3. 真值 = ESPN 终场比分;组内已与真值一致的副本作"供体"(优先最新业务日,半场数据
 *      一并继承);比分≠真值的副本 result 整体替换为供体 result,并打 resultCorrection 痕迹;
 *   4. 组内无任何副本匹配 ESPN 真值 → 不臆造半场,result 写 {home,away,halfHome:null,halfAway:null};
 *   5. 写盘前每个被改文件备份到 D:\football-model-data\backups\(exports 根有清空史,不放那)。
 *
 * 用法:
 *   node scripts/detox-store-conflicts-2026-06-11.mjs --dry   # 只报告不写盘
 *   node scripts/detox-store-conflicts-2026-06-11.mjs         # 实清洗(带备份)
 */
import "../src/env.js";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "../src/fixture-store.js";
import { findCrossFileResultConflicts, listStoreDates } from "../src/result-sanity.js";
import { getDataDir } from "../src/paths.js";

const DRY = process.argv.includes("--dry");

// competition → ESPN 联赛 slug 候选(只列本次冲突涉及的;新冲突落在表外=不仲裁、fail-loud 人工扩表)
const COMPETITION_SLUGS = new Map([
  ["国际赛", ["fifa.friendly", "fifa.worldq.uefa", "fifa.world"]],
  ["瑞超", ["swe.1"]],
  ["瑞典超级联赛", ["swe.1"]],
]);

// 中文队名 → ESPN displayName(2026-06-11 由 ESPN scoreboard 实拉核对;严格双边匹配用)
const ZH_TO_ESPN = new Map([
  ["克罗地亚", "Croatia"], ["斯洛文尼亚", "Slovenia"],
  ["摩洛哥", "Morocco"], ["挪威", "Norway"],
  ["斯洛伐克", "Slovakia"], ["黑山", "Montenegro"],
  ["匈牙利", "Hungary"], ["芬兰", "Finland"],
  ["加拿大", "Canada"], ["爱尔兰", "Republic of Ireland"],
  ["比利时", "Belgium"], ["突尼斯", "Tunisia"],
  ["美国", "United States"], ["德国", "Germany"],
  ["巴拿马", "Panama"], ["波黑", "Bosnia-Herzegovina"],
  ["英格兰", "England"], ["新西兰", "New Zealand"],
  ["巴西", "Brazil"], ["埃及", "Egypt"],
  ["土耳其", "Türkiye"], ["北马其顿", "North Macedonia"],
  ["哥德堡盖斯", "GAIS"], ["卡尔马", "Kalmar FF"],
]);

const scoreboardCache = new Map();
async function fetchScoreboard(slug, yyyymmdd) {
  const cacheKey = `${slug}|${yyyymmdd}`;
  if (scoreboardCache.has(cacheKey)) return scoreboardCache.get(cacheKey);
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${yyyymmdd}`;
  let events = [];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const json = await res.json();
      events = Array.isArray(json?.events) ? json.events : [];
    }
  } catch {
    events = []; // 网络失败=拿不到证据 → 该日窗口无候选,组级 fail-loud,绝不臆断
  }
  scoreboardCache.set(cacheKey, events);
  return events;
}

function eventSides(ev) {
  const comp = ev?.competitions?.[0];
  const cs = comp?.competitors ?? [];
  const h = cs.find((c) => c.homeAway === "home");
  const a = cs.find((c) => c.homeAway === "away");
  const status = comp?.status?.type?.name ?? ev?.status?.type?.name ?? "";
  return {
    id: ev?.id ?? null,
    home: h?.team?.displayName ?? "",
    away: a?.team?.displayName ?? "",
    homeScore: Number(h?.score),
    awayScore: Number(a?.score),
    full: status === "STATUS_FULL_TIME" || status === "STATUS_FINAL",
  };
}

/** 真实赛日(北京口径)→ ESPN UTC 查询日窗口:前一天/当天/后一天 */
function utcDateCandidates(matchDay) {
  const base = new Date(`${matchDay}T00:00:00Z`);
  return [-1, 0, 1].map((off) => {
    const d = new Date(base.getTime() + off * 86400000);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  });
}

async function arbitrate(conflict) {
  const [matchDay, homeZh, awayZh] = conflict.key.split("|");
  const homeEn = ZH_TO_ESPN.get(homeZh);
  const awayEn = ZH_TO_ESPN.get(awayZh);
  if (!homeEn || !awayEn) return { ok: false, reason: `队名缺 ESPN 映射(${!homeEn ? homeZh : awayZh})——人工扩 ZH_TO_ESPN 表` };
  const comps = [...new Set(conflict.copies.map((c) => c.competition).filter(Boolean))];
  const slugs = [...new Set(comps.flatMap((c) => COMPETITION_SLUGS.get(c) ?? []))];
  if (!slugs.length) return { ok: false, reason: `competition=${comps.join("/")} 无 ESPN slug 路由——人工扩 COMPETITION_SLUGS 表` };
  const hits = new Map(); // eventId → side info
  for (const slug of slugs) {
    for (const ymd of utcDateCandidates(matchDay)) {
      for (const ev of await fetchScoreboard(slug, ymd)) {
        const s = eventSides(ev);
        if (s.home === homeEn && s.away === awayEn && s.full && Number.isFinite(s.homeScore) && Number.isFinite(s.awayScore)) {
          hits.set(s.id ?? `${slug}|${ymd}|${s.home}`, s);
        }
      }
    }
  }
  if (hits.size !== 1) return { ok: false, reason: `ESPN 双边匹配命中 ${hits.size} 场(要求恰 1)——不仲裁` };
  const truth = [...hits.values()][0];
  return { ok: true, truth: `${truth.homeScore}-${truth.awayScore}`, home: truth.homeScore, away: truth.awayScore, eventId: truth.id };
}

// ── 主流程 ──
const storeDates = listStoreDates(fixtureDir);
const entries = [];
for (const d of storeDates) {
  let payload;
  try { payload = JSON.parse(readFileSync(join(fixtureDir, `${d}.json`), "utf8")); } catch { continue; }
  const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
  for (const f of fixtures) entries.push({ storeDate: d, fixture: f });
}
const conflicts = findCrossFileResultConflicts(entries);
console.log(`冲突组:${conflicts.length}(扫描 ${storeDates.length} 文件)${DRY ? " [--dry 只报告]" : ""}`);

const backupDir = join(getDataDir(), "backups", "detox-store-conflicts-2026-06-11");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const plans = new Map(); // storeDate → [{key, prevScore, truthResult, espnEventId}]
let unresolved = 0;

for (const conflict of conflicts) {
  const verdict = await arbitrate(conflict);
  if (!verdict.ok) {
    unresolved++;
    console.error(`⛔ ${conflict.key} {${conflict.scores.join(" vs ")}} 未仲裁:${verdict.reason}`);
    continue;
  }
  // 供体:组内比分==ESPN 真值的副本(优先最新业务日)→ 继承其完整 result(含真实半场);
  // 无供体则只写 ESPN 终场,半场诚实置 null(绝不臆造)。
  const donors = conflict.copies.filter((c) => c.score === verdict.truth).sort((a, b) => b.storeDate.localeCompare(a.storeDate));
  let donorResult = null;
  if (donors.length) {
    const d = donors[0];
    const payload = JSON.parse(readFileSync(join(fixtureDir, `${d.storeDate}.json`), "utf8"));
    const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
    const [matchDay, homeZh, awayZh] = conflict.key.split("|");
    const row = fixtures.find((f) => {
      const md = String(f.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? String(f.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
      return md === matchDay && String(f.homeTeam ?? "").trim() === homeZh && String(f.awayTeam ?? "").trim() === awayZh && f.result;
    });
    if (row && Number(row.result.home) === verdict.home && Number(row.result.away) === verdict.away) donorResult = { ...row.result };
  }
  const truthResult = donorResult ?? { home: verdict.home, away: verdict.away, halfHome: null, halfAway: null };
  const wrong = conflict.copies.filter((c) => c.score !== verdict.truth);
  console.log(`✅ ${conflict.key} ESPN真值=${verdict.truth}(event ${verdict.eventId}) → 修 ${wrong.length} 份假副本(${wrong.map((w) => `${w.storeDate}:${w.score}`).join(", ")})`);
  for (const w of wrong) {
    if (!plans.has(w.storeDate)) plans.set(w.storeDate, []);
    plans.get(w.storeDate).push({ key: conflict.key, prevScore: w.score, truthResult, espnEventId: verdict.eventId });
  }
}

let fixedRows = 0;
if (!DRY) {
  mkdirSync(backupDir, { recursive: true });
  for (const [storeDate, fixes] of plans) {
    const filePath = join(fixtureDir, `${storeDate}.json`);
    copyFileSync(filePath, join(backupDir, `${storeDate}.json.${stamp}.bak`));
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
    for (const fix of fixes) {
      const [matchDay, homeZh, awayZh] = fix.key.split("|");
      for (const f of fixtures) {
        const md = String(f.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? String(f.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
        if (md !== matchDay || String(f.homeTeam ?? "").trim() !== homeZh || String(f.awayTeam ?? "").trim() !== awayZh) continue;
        if (!f.result || `${f.result.home}-${f.result.away}` !== fix.prevScore) continue;
        f.result = { ...fix.truthResult };
        f.resultCorrection = {
          at: new Date().toISOString(),
          by: "detox-store-conflicts-2026-06-11(ESPN仲裁)",
          prev: fix.prevScore,
          espnEventId: fix.espnEventId,
        };
        fixedRows++;
      }
    }
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`💾 ${storeDate}.json 已回写(备份在 ${backupDir})`);
  }
} else {
  fixedRows = [...plans.values()].reduce((n, v) => n + v.length, 0);
}

console.log(`\n汇总:冲突 ${conflicts.length} 组,${DRY ? "拟" : "已"}修假副本 ${fixedRows} 行,未仲裁 ${unresolved} 组。`);
if (unresolved > 0) process.exit(1);
