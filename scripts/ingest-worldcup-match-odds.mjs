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
import { shinFromInverse } from "../src/market-devig.js";
import { teamPrior } from "../src/world-cup-priors.js";

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

// ── 常识闸(F1 防再犯,2026-06-10):entry 落盘前用 world-cup-priors 的 Elo 差做矛盾检查。 ──
//    背景:CubeGoal 赔率页错映射到别场 → Germany vs Curacao 写成 1.94/4.6/2.52(德国 Elo 1925 vs
//    1433,ESPN/DK 实测 1.029)、Iraq vs Norway 把伊拉克标热门 2.03(挪威实测 1.211)→ 污染
//    出线概率(挪威 -14.7pp/德国 -6.4pp)。坏数据还潜伏在 market 快照/stability-cache,11:15
//    计划任务重跑会再扫到,此闸防写回。
//    规则(|Elo差|>ELO_CONTRADICTION_GAP 时启用,二选一命中即丢弃+console ⚠️ 列明原因):
//      ① 方向矛盾:Shin 后弱队隐含概率反高于强队(弱队成热门)= 物理不可能;
//      ② 量级矛盾:强队 Elo 胜期望 We 与市场隐含胜期望(pWin+0.5·pDraw)差 > MAX_WE_SHORTFALL。
//        德国坏条(1.94 仍主热,方向闸拦不住)shortfall=0.38、伊拉克坏条 0.39;而真实分歧最大的
//        Ivory Coast vs Ecuador(500 实盘 3.36/2.65/2.2,ESPN/DK 同口径 3.6/2.85/2.45 印证为真)
//        仅 0.24 → 阈值 0.30 两侧各留 ~0.06 安全边际,不误杀真实市场分歧。
//    Elo差≤250 一律放行(正常冷门盘不拦);任一队无 Elo → 不拦(无法判定不臆造)。
//    返回 null=通过,字符串=丢弃原因。
export const ELO_CONTRADICTION_GAP = 250;
export const MAX_WE_SHORTFALL = 0.30;
export function eloContradiction(fx, getPrior = teamPrior) {
  const oH = Number(fx?.odds?.home), oD = Number(fx?.odds?.draw), oA = Number(fx?.odds?.away);
  if (!(oH > 1 && oD > 1 && oA > 1)) return null; // 无效赔率交给既有 pickEuropeanOdds 闸
  const eloH = Number(getPrior(fx.home)?.elo), eloA = Number(getPrior(fx.away)?.elo);
  if (!Number.isFinite(eloH) || !Number.isFinite(eloA)) return null;
  const diff = eloH - eloA;
  if (Math.abs(diff) <= ELO_CONTRADICTION_GAP) return null;
  const { probs: [pH, pD, pA] } = shinFromInverse([1 / oH, 1 / oD, 1 / oA]);
  const [strongName, pStrong, pWeak] = diff > 0 ? [fx.home, pH, pA] : [fx.away, pA, pH];
  const head = `Elo差${diff > 0 ? "+" : ""}${Math.round(diff)}(${fx.home} ${eloH} vs ${fx.away} ${eloA})`;
  if (pWeak > pStrong) {
    return `${head}但Shin隐含弱队反成热门(强队${strongName}仅${pStrong.toFixed(3)} < 弱队${pWeak.toFixed(3)}),物理不可能,疑似错映射赔率`;
  }
  const eloWe = 1 / (Math.pow(10, -Math.abs(diff) / 400) + 1); // 强队 Elo 胜期望
  const marketWe = pStrong + 0.5 * pD;
  if (eloWe - marketWe > MAX_WE_SHORTFALL) {
    return `${head}强队${strongName} Elo胜期望${eloWe.toFixed(3)}但市场隐含仅${marketWe.toFixed(3)}(shortfall ${(eloWe - marketWe).toFixed(3)}>${MAX_WE_SHORTFALL}),量级假,疑似错映射赔率`;
  }
  return null;
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
  // 常识闸在合并【前】分别过滤存量与新扫候选:坏候选被拒时不连累同对阵已有的好 entry
  //(否则坏条凭更新 collectedAt 先赢合并、再被闸整对删掉,平白丢真数据)。
  const gateDrop = (fx, tag) => {
    const reason = eloContradiction(fx);
    if (reason) console.warn(`⚠️ 常识闸丢弃[${tag}] ${fx.home} vs ${fx.away} ${fx.odds?.home}/${fx.odds?.draw}/${fx.odds?.away}:${reason}(source=${fx.source ?? "?"})`);
    return reason != null;
  };
  let existing = { edition: "2026", fixtures: [] };
  if (existsSync(oddsFile)) { try { existing = JSON.parse(readFileSync(oddsFile, "utf8")); } catch {} }
  const merged = new Map();
  for (const fx of existing.fixtures ?? []) {
    if (pickEuropeanOdds({ current: fx.odds }) && !gateDrop(fx, "存量")) merged.set(keyOf(fx.home, fx.away), fx);
  }
  for (const [key, fx] of byPair) {
    if (gateDrop(fx, "新扫")) continue;
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
