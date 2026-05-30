// 历史同联赛类比推荐报告 CLI
// 用法: node scripts/analog-report.mjs --date=2025-05-25 --leagues=E0,SP1,D1,I1,F1 --pool=2223,2324
//
// 对目标比赛日的每场(覆盖联赛、带欧赔),在历史池(其他赛季同联赛)里检索
// 相近水位+赔率变化的类比样本,聚合出以胜负平为锚的 WLD / 半全场 / 比分推荐,
// 写出真 .xlsx(桌面 + D:\football-model-exports)。
//
// 诚实声明:WLD/半全场/比分均来自真实历史类比聚合,非硬编码;若目标日已有真实
// 赛果则附命中对照。北欧/日职等 football-data /new/ 源无半场比分,半全场会标"无半场史"。

import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { analyzeHistoricalAnalogs } from "../src/historical-analog-engine.js";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const DATE = args.date || "2025-05-25";
const LEAGUES = (args.leagues || "E0,SP1,D1,I1,F1").split(",");
const POOL = (args.pool || "2223,2324").split(",");
const K = Number(args.k || 60);

const LEAGUE_CN = { E0: "英超", SP1: "西甲", D1: "德甲", I1: "意甲", F1: "法甲" };
const WLD_CN = { home: "主胜", draw: "平局", away: "客胜" };

function impliedToDir(g) { return g.homeGoals > g.awayGoals ? "home" : g.homeGoals === g.awayGoals ? "draw" : "away"; }

async function main() {
  console.log(`[类比报告] 目标日=${DATE} 联赛=${LEAGUES.join("/")} 历史池=${POOL.join("+")} K=${K}`);
  const pool = await loadFootballDataMatches({ leagues: LEAGUES, seasons: POOL });
  // 目标:用包含目标日的赛季加载,仅取该日;历史池排除该赛季以防泄漏
  const targetSeason = args.targetSeason || "2425";
  const tgtAll = await loadFootballDataMatches({ leagues: LEAGUES, seasons: [targetSeason] });
  const targets = tgtAll.matches.filter((m) => m.date === DATE && m.odds);
  console.log(`历史池 ${pool.matches.length} 场,目标 ${targets.length} 场`);
  if (targets.length === 0) { console.log("目标日无覆盖联赛比赛,退出"); return; }

  const header = ["联赛", "主队", "客队", "锚·胜平负", "主%", "平%", "客%",
    "半全场", "比分", "置信度", "类比样本", "平均距离", "实际", "WLD命中"];
  const rows = [header];
  let hit = 0, scored = 0;
  for (const t of targets) {
    const r = analyzeHistoricalAnalogs(
      { league: t.league, opening: t.odds, closing: t.oddsClose || null }, pool.matches, { k: K });
    if (!r.ok) { rows.push([LEAGUE_CN[t.league] || t.league, t.home, t.away, "无同联赛历史", "", "", "", "", "", "", "", "", "", ""]); continue; }
    const actual = impliedToDir(t);
    const ok = r.wld === actual; if (ok) hit++; scored++;
    rows.push([
      LEAGUE_CN[t.league] || t.league, t.home, t.away,
      WLD_CN[r.wld] + (r.lowConfidence ? "(低置信)" : ""),
      (r.probabilities.home * 100).toFixed(0), (r.probabilities.draw * 100).toFixed(0), (r.probabilities.away * 100).toFixed(0),
      r.halfFull ? `${r.halfFull.label} ${(r.halfFull.probability * 100).toFixed(0)}%` : "无半场史",
      r.score ? `${r.score.label} ${(r.score.probability * 100).toFixed(0)}%` : "—",
      (r.confidence * 100).toFixed(0) + "%",
      String(r.analogCount), r.avgDistance.toFixed(3),
      WLD_CN[actual] + ` (${t.homeGoals}-${t.awayGoals})`, ok ? "✓" : "✗"
    ]);
  }
  rows.push([]);
  rows.push([`本批 ${scored} 场 WLD 命中 ${hit} (${(100 * hit / scored).toFixed(1)}%) · 以胜负平为锚 · 类比聚合真实历史 · ⚡Claude 独立大模型`]);

  const sheets = [{ name: `类比推荐${DATE}`, rows }];
  const stamp = DATE;
  const out1 = join(process.env.USERPROFILE || "C:/Users/Administrator", "Desktop", `历史类比推荐_${stamp}.xlsx`);
  const out2 = join("D:/football-model-exports", `历史类比推荐_${stamp}.xlsx`);
  writeXlsxWorkbook(out1, sheets);
  writeXlsxWorkbook(out2, sheets);
  console.log(`WLD 命中 ${hit}/${scored} = ${(100 * hit / scored).toFixed(1)}%`);
  console.log("已写:", out1);
  console.log("已写:", out2);
}

main().catch((e) => { console.error("FAIL", e.message, e.stack); process.exit(1); });
