#!/usr/bin/env node
/**
 * 状态空间动态评级回测:在线"先预测后更新"自带 leak-safe。
 * 对比对象:开盘均赔、收盘均赔(诚实标尺)。指标:命中率/Brier(1X2 多类)/RPS/LogLoss。
 * 只评估 warmed 场(两队都见过且联赛≥20场),避免冷启动噪声。
 * 用法:node scripts/run-state-space-backtest.mjs [--leagues E0,SP1,D1,I1,F1] [--lr 0.06] [--test-seasons 2425,2526]
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { runStateSpaceRatings } from "../src/state-space-ratings.js";

const args = process.argv.slice(2);
const getStr = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LEAGUES = getStr("--leagues", "E0,SP1,D1,I1,F1").split(",");
const LR = Number(getStr("--lr", "0.06"));
const DECAY = Number(getStr("--decay", "0.0008"));
const TEST_SEASONS = new Set(getStr("--test-seasons", "2425,2526").split(","));
const SEASONS = ["2526", "2425", "2324", "2223", "2122"];

function seasonOf(date) {
  const [y, m] = date.split("-").map(Number);
  const s = m >= 7 ? y : y - 1;
  return String(s % 100).padStart(2, "0") + String((s + 1) % 100).padStart(2, "0");
}
const OUT = ["home", "draw", "away"];
function resultOf(m) { return m.home > m.away ? "home" : m.home === m.away ? "draw" : "away"; }
function brier(p, y) { return OUT.reduce((s, o) => s + (p[o] - (o === y ? 1 : 0)) ** 2, 0); }
function rps(p, y) {
  // 有序 RPS(home<draw<away 视为序);用累积分布差
  const order = ["home", "draw", "away"];
  const yi = order.indexOf(y);
  let cumP = 0, cumY = 0, s = 0;
  for (let i = 0; i < 3; i++) { cumP += p[order[i]]; cumY += i === yi ? 1 : 0; s += (cumP - cumY) ** 2; }
  return s / 2;
}
function logloss(p, y) { return -Math.log(Math.max(1e-6, p[y])); }

async function main() {
  console.log(`[state-space] 加载 联赛=${LEAGUES.join(",")} lr=${LR} decay=${DECAY}`);
  const res = await loadFootballDataMatches({ leagues: LEAGUES, seasons: SEASONS });
  if (!res.ok) { console.error("无数据"); process.exit(1); }
  const matches = res.matches;
  const { predictions } = runStateSpaceRatings(matches, { lr: LR, decayToMean: DECAY });

  // 对齐:predictions 与 matches 顺序不同(排序过),按 (date,home,away) 建索引取赔率
  const oddsKey = (m) => `${m.date}|${m.home}|${m.away}`;
  const oddsMap = new Map(matches.map((m) => [oddsKey(m), m]));

  const arms = {
    模型动态: { n: 0, hit: 0, brier: 0, rps: 0, ll: 0 },
    开盘均赔: { n: 0, hit: 0, brier: 0, rps: 0, ll: 0 },
    收盘均赔: { n: 0, hit: 0, brier: 0, rps: 0, ll: 0 },
  };
  let evaluated = 0;
  for (const p of predictions) {
    if (!p.warmed) continue;
    if (!TEST_SEASONS.has(seasonOf(p.date))) continue;
    const m = oddsMap.get(`${p.date}|${p.home}|${p.away}`);
    if (!m) continue;
    const y = resultOf({ home: p.actual.home, away: p.actual.away });
    evaluated++;
    accum(arms.模型动态, p.probs, y);
    if (m.odds) accum(arms.开盘均赔, m.odds, y);
    if (m.oddsClose) accum(arms.收盘均赔, m.oddsClose, y);
  }

  console.log(`\n[state-space] 已评估(warmed)=${evaluated}\n`);
  console.log("臂            样本   命中率   Brier(1X2) RPS      LogLoss");
  for (const [name, a] of Object.entries(arms)) {
    if (!a.n) continue;
    console.log(
      `${name.padEnd(12)} ${String(a.n).padEnd(6)} ${((a.hit / a.n) * 100).toFixed(1).padStart(5)}%   ` +
      `${(a.brier / a.n).toFixed(4).padEnd(10)} ${(a.rps / a.n).toFixed(4).padEnd(8)} ${(a.ll / a.n).toFixed(4)}`
    );
  }
  const M = arms.模型动态, O = arms.开盘均赔, C = arms.收盘均赔;
  const dOpenRps = M.rps / M.n - O.rps / O.n;
  const dCloseRps = M.rps / M.n - C.rps / C.n;
  console.log(`\n模型 vs 开盘 RPS差 ${(dOpenRps).toFixed(4)}(负=模型更准) | 模型 vs 收盘 RPS差 ${(dCloseRps).toFixed(4)}`);
  console.log(dOpenRps < -0.0005
    ? "✅ 状态空间模型在 RPS 上优于开盘线(有独立判别力)"
    : "❌ 未优于开盘线(与公开数据先验一致,暂不接入主路径)");
}
function accum(a, p, y) {
  a.n++;
  a.hit += (OUT.reduce((b, o) => (p[o] > p[b] ? o : b), "home") === y) ? 1 : 0;
  a.brier += brier(p, y);
  a.rps += rps(p, y);
  a.ll += logloss(p, y);
}
main().catch((e) => { console.error(e); process.exit(1); });
