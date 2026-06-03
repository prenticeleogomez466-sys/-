#!/usr/bin/env node
/**
 * 去抽水方法回测 — Shin vs 比例 vs Power,哪个还原的隐含概率最贴近真实结果。
 * 数据:football-data.co.uk 大联赛多季 CSV(AvgH/D/A 市场均赔 + FTR 真实赛果,免费)。
 * leak-safe 天然成立(去vig 是无参数/单场闭式变换,不学习历史→无泄漏)。
 *
 * 评估:对每场用三法把 AvgH/D/A 还原成 {home,draw,away},对真实 FTR 算 log-loss/Brier;
 *   并做 favourite-longshot 偏差校准:按"热门项隐含概率"分桶,比预测 vs 实测胜率。
 * 裁决:Shin 若 log-loss 显著低于比例法 → 接进生产 devig。
 *
 * 数据获取(data/footballdata 已 gitignore,可复现):
 *   for s in 1920 2021 2122 2223 2324 2425 2526; do for lg in E0 D1 I1 SP1 F1; do
 *     curl -s "https://www.football-data.co.uk/mmz4281/$s/$lg.csv" -o data/footballdata/${lg}_$s.csv; done; done
 * 用法: node scripts/run-devig-backtest.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { proportionalDevig, shinDevig, powerDevig } from "../src/market-devig.js";

const DIR = "data/footballdata";
const EPS = 1e-9;
const ll = (p) => -Math.log(Math.max(p, EPS));
const brier = (P, a) => ["home", "draw", "away"].reduce((s, k) => s + (P[k] - (k === a ? 1 : 0)) ** 2, 0);

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const hdr = lines[0].split(",");
  const ix = {};
  ["FTR", "AvgH", "AvgD", "AvgA", "B365H", "B365D", "B365A"].forEach((c) => (ix[c] = hdr.indexOf(c)));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const ftr = c[ix.FTR];
    if (!["H", "D", "A"].includes(ftr)) continue;
    let h = Number(c[ix.AvgH]), d = Number(c[ix.AvgD]), a = Number(c[ix.AvgA]);
    if (!(h > 1 && d > 1 && a > 1)) { h = Number(c[ix.B365H]); d = Number(c[ix.B365D]); a = Number(c[ix.B365A]); }
    if (!(h > 1 && d > 1 && a > 1)) continue;
    out.push({ ftr: ftr === "H" ? "home" : ftr === "D" ? "draw" : "away", odds: { home: h, draw: d, away: a } });
  }
  return out;
}

function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".csv"));
  let rows = [];
  for (const f of files) rows = rows.concat(parseCSV(readFileSync(`${DIR}/${f}`, "utf8")));
  if (rows.length < 1000) { console.log(`样本 ${rows.length} 不足`); return; }

  const methods = {
    "比例 proportional": proportionalDevig,
    "Shin":              shinDevig,
    "Power":             powerDevig,
  };
  const res = {};
  const calib = {}; // favourite-longshot:按热门项概率分桶
  for (const name of Object.keys(methods)) { res[name] = { n: 0, ll: 0, br: 0 }; calib[name] = {}; }

  for (const r of rows) {
    for (const [name, fn] of Object.entries(methods)) {
      const P = fn(r.odds);
      if (!P) continue;
      const s = res[name]; s.n++; s.ll += ll(P[r.ftr]); s.br += brier(P, r.ftr);
      // 热门项 = 概率最高的结果
      const fav = ["home", "draw", "away"].sort((x, y) => P[y] - P[x])[0];
      const bucket = Math.min(9, Math.floor(P[fav] * 10)); // 0.x 桶
      const cb = (calib[name][bucket] ||= { pred: 0, hit: 0, n: 0 });
      cb.pred += P[fav]; cb.hit += r.ftr === fav ? 1 : 0; cb.n++;
    }
  }

  console.log(`══════ 去抽水方法回测(${rows.length} 场,大联赛多季 AvgH/D/A)══════\n`);
  const base = res["比例 proportional"];
  for (const [name, s] of Object.entries(res)) {
    const dLL = (s.ll - base.ll) / s.n;
    console.log(`  ${name.padEnd(20)} n=${s.n}  log-loss ${(s.ll / s.n).toFixed(5)}  Brier ${(s.br / s.n).toFixed(5)}` +
      (name.includes("比例") ? "  (基准)" : `  Δlogloss ${dLL >= 0 ? "+" : ""}${dLL.toFixed(5)}`));
  }

  // favourite-longshot 校准:热门项预测 vs 实测(偏差越小越好)
  console.log("\n【热门项校准(预测胜率 vs 实测,|偏差|越小越准)】");
  for (const name of Object.keys(methods)) {
    let absBias = 0, nb = 0;
    for (const b of Object.keys(calib[name]).sort()) {
      const c = calib[name][b];
      if (c.n < 80) continue;
      absBias += Math.abs(c.pred / c.n - c.hit / c.n) * c.n; nb += c.n;
    }
    console.log(`  ${name.padEnd(20)} 加权平均|偏差| ${(absBias / nb * 100).toFixed(2)}pp`);
  }

  const shin = res["Shin"], pw = res["Power"];
  const gShin = (base.ll - shin.ll) / shin.n, gPow = (base.ll - pw.ll) / pw.n;
  const best = gShin >= gPow ? ["Shin", gShin] : ["Power", gPow];
  console.log(`\n裁决:${best[1] > 0.0005 ? `✅ ${best[0]} 比比例法降 log-loss ${best[1].toFixed(5)}/场,接进生产 devig` : best[1] > 0.0001 ? `⚖️ ${best[0]} 略优(${best[1].toFixed(5)}),边际可接但增益小` : "❌ 无显著优势,维持比例法"}`);
  console.log("诚实:去vig 只改善市场概率的【校准/无偏性】,不预测赛果、不破命中天花板;价值在所有下游用市场概率处(融合/背离门/CLV)更准。");
}
main();
