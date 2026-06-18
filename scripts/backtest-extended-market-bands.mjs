#!/usr/bin/env node
/**
 * 扩展玩法·历史合理区间(真实赛果频次)生成器(2026-06-18 用户:让球胜负平/主客进球数大小/半场胜负平/
 *   半场进球数 也要合理区间+异动统计)。
 *
 * 全部=football-data.co.uk 7季五大联赛真实赛果频次(✅真实赛果,零编造)。每维度按"强度档"(亚盘让球线
 *   深度,热门视角)分箱,给历史正常分布;本场 live 实测/🔶矩阵派生值落该档区间外=异动。
 *
 *   ① 让球胜负平:按竞彩整数让球线(主队视角 H,负=主让)→ 让球主胜/平/负真实频次。
 *   ② 半场胜负平:按亚盘线深度档(热门视角)→ 半场 热门胜/平/负 真实频次(HTHG/HTAG)。
 *   ③ 主/客队进球数大小:按强度档 → 热门方/非热门方 进球 over0.5/1.5/2.5 真实频次。
 *   ④ 半场进球数:按强度档 → 半场总进球 over0.5/1.5 真实频次。
 *
 * 输出 JSON(嵌入 src/extended-market-bands.js)+ 控制台对照。刷新:重跑本脚本。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { writeFileSync } from "node:fs";

const SEASONS = ["2526", "2425", "2324", "2223", "2122", "2021", "1920"];
const loaded = await loadFootballDataMatches({ seasons: SEASONS });
const M = loaded.matches.filter((m) =>
  m.asian && Number.isFinite(Number(m.asian.lineClose ?? m.asian.line)) &&
  Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals));
console.log(`样本:${M.length}场(${SEASONS.length}季×5联赛·带亚盘线+真实赛果)`);

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null); // 一位小数百分比
const depthKey = (d) => {
  // 强度档(热门视角让球线深度):粗分箱保证样本厚度
  if (d < 0.25) return "0";          // 平手/近平手
  if (d < 0.625) return "0.5";       // 半球
  if (d < 1.125) return "1";         // 一球
  if (d < 1.625) return "1.5";       // 球半
  return "2+";                        // 两球及以上
};

// ── 每场:热门视角(favorite=收盘隐含高的一方)──
const recs = M.map((m) => {
  const line = Number(m.asian.lineClose ?? m.asian.line);
  const oc = m.oddsClose || m.odds;
  const favHome = oc ? oc.home >= oc.away : line <= 0;
  const gd = m.homeGoals - m.awayGoals;             // 主-客 净胜
  const favGd = favHome ? gd : -gd;                 // 热门视角净胜
  const favG = favHome ? m.homeGoals : m.awayGoals; // 热门进球
  const dogG = favHome ? m.awayGoals : m.homeGoals; // 非热门进球
  const htH = m.halfHome, htA = m.halfAway;
  const htOk = Number.isFinite(htH) && Number.isFinite(htA);
  const htGd = htOk ? htH - htA : null;
  const favHtGd = htOk ? (favHome ? htGd : -htGd) : null;
  const htTotal = htOk ? htH + htA : null;
  // 竞彩整数让球线(主队视角):四舍五入到整数,负=主让
  const Hline = Math.sign(line) * Math.round(Math.abs(line));
  return { line, depth: Math.abs(line), favHome, gd, favGd, favG, dogG, htOk, favHtGd, htTotal, Hline };
});

// ── ① 让球胜负平(竞彩整数让球线·主队视角)──
const hcpBy = {};
for (const r of recs) {
  const k = r.Hline;
  (hcpBy[k] ??= { homeWin: 0, draw: 0, awayWin: 0, n: 0 });
  const adj = r.gd + k;                  // 主让k(k<0): 让球主胜 iff adj>0
  if (adj > 0) hcpBy[k].homeWin++;
  else if (adj === 0) hcpBy[k].draw++;
  else hcpBy[k].awayWin++;
  hcpBy[k].n++;
}
const HANDICAP_RESULT = {};
for (const k of Object.keys(hcpBy).map(Number).sort((a, b) => a - b)) {
  const b = hcpBy[k];
  if (b.n < 30) continue;
  HANDICAP_RESULT[k] = { homeWin: pct(b.homeWin, b.n), draw: pct(b.draw, b.n), awayWin: pct(b.awayWin, b.n), n: b.n };
}

// ── ②③④ 按强度档(热门视角)──
const byDepth = {};
for (const r of recs) {
  const k = depthKey(r.depth);
  const b = (byDepth[k] ??= { n: 0, htN: 0,
    htFavWin: 0, htDraw: 0, htFavLoss: 0,
    favO05: 0, favO15: 0, favO25: 0, dogO05: 0, dogO15: 0,
    htO05: 0, htO15: 0 });
  b.n++;
  if (r.favG >= 1) b.favO05++; if (r.favG >= 2) b.favO15++; if (r.favG >= 3) b.favO25++;
  if (r.dogG >= 1) b.dogO05++; if (r.dogG >= 2) b.dogO15++;
  if (r.htOk) {
    b.htN++;
    if (r.favHtGd > 0) b.htFavWin++; else if (r.favHtGd === 0) b.htDraw++; else b.htFavLoss++;
    if (r.htTotal >= 1) b.htO05++; if (r.htTotal >= 2) b.htO15++;
  }
}
const HT_RESULT = {}, TEAM_GOALS = {}, HT_GOALS = {};
const ORDER = ["0", "0.5", "1", "1.5", "2+"];
for (const k of ORDER) {
  const b = byDepth[k];
  if (!b || b.n < 30) continue;
  HT_RESULT[k] = { favWin: pct(b.htFavWin, b.htN), draw: pct(b.htDraw, b.htN), favLoss: pct(b.htFavLoss, b.htN), n: b.htN };
  TEAM_GOALS[k] = {
    favOver05: pct(b.favO05, b.n), favOver15: pct(b.favO15, b.n), favOver25: pct(b.favO25, b.n),
    dogOver05: pct(b.dogO05, b.n), dogOver15: pct(b.dogO15, b.n), n: b.n,
  };
  HT_GOALS[k] = { over05: pct(b.htO05, b.htN), over15: pct(b.htO15, b.htN), n: b.htN };
}

// ── 控制台对照 ──
console.log("\n① 让球胜负平(竞彩整数让球线·主队视角·真实赛果频次):");
for (const k of Object.keys(HANDICAP_RESULT).map(Number).sort((a, b) => a - b)) {
  const v = HANDICAP_RESULT[k];
  console.log(`  ${k === 0 ? "平手 " : k < 0 ? "主让" + (-k) : "主受让" + k}　让球主胜${v.homeWin}% / 平${v.draw}% / 客${v.awayWin}%　(N=${v.n})`);
}
console.log("\n② 半场胜负平(强度档·热门视角):");
for (const k of ORDER) if (HT_RESULT[k]) console.log(`  档${k}　半场 热门胜${HT_RESULT[k].favWin}% / 平${HT_RESULT[k].draw}% / 负${HT_RESULT[k].favLoss}%　(N=${HT_RESULT[k].n})`);
console.log("\n③ 主/客(热门/非热门)进球数大小(强度档):");
for (const k of ORDER) if (TEAM_GOALS[k]) { const v = TEAM_GOALS[k]; console.log(`  档${k}　热门进球≥1:${v.favOver05}% ≥2:${v.favOver15}% ≥3:${v.favOver25}%｜非热门≥1:${v.dogOver05}% ≥2:${v.dogOver15}%　(N=${v.n})`); }
console.log("\n④ 半场进球数(强度档):");
for (const k of ORDER) if (HT_GOALS[k]) console.log(`  档${k}　半场≥1球:${HT_GOALS[k].over05}% ≥2球:${HT_GOALS[k].over15}%　(N=${HT_GOALS[k].n})`);

const out = { generatedAt: "2026-06-18", source: `footballdata ${M.length}场五大联赛7季真实赛果`, HANDICAP_RESULT, HT_RESULT, TEAM_GOALS, HT_GOALS };
writeFileSync("D:/football-model-data/extended-market-bands.json", JSON.stringify(out, null, 1));
console.log("\n✅ JSON: D:\\football-model-data\\extended-market-bands.json(嵌入 src/extended-market-bands.js)");
