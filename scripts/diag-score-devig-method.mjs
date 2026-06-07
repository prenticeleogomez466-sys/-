// 诊断:比分盘 de-vig 方法该不该从「比例法」升级到「Power」?
// 关键判据:Power/Shin 去抽水的前提是 Σ(1/o_i) > 1(完整市场有 overround)。
// 比分盘 scoreOdds.top 若只列 top 几个比分,Σ(1/o_top) 可能 < 1 → Power 的 k<1 会反向放大长尾,
//   与它在 1X2(完整市场)上压缩长尾的作用相反 = 引入错误。本脚本用真实历史数据证实/证伪。
// 产出:① 每场 Σ(1/o_top) 与 top 条数;② 比例法 vs 强行Power 对真实比分的 logloss(n小,只看方向,不作统计结论)。
import fs from "fs";

const MARKET_DIR = "D:/football-model-data/market";
const FIX_DIR = "D:/football-model-data/fixtures";

function loadArr(p) {
  try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(j) ? j : (j.fixtures || j.matches || Object.values(j).find((v) => Array.isArray(v)) || []); }
  catch { return []; }
}

// 比例法:在 top 子集内归一(现状)
function proportional(odds) {
  const inv = odds.map((o) => 1 / o);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / s);
}
// 多路 Power:p_i ∝ (1/o_i)^k,解 k 使 Σ=1(k 可 <1 当 Σ(1/o)<1)
function powerArray(odds) {
  const inv = odds.map((o) => 1 / o);
  let lo = 0.05, hi = 8.0;
  const sumAt = (k) => inv.reduce((a, p) => a + p ** k, 0);
  for (let it = 0; it < 100; it++) { const mid = (lo + hi) / 2; if (sumAt(mid) > 1) lo = mid; else hi = mid; }
  const k = (lo + hi) / 2;
  const raw = inv.map((p) => p ** k);
  const s = raw.reduce((a, b) => a + b, 0);
  return { probs: raw.map((p) => p / s), k };
}

// 对齐:market 里有 scoreOdds.top 的记录 → 按 date+队名 找 fixtures result
const fixIndex = {};
for (const f of fs.readdirSync(FIX_DIR).filter((x) => /^2026-\d\d-\d\d\.json$/.test(x))) {
  for (const fx of loadArr(`${FIX_DIR}/${f}`)) {
    if (!fx || !fx.result || !Number.isFinite(fx.result.home)) continue;
    const key = `${(fx.homeTeam || "").trim()}|${(fx.awayTeam || "").trim()}`;
    fixIndex[key] = `${fx.result.home}-${fx.result.away}`;
  }
}

const samples = [];
for (const f of fs.readdirSync(MARKET_DIR).filter((x) => /^2026-\d\d-\d\d\.json$/.test(x))) {
  for (const m of loadArr(`${MARKET_DIR}/${f}`)) {
    const top = m?.scoreOdds?.top;
    if (!Array.isArray(top) || top.length < 2) continue;
    const rows = top.map((r) => ({ score: String(r.score ?? "").replace(":", "-").trim(), o: Number(r.odds) }))
      .filter((r) => /^\d+-\d+$/.test(r.score) && Number.isFinite(r.o) && r.o > 1);
    if (rows.length < 2) continue;
    const key = `${(m.homeTeam || "").trim()}|${(m.awayTeam || "").trim()}`;
    const actual = fixIndex[key];
    if (!actual) continue;
    samples.push({ date: f.replace(".json", ""), key, rows, actual });
  }
}

console.log(`对齐样本: ${samples.length} 场（有 scoreOdds.top + 真实赛果）\n`);

let llProp = 0, llPow = 0, n = 0, hitInTop = 0;
const sumDist = [];
for (const s of samples) {
  const odds = s.rows.map((r) => r.o);
  const invSum = odds.reduce((a, o) => a + 1 / o, 0);
  sumDist.push(invSum);
  const pProp = proportional(odds);
  const { probs: pPow, k } = powerArray(odds);
  const idx = s.rows.findIndex((r) => r.score === s.actual);
  const inTop = idx >= 0;
  if (inTop) hitInTop++;
  // logloss 只对「真实比分在 top 内」的场算(top 外两法都无该比分,不可比)
  if (inTop) {
    llProp += -Math.log(Math.max(pProp[idx], 1e-9));
    llPow += -Math.log(Math.max(pPow[idx], 1e-9));
    n++;
  }
  console.log(`${s.date} ${s.key.padEnd(22)} top=${String(s.rows.length).padStart(2)} Σ(1/o)=${invSum.toFixed(3)} k=${k.toFixed(2)} 实际${s.actual}${inTop ? `(top#${idx + 1})` : "(top外)"}`);
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const below1 = sumDist.filter((x) => x < 1).length;
console.log(`\n===== 判据 =====`);
console.log(`Σ(1/o_top) 分布: min=${Math.min(...sumDist).toFixed(3)} 均=${avg(sumDist).toFixed(3)} max=${Math.max(...sumDist).toFixed(3)} | <1 的场: ${below1}/${sumDist.length}`);
console.log(`真实比分落在 top 内: ${hitInTop}/${samples.length}`);
console.log(`\nlogloss(仅 top 内 n=${n}, 噪声大只看方向):`);
console.log(`  比例法 proportional: ${(llProp / n).toFixed(4)}`);
console.log(`  强行 Power:          ${(llPow / n).toFixed(4)}`);
console.log(`  差(Power-比例): ${((llPow - llProp) / n).toFixed(4)}  ${llPow < llProp ? "→ Power更优" : "→ Power更差/无益"}`);
console.log(`\n结论指引: 若 Σ(1/o_top) 普遍 <1 → Power 的 overround 校正前提不成立、k<1 反向放大长尾,比分盘不应升级 Power,现状比例法恰当。`);
