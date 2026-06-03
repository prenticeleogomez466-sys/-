#!/usr/bin/env node
/**
 * 淘汰赛平局软重校准 — leak-safe 净增益检验(待办#2)。
 *
 * 背景:库内描述统计显示淘汰赛 90' 平局率 > 小组赛(+7.6~12.9pp,随样本变)。
 *   但"淘汰赛队伍更势均力敌"本身就会让 Elo 自动给出更高平局概率。
 *   真问题:在【Elo 已解释的均势之外】,淘汰赛还有没有【残余】平局偏高?
 *   只有残余存在,加 drawTendency 软重校准才有意义,否则就是重复计 Elo 已有信息。
 *
 * 方法(leak-safe,零泄漏):
 *   - 从历届世界杯赛果【自训练】Elo(walk-forward,只用过去),完全不碰 2026 team-priors。
 *   - 复用生产 eloExpectation 出 wld。按 group / knockout 分段:
 *       比较【Elo 预测平均平局概率】vs【实际平局率】→ 残余 = 实际 - 预测。
 *   - 若淘汰赛残余 >> 0 且小组赛残余 ≈ 0 → 残余真实,校准 boost 有据。
 *   - 然后【直接测净增益】:对淘汰赛预测施加平局 boost(把残余补回,概率重归一),
 *     对比 boost 前后 log-loss / Brier(只在淘汰赛段,leak-safe),过了才建议接。
 *
 * 用法: node scripts/run-worldcup-knockout-draw-check.mjs   (只读,不改任何数据/代码)
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { eloExpectation } from "../src/world-cup-priors.js";

const KO = new Set(["r16", "qf", "sf", "final", "knockout", "third", "round_of_16", "quarter", "semi"]);
const stageClass = (s) => (KO.has(String(s).toLowerCase()) ? "knockout" : "group");

function collect() {
  const rows = [];
  for (const date of listFixtureDates()) {
    const doc = loadFixtures(date);
    if (doc.source !== "worldcup-history") continue;
    for (const f of doc.fixtures) {
      const r = f.result || {};
      const h = Number(r.home), a = Number(r.away);
      if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
      if (!f.homeTeam || !f.awayTeam) continue;
      rows.push({ date: f.date || "", home: f.homeTeam, away: f.awayTeam, hg: h, ag: a, seg: stageClass(f.round) });
    }
  }
  return rows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

const K = 40, BURNIN = 128;
const EPS = 1e-9;
const ll = (p) => -Math.log(Math.max(p, EPS));
const brier = (probs, actual) => ["home", "draw", "away"].reduce((s, k) => s + (probs[k] - (k === actual ? 1 : 0)) ** 2, 0);

function main() {
  const rows = collect();
  if (rows.length < 200) { console.log(`世界杯样本 ${rows.length} 场,不足`); return; }

  const elo = {};
  const getElo = (t) => (elo[t] ?? 1500);
  const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");

  // 第一遍:walk-forward 估每段残余(实际平局率 - Elo 预测平局率)
  const seg = { group: { n: 0, predDraw: 0, obsDraw: 0 }, knockout: { n: 0, predDraw: 0, obsDraw: 0 } };
  // 暂存每场预测,供第二遍 boost 测试(用第一遍估出的残余,仍 leak-safe:残余是全样本聚合的弱先验,
  // 严格起见第二遍用"截止当前"动态残余,见下)
  const elo2 = {};
  const getElo2 = (t) => (elo2[t] ?? 1500);

  // 动态残余累计器(只用过去 → leak-safe)
  const dyn = { group: { nd: 0, draws: 0, predSum: 0 }, knockout: { nd: 0, draws: 0, predSum: 0 } };
  let baseLLko = 0, boostLLko = 0, baseBrko = 0, boostBrko = 0, nko = 0;
  let baseLLall = 0, boostLLall = 0, n = 0;

  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const exp = eloExpectation(getElo2(m.home), getElo2(m.away), 0); // 中立场
    const actual = oc(m.hg, m.ag);
    const s = m.seg;

    if (i >= BURNIN) {
      // 段聚合(全样本,用于报告残余)
      seg[s].n++; seg[s].predDraw += exp.draw; seg[s].obsDraw += actual === "draw" ? 1 : 0;

      // ── 净增益测试(leak-safe):用【截止当前】该段动态残余构造 boost ──
      const d = dyn[s];
      const resid = d.nd >= 30 ? (d.draws / d.nd) - (d.predSum / d.nd) : 0; // 该段历史(实际-预测)平局缺口
      // boost:把残余补进平局,按比例从主客扣除,重归一
      let bp = { ...exp };
      if (resid > 0) {
        const add = Math.min(resid, 1 - exp.draw - EPS);
        const scale = (exp.home + exp.away) > 0 ? (exp.home + exp.away - add) / (exp.home + exp.away) : 1;
        bp = { home: exp.home * scale, draw: exp.draw + add, away: exp.away * scale };
      }
      // 全段 log-loss
      baseLLall += ll(exp[actual]); boostLLall += ll(bp[actual]); n++;
      if (s === "knockout") {
        baseLLko += ll(exp[actual]); boostLLko += ll(bp[actual]);
        baseBrko += brier(exp, actual); boostBrko += brier(bp, actual); nko++;
      }
      // 更新该段动态残余(放在评估之后 → 不泄漏当前场)
      d.nd++; d.draws += actual === "draw" ? 1 : 0; d.predSum += exp.draw;
    }

    // walk-forward 更新两套 Elo(同公式)
    for (const [tbl, gh] of [[elo, getElo], [elo2, getElo2]]) {
      const eh = gh(m.home), ea = gh(m.away);
      const we = 1 / (1 + 10 ** ((ea - eh) / 400));
      const sc = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
      tbl[m.home] = eh + K * (sc - we);
      tbl[m.away] = ea + K * ((1 - sc) - (1 - we));
    }
  }

  const pct = (x) => (x * 100).toFixed(1);
  console.log("══════ 淘汰赛平局软重校准 · leak-safe 检验 ══════\n");
  console.log("【残余诊断:Elo 已解释均势之外,实际平局是否仍偏高】");
  for (const s of ["group", "knockout"]) {
    const g = seg[s];
    const pred = g.predDraw / g.n, obs = g.obsDraw / g.n;
    console.log(`  ${s.padEnd(8)} n=${String(g.n).padStart(3)}  Elo预测平局 ${pct(pred)}%  实际平局 ${pct(obs)}%  残余 ${(obs - pred >= 0 ? "+" : "") + pct(obs - pred)}pp`);
  }
  const gResid = seg.group.obsDraw / seg.group.n - seg.group.predDraw / seg.group.n;
  const kResid = seg.knockout.obsDraw / seg.knockout.n - seg.knockout.predDraw / seg.knockout.n;
  console.log(`  → 淘汰赛残余(${pct(kResid)}pp) − 小组赛残余(${pct(gResid)}pp) = ${pct(kResid - gResid)}pp ${kResid - gResid > 0.03 ? "(淘汰赛确有残余平局偏高)" : "(差异小,多半被 Elo 均势吸收)"}`);

  console.log("\n【净增益:淘汰赛段加动态平局 boost 前后(leak-safe,截止当前残余)】");
  if (nko > 0) {
    console.log(`  淘汰赛 n=${nko}`);
    console.log(`  log-loss : ${(baseLLko / nko).toFixed(4)} → ${(boostLLko / nko).toFixed(4)}  (${((boostLLko - baseLLko) / nko >= 0 ? "+" : "") + ((boostLLko - baseLLko) / nko).toFixed(4)})`);
    console.log(`  Brier    : ${(baseBrko / nko).toFixed(4)} → ${(boostBrko / nko).toFixed(4)}  (${((boostBrko - baseBrko) / nko >= 0 ? "+" : "") + ((boostBrko - baseBrko) / nko).toFixed(4)})`);
    const gain = (baseLLko - boostLLko) / nko;
    console.log(`\n裁决:${gain > 0.002 ? "✅ boost 降 log-loss " + gain.toFixed(4) + "/场,残余真实可接(建议加淘汰赛 drawTendency)" : gain < -0.002 ? "❌ boost 反升 log-loss,残余是噪声,维持不接" : "⚖️ 净增益在噪声内(|Δ|<0.002),按诚实原则维持不接,不为'显得优化'乱改"}`);
  }
  console.log("\n诚实:本检验用自训练 Elo 历史赛果,零泄漏;残余=Elo 未捕捉的纯阶段效应。国际赛 wld 上限不因此变。");
}
main();
