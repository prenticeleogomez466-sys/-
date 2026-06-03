#!/usr/bin/env node
/**
 * 国际赛大样本 Elo 回测 — 吸收 martj42 全量国际赛结果(1872-2026,~49k 场)做 leak-safe 验证。
 * 资源来源:https://github.com/martj42/international_results (Public Domain CSV)。
 *
 * 目的:在远超现有 732 场世界杯的【真实国际赛大样本】上,验证两件事:
 *   (A) 本模型 eloExpectation 公式在国际赛的真实命中率/校准(基线对照)。
 *   (B) 调研吸收的 World Football Elo (eloratings.net) 三项 refinement 是否真带净增益:
 *        ① 赛事 K 档位(世界杯60/洲际决赛50/预选+洲联赛40/其它30/友谊20)
 *        ② 净胜球指数(GD2 ×1.5;GD≥3 ×(11+GD)/8)
 *        ③ 主场 +100 Elo(中立场 0,数据自带 neutral 标记)
 *   对照 = 朴素 walk-forward(平 K=40、无净胜球、无主场)。
 *
 * leak-safe:walk-forward,每场先预测再用真实结果更新;评估只取近窗口(收敛后)。
 * 只读 CSV,不改任何生产数据/代码。过了才建议把 refinement 接进国际赛 Elo 更新逻辑。
 *
 * 用法: node scripts/run-intl-elo-backtest.mjs
 */
import { readFileSync } from "node:fs";
import { eloExpectation } from "../src/world-cup-priors.js";

// ── 极简 CSV 解析(处理引号内逗号)──
function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur); rows.push(cells);
  }
  return rows;
}

// ── 赛事 K 档(World Football Elo)──
function kFor(t) {
  const s = (t || "").toLowerCase();
  if (s.includes("world cup") && !s.includes("qualif")) return 60;
  if (/(copa am|euro|african cup of nations|asian cup|gold cup|confederations)/.test(s) && !s.includes("qualif")) return 50;
  if (s.includes("qualif") || s.includes("nations league")) return 40;
  if (s.includes("friendly")) return 20;
  return 30;
}
// 净胜球指数
function gdIndex(gd) {
  const a = Math.abs(gd);
  if (a <= 1) return 1;
  if (a === 2) return 1.5;
  return (11 + a) / 8;
}

const EPS = 1e-9;
const ll = (p) => -Math.log(Math.max(p, EPS));
const brier = (probs, actual) => ["home", "draw", "away"].reduce((s, k) => s + (probs[k] - (k === actual ? 1 : 0)) ** 2, 0);
const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");

function run() {
  const rows = parseCSV(readFileSync("data/intl-results/results.csv", "utf8"));
  const hdr = rows[0];
  const ix = (n) => hdr.indexOf(n);
  const [iD, iH, iA, iHS, iAS, iT, iN] = ["date", "home_team", "away_team", "home_score", "away_score", "tournament", "neutral"].map(ix);
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const hs = Number(r[iHS]), as = Number(r[iAS]);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    data.push({ date: r[iD], home: r[iH], away: r[iA], hs, as, t: r[iT], neutral: r[iN] === "TRUE" });
  }
  data.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 两套独立 Elo 表
  const A = {}, B = {};
  const get = (tbl, t) => (tbl[t] ?? 1500);
  // 评估窗口:近 15 年(收敛后、与当代相关)
  const EVAL_FROM = "2011-01-01";
  const stat = (label) => ({ label, n: 0, hit: 0, ll: 0, br: 0 });
  const sA = stat("朴素 平K=40 无GD无主场"), sB = stat("World Football Elo 全套"), sBase = stat("历史边际频率基线");
  const hist = { home: 0, draw: 0, away: 0 };

  for (const m of data) {
    const actual = oc(m.hs, m.as);
    // A:朴素,中立场不分主客优势
    const expA = eloExpectation(get(A, m.home), get(A, m.away), 0);
    // B:WFE,主场 +100(非中立)
    const haB = m.neutral ? 0 : 100;
    const expB = eloExpectation(get(B, m.home), get(B, m.away), haB);

    if (m.date >= EVAL_FROM) {
      const tot = hist.home + hist.draw + hist.away || 1;
      const base = { home: hist.home / tot, draw: hist.draw / tot, away: hist.away / tot };
      const top = (e) => ["home", "draw", "away"].sort((x, y) => e[y] - e[x])[0];
      for (const [s, e] of [[sA, expA], [sB, expB], [sBase, base]]) {
        s.n++; if (top(e) === actual) s.hit++; s.ll += ll(e[actual]); s.br += brier(e, actual);
      }
    }
    hist[actual]++;

    // ── 更新 A:平 K=40,期望含 we(中立)──
    {
      const eh = get(A, m.home), ea = get(A, m.away);
      const we = 1 / (1 + 10 ** ((ea - eh) / 400));
      const sc = m.hs > m.as ? 1 : m.hs === m.as ? 0.5 : 0;
      A[m.home] = eh + 40 * (sc - we);
      A[m.away] = ea + 40 * ((1 - sc) - (1 - we));
    }
    // ── 更新 B:WFE K档 × 净胜球指数,主场+100 计入期望 ──
    {
      const eh = get(B, m.home) + (m.neutral ? 0 : 100), ea = get(B, m.away);
      const we = 1 / (1 + 10 ** ((ea - eh) / 400));
      const sc = m.hs > m.as ? 1 : m.hs === m.as ? 0.5 : 0;
      const k = kFor(m.t) * gdIndex(m.hs - m.as);
      B[m.home] = get(B, m.home) + k * (sc - we);
      B[m.away] = get(B, m.away) + k * ((1 - sc) - (1 - we));
    }
  }

  const fmt = (s) => `n=${s.n}  命中 ${(s.hit / s.n * 100).toFixed(1)}%  logloss ${(s.ll / s.n).toFixed(4)}  Brier ${(s.br / s.n).toFixed(4)}`;
  console.log("══════ 国际赛大样本 Elo 回测(martj42 49k 场,评估窗口 2011→2026)══════\n");
  console.log(`  ${sBase.label.padEnd(26)} ${fmt(sBase)}`);
  console.log(`  ${sA.label.padEnd(26)} ${fmt(sA)}`);
  console.log(`  ${sB.label.padEnd(26)} ${fmt(sB)}`);
  const dHit = (sB.hit / sB.n - sA.hit / sA.n) * 100;
  const dLL = sB.ll / sB.n - sA.ll / sA.n;
  console.log(`\n  WFE 相对朴素: 命中 ${dHit >= 0 ? "+" : ""}${dHit.toFixed(1)}pp | logloss ${dLL >= 0 ? "+" : ""}${dLL.toFixed(4)}`);
  console.log(`  裁决:${dLL < -0.003 ? "✅ WFE refinement(K档+净胜球+主场)真带净增益,建议接进国际赛 Elo 更新逻辑" : dLL > 0.003 ? "❌ WFE 反而更差,维持现状" : "⚖️ 净增益在噪声内,WFE 不显著优于朴素;现产 Elo 用 eloratings.net(已含这套)足够,自训练侧不必改"}`);
  console.log(`\n  注:现产 team-priors 的 Elo 直接取 eloratings.net(已内置 WFE 全套),本回测验证的是"这套方法在 49k 真实国际赛上的价值",非要替换生产评级。`);
  console.log(`  诚实:国际赛命中天花板 ~50-55%(爆冷常态),两套都受此限;refinement 价值在校准/收敛速度而非破天花板。`);
}
run();
