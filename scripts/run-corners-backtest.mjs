#!/usr/bin/env node
/**
 * 角球泊松 walk-forward 回测(leak-safe)。
 * 对每场测试比赛:只用 kickoff 之前的比赛拟合角球攻防 → 预测大/小角球各档 → 对比实际总角球。
 * 基线 = 训练集该档的经验过盘率(常数预测)。模型若有判别力,Brier 应低于基线(skill>0)。
 *
 * 用法:node scripts/run-corners-backtest.mjs [--leagues E0,SP1,D1,I1,F1] [--test-seasons 2425,2526] [--lines 8.5,9.5,10.5,11.5]
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitCornerRatings, overUnderCorners } from "../src/corners-poisson.js";

const args = process.argv.slice(2);
const getStr = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LEAGUES = getStr("--leagues", "E0,SP1,D1,I1,F1").split(",");
const TEST_SEASONS = new Set(getStr("--test-seasons", "2425,2526").split(","));
const LINES = getStr("--lines", "8.5,9.5,10.5,11.5").split(",").map(Number);
const XI = Number(getStr("--xi", "0.0019"));
const SHRINK = Number(getStr("--shrink", "6"));
const SEASONS = ["2526", "2425", "2324", "2223", "2122"];

// 把 ISO 日期映射回赛季桶(用于划分 train/test)。football-data 赛季 7 月→次年 6 月。
function seasonOf(date) {
  const [y, m] = date.split("-").map(Number);
  const startYear = m >= 7 ? y : y - 1;
  const yy = String(startYear % 100).padStart(2, "0");
  const ny = String((startYear + 1) % 100).padStart(2, "0");
  return yy + ny;
}

async function main() {
  console.log(`[corners-backtest] 加载 football-data.co.uk:联赛=${LEAGUES.join(",")} 赛季=${SEASONS.join(",")}`);
  const res = await loadFootballDataMatches({ leagues: LEAGUES, seasons: SEASONS });
  if (!res.ok) { console.error("加载失败/无数据"); process.exit(1); }
  const withCorners = res.matches.filter((m) => m.corners);
  console.log(`[corners-backtest] 总场次=${res.matches.length} 含角球=${withCorners.length}`);
  if (withCorners.length < 200) { console.error("含角球样本过少,放弃"); process.exit(1); }

  // 测试集 = 落在 TEST_SEASONS 的比赛;训练用全部更早比赛(asOf)
  const test = withCorners
    .filter((m) => TEST_SEASONS.has(seasonOf(m.date)))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`[corners-backtest] 测试场次=${test.length}`);

  // 按日期分组,逐日期 refit(leak-safe + 提速)
  const byDate = new Map();
  for (const m of test) (byDate.get(m.date) ?? byDate.set(m.date, []).get(m.date)).push(m);
  const dates = [...byDate.keys()].sort();

  // 累计指标
  const lineStats = new Map(LINES.map((l) => [l, { n: 0, brier: 0, baseBrier: 0, acc: 0, baseAcc: 0, ll: 0, baseLl: 0 }]));
  // 训练集经验过盘率(常数基线)随训练窗滚动估计
  let evaluated = 0, skippedNoRating = 0;

  for (const date of dates) {
    const model = fitCornerRatings(withCorners, { asOf: date, xi: XI, shrink: SHRINK });
    if (!model.usable) { skippedNoRating += byDate.get(date).length; continue; }
    // 基线过盘率:用训练窗(date 之前)同联赛经验频率
    const trainPrior = withCorners.filter((m) => m.date < date);
    const baseOverByLeagueLine = computeBaseOver(trainPrior, LINES);

    for (const m of byDate.get(date)) {
      const pred = model.predict(m.home, m.away, m.league, { ouLines: LINES, hcLines: [] });
      if (!pred) { skippedNoRating++; continue; }
      const actualTotal = m.corners.home + m.corners.away;
      evaluated++;
      for (const line of LINES) {
        const y = actualTotal > line ? 1 : 0;
        const pModel = pred.overUnder[line].over;
        const pBase = baseOverByLeagueLine[`${m.league}|${line}`] ?? baseOverByLeagueLine[`*|${line}`] ?? 0.5;
        const s = lineStats.get(line);
        s.n++;
        s.brier += (pModel - y) ** 2;
        s.baseBrier += (pBase - y) ** 2;
        s.acc += (pModel >= 0.5 ? 1 : 0) === y ? 1 : 0;
        s.baseAcc += (pBase >= 0.5 ? 1 : 0) === y ? 1 : 0;
        s.ll += -Math.log(clampp(y ? pModel : 1 - pModel));
        s.baseLl += -Math.log(clampp(y ? pBase : 1 - pBase));
      }
    }
  }

  console.log(`\n[corners-backtest] 已评估=${evaluated} 跳过(无评级)=${skippedNoRating}\n`);
  console.log("线档  样本  模型Brier  基线Brier  BrierSkill  模型准确  基线准确  模型LogLoss 基线LogLoss");
  let anySkill = false;
  for (const line of LINES) {
    const s = lineStats.get(line);
    if (!s.n) continue;
    const mb = s.brier / s.n, bb = s.baseBrier / s.n;
    const skill = 1 - mb / bb;
    if (skill > 0.002) anySkill = true;
    console.log(
      `${String(line).padEnd(5)} ${String(s.n).padEnd(5)} ${mb.toFixed(4).padEnd(10)} ${bb.toFixed(4).padEnd(10)} ` +
      `${(skill * 100).toFixed(2).padStart(6)}%   ${((s.acc / s.n) * 100).toFixed(1).padStart(5)}%   ` +
      `${((s.baseAcc / s.n) * 100).toFixed(1).padStart(5)}%   ${(s.ll / s.n).toFixed(4).padEnd(10)} ${(s.baseLl / s.n).toFixed(4)}`
    );
  }
  console.log(`\n结论:${anySkill ? "✅ 模型对至少一档角球有判别增益(BrierSkill>0)" : "❌ 未超越常数基线,暂不接入"}`);
}

function computeBaseOver(matches, lines) {
  const acc = {};
  for (const m of matches) {
    if (!m.corners) continue;
    const total = m.corners.home + m.corners.away;
    for (const line of lines) {
      for (const key of [`${m.league}|${line}`, `*|${line}`]) {
        const a = (acc[key] ??= { over: 0, n: 0 });
        a.over += total > line ? 1 : 0;
        a.n++;
      }
    }
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) out[k] = a.n ? a.over / a.n : 0.5;
  return out;
}

function clampp(p) { return Math.max(1e-6, Math.min(1 - 1e-6, p)); }

main().catch((e) => { console.error(e); process.exit(1); });
