// 亚盘水位信号回测(2026-05-30 用户要求:数据说话,信号能提命中率才正式参与概率)。
// 数据:football-data.co.uk 带开盘(B365AHH/AHA + AHh 线)+ 收盘(B365CAHH/CAHA + AHCh 线)亚盘水位。
// 方法:对每场用"开盘→收盘水位"跑 analyzeAsianHandicapWater → 信号 → LR;
//   对比 基准(收盘 1X2 赔率去 vig) vs 基准×水位LR 的 命中率 / Brier。
//   并按信号类型统计实际赛果频率,看信号有无方向性 lift。诚实输出,不预设结论。
import "../src/env.js";
import { analyzeAsianHandicapWater } from "../src/asian-handicap-water.js";

const LEAGUES = ["E0", "D1", "I1", "SP1", "F1"];
const SEASONS = ["2425", "2324", "2223"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

// 与 signal-fusion-layer 完全一致的 LR 表
const INVERT = process.env.INVERT === "1";
const LR_MAP_ORIG = {
  "warn-home": { home: 0.92, draw: 1.03, away: 1.08 },
  "warn-away": { home: 1.08, draw: 1.03, away: 0.92 },
  "danger-home": { home: 0.88, draw: 1.05, away: 1.12 },
  "danger-away": { home: 1.12, draw: 1.05, away: 0.88 },
  "favorite-suspicious": { home: 0.95, draw: 1.05, away: 1.00 }
};
// 反向(纠偏假设:信号方向应顺着 让球方,而非"警惕反向")
const LR_MAP_INV = {
  "warn-home": { home: 1.08, draw: 1.00, away: 0.92 },
  "warn-away": { home: 0.92, draw: 1.00, away: 1.08 },
  "danger-home": { home: 1.12, draw: 0.98, away: 0.88 },
  "danger-away": { home: 0.88, draw: 0.98, away: 1.12 },
  "favorite-suspicious": { home: 1.05, draw: 0.98, away: 1.00 }
};
const LR_MAP = INVERT ? LR_MAP_INV : LR_MAP_ORIG;

function devig(h, d, a) {
  const ih = 1 / h, id = 1 / d, ia = 1 / a;
  const s = ih + id + ia;
  return { home: ih / s, draw: id / s, away: ia / s };
}

function applyLR(p, lr) {
  const h = p.home * lr.home, d = p.draw * lr.draw, a = p.away * lr.away;
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

function brier(p, res) {
  const y = { home: res === "H" ? 1 : 0, draw: res === "D" ? 1 : 0, away: res === "A" ? 1 : 0 };
  return (p.home - y.home) ** 2 + (p.draw - y.draw) ** 2 + (p.away - y.away) ** 2;
}

function pick(p) { return p.home >= p.draw && p.home >= p.away ? "H" : p.away >= p.draw ? "A" : "D"; }

async function loadCsv(league, season) {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const text = await r.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",");
  const idx = (name) => head.indexOf(name);
  const col = { ftr: idx("FTR"), h: idx("B365H"), d: idx("B365D"), a: idx("B365A"), ahh_o: idx("B365AHH"), aha_o: idx("B365AHA"), ahline_o: idx("AHh"), ahh_c: idx("B365CAHH"), aha_c: idx("B365CAHA"), ahline_c: idx("AHCh") };
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const ftr = c[col.ftr];
    if (!["H", "D", "A"].includes(ftr)) continue;
    const num = (j) => { const v = Number(c[j]); return Number.isFinite(v) ? v : null; };
    const h = num(col.h), d = num(col.d), a = num(col.a);
    const earlyHome = num(col.ahh_o), earlyAway = num(col.aha_o), lateHome = num(col.ahh_c), lateAway = num(col.aha_c);
    const line = num(col.ahline_c) ?? num(col.ahline_o);
    if (!h || !d || !a) continue;
    out.push({ ftr, h, d, a, earlyHome, earlyAway, lateHome, lateAway, line });
  }
  return out;
}

async function main() {
  let matches = [];
  for (const lg of LEAGUES) for (const se of SEASONS) {
    try { matches = matches.concat(await loadCsv(lg, se)); } catch {}
  }
  const withWater = matches.filter((m) => m.earlyHome && m.earlyAway && m.lateHome && m.lateAway && Number.isFinite(m.line));
  // 基准 vs 水位调整
  let nFire = 0, hitBase = 0, hitWater = 0, brBase = 0, brWater = 0, n = 0;
  const bySignal = {};
  for (const m of withWater) {
    const base = devig(m.h, m.d, m.a);
    const analysis = analyzeAsianHandicapWater({ earlyHome: m.earlyHome, earlyAway: m.earlyAway, lateHome: m.lateHome, lateAway: m.lateAway, line: m.line });
    const sig = analysis?.signal;
    const lr = sig ? LR_MAP[sig] : null;
    n++;
    brBase += brier(base, m.ftr);
    if (pick(base) === m.ftr) hitBase++;
    const adj = lr ? applyLR(base, lr) : base;
    brWater += brier(adj, m.ftr);
    if (pick(adj) === m.ftr) hitWater++;
    if (lr) nFire++;
    if (sig) {
      bySignal[sig] = bySignal[sig] || { n: 0, H: 0, D: 0, A: 0 };
      bySignal[sig].n++; bySignal[sig][m.ftr]++;
    }
  }
  console.log(`样本(带开+收盘亚盘水位): ${n} 场 | 水位信号 fire: ${nFire} (${(nFire / n * 100).toFixed(1)}%)`);
  console.log(`命中率  基准 ${(hitBase / n * 100).toFixed(2)}%  →  +水位 ${(hitWater / n * 100).toFixed(2)}%  (Δ ${((hitWater - hitBase) / n * 100).toFixed(2)}pp)`);
  console.log(`Brier   基准 ${(brBase / n).toFixed(4)}  →  +水位 ${(brWater / n).toFixed(4)}  (Δ ${((brWater - brBase) / n).toFixed(4)}, 负=更好)`);
  console.log("\n按信号类型 实际赛果频率(看方向性 lift):");
  for (const [sig, v] of Object.entries(bySignal).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${sig.padEnd(22)} n=${String(v.n).padStart(4)} | 主胜 ${(v.H / v.n * 100).toFixed(1)}% 平 ${(v.D / v.n * 100).toFixed(1)}% 客胜 ${(v.A / v.n * 100).toFixed(1)}%`);
  }
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
