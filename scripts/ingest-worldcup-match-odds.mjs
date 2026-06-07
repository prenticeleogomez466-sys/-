#!/usr/bin/env node
/**
 * 世界杯逐场 1X2 临场赔率 → match-odds.json(2026-06-07 开赛前体检补)。
 *
 * 背景:超算/champion-sim 的【单场市场融合】(world-cup-priors.worldCupMatchOdds:有逐场临场
 *   赔率的已知对阵用 Shin 去抽水的市场隐含胜率 α=0.65 融进 Elo)读 match-odds.json 的 fixtures,
 *   但此前**没有任何写入方** → fixtures 恒空 → 融合层永远休眠跑纯 Elo(升级静默不生效)。
 *
 * 本脚本从每日 market 快照(<data>/market/<date>.json)挑【世界杯】比赛中有真实欧赔
 *   (europeanOdds.{final??current??initial})的场,队名中文→groups.json 英文规范名(与超算
 *   groups 口径一致,两边经 canonTeam 必对上),写进 match-odds.json 的 fixtures。
 *
 * 铁律(feedback_no_fallback_absolute):只写【真实抓到的 1X2 欧赔】,绝不从让球水位/中性值估算;
 *   14场胜负彩快照(只有让球水位、europeanOdds=null)直接跳过;无该场赔率即不写(超算回退纯 Elo)。
 *
 * 用法:node scripts/ingest-worldcup-match-odds.mjs [--days N(默认7)] [--dry]
 */
import "../src/env.js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDataSubdir } from "../src/paths.js";

// ── 纯函数(可单测):market 快照 → match-odds.json 的 fixtures。中文队名经 zhToEn 转 groups 英文。 ──
//    铁律:只取真实欧赔(final??current??initial,三项>1);14场胜负彩 europeanOdds=null → 跳过,不臆造。
export function pickEuropeanOdds(europeanOdds) {
  const pick = europeanOdds?.final ?? europeanOdds?.current ?? europeanOdds?.initial;
  if (!pick) return null;
  const home = Number(pick.home), draw = Number(pick.draw), away = Number(pick.away);
  return (home > 1 && draw > 1 && away > 1) ? { home, draw, away } : null;
}

export function wcFixturesFromSnapshots(snapshots, zhToEn = {}, fallbackSource = "") {
  const toEn = (name) => zhToEn[String(name ?? "").trim()] ?? name;
  const keyOf = (a, b) => [String(a ?? "").toLowerCase().trim(), String(b ?? "").toLowerCase().trim()].sort().join("|");
  const byPair = new Map();
  for (const s of snapshots ?? []) {
    if (!/世界杯|World\s*Cup/i.test(String(s?.competition ?? ""))) continue;
    const odds = pickEuropeanOdds(s?.europeanOdds);
    if (!odds) continue;
    const home = toEn(s.homeTeam), away = toEn(s.awayTeam);
    const key = keyOf(home, away);
    const collectedAt = s.collectedAt ?? "";
    const prev = byPair.get(key);
    if (!prev || String(collectedAt) > String(prev.collectedAt)) {
      byPair.set(key, { home, away, odds, collectedAt, source: s.source ?? fallbackSource });
    }
  }
  return byPair;
}

function main() {
  const args = process.argv.slice(2);
  const DRY = args.includes("--dry");
  const daysArg = args.find((a) => a.startsWith("--days"));
  const DAYS = Number((daysArg?.split("=")[1]) ?? args[args.indexOf("--days") + 1] ?? 7) || 7;

  const wcDir = join(getDataSubdir("world-cup"), "2026");
  const marketDir = getDataSubdir("market");
  const oddsFile = join(wcDir, "match-odds.json");

  // groups.json 中文→英文规范名(与超算 groups 口径一致)。
  const groups = JSON.parse(readFileSync(join(wcDir, "groups.json"), "utf8"));
  const zhToEn = {};
  for (const [en, zh] of Object.entries(groups.team_name_zh ?? {})) zhToEn[zh] = en;
  const keyOf = (a, b) => [String(a ?? "").toLowerCase().trim(), String(b ?? "").toLowerCase().trim()].sort().join("|");

  // 取最近 DAYS 天存在的 market 快照文件,聚合所有世界杯真实欧赔场(同对阵取最新)。
  const allFiles = existsSync(marketDir)
    ? readdirSync(marketDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, DAYS)
    : [];
  const byPair = new Map();
  let scanned = 0;
  for (const f of allFiles) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(marketDir, f), "utf8")); } catch { continue; }
    const snaps = doc.snapshots ?? doc.fixtures ?? [];
    scanned += snaps.length;
    const part = wcFixturesFromSnapshots(snaps, zhToEn, doc.source ?? f);
    for (const [key, fx] of part) {
      const prev = byPair.get(key);
      if (!prev || String(fx.collectedAt) > String(prev.collectedAt)) byPair.set(key, fx);
    }
  }

  // 与现有 match-odds.json 合并(新抓到的同对阵覆盖旧的;旧的其他场保留)。
  let existing = { edition: "2026", fixtures: [] };
  if (existsSync(oddsFile)) { try { existing = JSON.parse(readFileSync(oddsFile, "utf8")); } catch {} }
  const merged = new Map();
  for (const fx of existing.fixtures ?? []) {
    if (pickEuropeanOdds({ current: fx.odds })) merged.set(keyOf(fx.home, fx.away), fx);
  }
  for (const [key, fx] of byPair) {
    const prev = merged.get(key);
    if (!prev || String(fx.collectedAt) > String(prev.collectedAt ?? "")) merged.set(key, fx);
  }

  const out = { ...existing, edition: existing.edition ?? "2026", fixtures: [...merged.values()] };

  console.log(`扫描 ${allFiles.length} 个 market 文件 / ${scanned} 快照 → 世界杯真实欧赔对阵 ${byPair.size},合并后总 ${out.fixtures.length}`);
  if (byPair.size) {
    for (const fx of byPair.values()) console.log(`  ${fx.home} vs ${fx.away}: ${fx.odds.home}/${fx.odds.draw}/${fx.odds.away}`);
  } else {
    console.log("  (今日无世界杯真实 1X2 欧赔——竞彩单场世界杯尚未开售或仅 14场胜负彩;超算继续纯 Elo,正确不臆造)");
  }
  if (!DRY) { writeFileSync(oddsFile, JSON.stringify(out, null, 1)); console.log(`✅ 写 ${oddsFile}`); }
  else console.log("(--dry 不写盘)");
}

// 仅在直接运行时执行副作用;被 import(单测)时只暴露纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
