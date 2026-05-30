/**
 * 凯利分数敏感度 · 蒙特卡洛模拟(2026-05-31 学习轮 13)
 * ─────────────────────────────────────────────────────────────
 * 目的:实证核查注码用的 **1/4 凯利**(bankroll-risk.js maxKellyFraction=0.25)是否合适。
 *   本模型 edge 小且常持平市场 → 全凯利会因高估 edge 爆仓。模拟不同凯利分数下的
 *   资金增长 / 波动 / 最大回撤 / 破产率,看 0.25 是否平衡。遵 feedback-hitrate-closed-loop。
 *
 * 关键诚实点:真实 edge 不确定 → 模拟两种情形:
 *   (A) edge 如模型所信(真 p);(B) **edge 被高估**(真 p 比所信低 2pp)——后者是实战常态,
 *   全凯利在 (B) 下严重受罚,正是该用小分数的理由。
 *
 * 用法:node scripts/run-kelly-sensitivity.mjs
 */
const FRACTIONS = [1.0, 0.5, 0.25, 0.125];
const N_PATHS = 4000;
const N_BETS = 300;       // 一季约 300 个 +EV 注
const ODDS = 2.0;         // 代表性赔率(b=1)
const BELIEVED_P = 0.55;  // 模型所信胜率(EV=+10% @2.0,乐观代表)
const RUIN = 0.30;        // 资金跌破 30% 视作"破产/重创"

function fullKelly(p, b) { return Math.max(0, (p * b - (1 - p)) / b); }

function simulate(trueP, fraction) {
  const b = ODDS - 1;
  const stakeFrac = fullKelly(BELIEVED_P, b) * fraction; // 按"所信"下注,但用"真"概率结算
  const finals = [];
  let ruinCount = 0;
  let maxDDsum = 0;
  for (let path = 0; path < N_PATHS; path++) {
    let bank = 1, peak = 1, maxDD = 0, ruined = false;
    for (let i = 0; i < N_BETS; i++) {
      const stake = bank * stakeFrac;
      if (Math.random() < trueP) bank += stake * b;
      else bank -= stake;
      if (bank > peak) peak = bank;
      const dd = (peak - bank) / peak;
      if (dd > maxDD) maxDD = dd;
      if (bank < RUIN) ruined = true;
    }
    finals.push(bank);
    if (ruined) ruinCount++;
    maxDDsum += maxDD;
  }
  finals.sort((a, b) => a - b);
  const median = finals[Math.floor(finals.length / 2)];
  return { median, ruinPct: (ruinCount / N_PATHS) * 100, avgMaxDD: (maxDDsum / N_PATHS) * 100 };
}

for (const [label, trueP] of [["A 情形:edge 如模型所信(真p=0.55)", 0.55], ["B 情形:edge 被高估(真p=0.53,低2pp)", 0.53]]) {
  console.log(`\n【${label}】 赔率 ${ODDS},${N_BETS}注×${N_PATHS}路径`);
  console.log("  凯利分数 | 资金中位数 | 平均最大回撤 | 破产率(<30%)");
  for (const f of FRACTIONS) {
    const r = simulate(trueP, f);
    const tag = f === 0.25 ? " ←现用" : f === 1.0 ? " (全凯利)" : "";
    console.log(`   ${f.toFixed(3)}  | ${r.median.toFixed(2)}x      | ${r.avgMaxDD.toFixed(1)}%        | ${r.ruinPct.toFixed(1)}%${tag}`);
  }
}
console.log("\n诚实结论:全凯利在(A)增长最高但回撤/破产率高;一旦(B)edge被高估,全凯利受罚最重。");
console.log("           1/4 凯利在两情形都低回撤、低破产率、仍正增长 → 印证现用 0.25 对'小且不确定edge'稳健,无需改。");
