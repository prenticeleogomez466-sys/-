// 今天竞彩完整推荐(所有维度,对齐标准)+ 存进不被计划任务清的稳定子文件夹。
import { buildDailyRecommendationPackage, simpleWldCell, simpleHandicapCell, simpleScoreCell, simpleHalfFullCell } from "../src/daily-report.js";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

const date = process.argv[2] ?? "2026-06-07";
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const jc = (pkg.recommendations?.predictions ?? []).filter((p) => p.fixture?.marketType === "jingcai");

// 存稳定子文件夹(子目录不被 exports 根清理波及)
const stable = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
mkdirSync(stable, { recursive: true });
if (pkg.dailyPath && existsSync(pkg.dailyPath)) { copyFileSync(pkg.dailyPath, `${stable}/神选-竞彩推荐-${date}.xlsx`); console.log("✅ xlsx 已存稳定位置:", `${stable}/神选-竞彩推荐-${date}.xlsx`); }

const j = (x, n = 100) => { try { return JSON.stringify(x).slice(0, n); } catch { return String(x).slice(0, n); } };
console.log(`\n今天 ${date} 竞彩 ${jc.length} 场 · 完整推荐(全维度)\n`);
for (const p of jc) {
  console.log(`========== ${p.fixture.homeTeam} vs ${p.fixture.awayTeam} ==========`);
  console.log("  胜负平 :", simpleWldCell(p));
  console.log("  让球   :", simpleHandicapCell(p));
  console.log("  比分   :", simpleScoreCell(p));
  console.log("  半全场 :", simpleHalfFullCell(p));
  const ou = p.extendedMarkets?.overUnder ?? p._ouFusion ?? p.extendedMarkets?.totals;
  console.log("  大小球 :", ou ? j(ou, 80) : "未抓到/未参与");
  const dc = p.deepContext;
  console.log("  近5场  :", (dc?.home?.form ?? "未取到") + " / " + (dc?.away?.form ?? "未取到"));
  console.log("  H2H    :", dc?.h2h ?? "无记录");
  console.log("  画像   :", p.teamProfile ? j(p.teamProfile, 110) : "未取到");
  console.log("  情景   :", p.scenario?.narrative ?? (p.scenario ? j(p.scenario, 120) : "无"));
  console.log("  信心   :", p.confidence, "·", p.selectionTier?.label ?? "");
}
