// 四玩法综合命中率回测(2026-05-30 用户要求:全部检测 胜负平/让球/比分/半全场 能不能提命中率)。
// 数据:football-data.co.uk —— 全场 FTHG/FTAG + 半场 HTHG/HTAG + 让球线 AHh + 1X2 收盘赔率。
// 方法:对每场用 收盘赔率(去vig)派生胜负平,用 让球线 派生 supremacy → λ → 真泊松矩阵,
//   按生产同款逻辑取 胜负平/比分/半全场/让球 主选,与真实赛果比对。诚实输出每项命中率。
import "../src/env.js";
import { buildDerivedScoreModel, bestScoreFromMatrix } from "../src/derived-score-model.js";
import { halfFullProbsFromLambdas, evaluateDrawLean } from "../src/prediction-engine.js";

const LEAGUES = ["E0", "D1", "I1", "SP1", "F1", "E1", "SP2", "I2", "N1", "P1"];
const SEASONS = ["2425", "2324", "2223"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

function devig(h, d, a) { const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia; return { home: ih / s, draw: id / s, away: ia / s }; }
function outcomeOf(h, a) { return h > a ? "3" : h === a ? "1" : "0"; }

async function loadCsv(league, season) {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const lines = (await r.text()).split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(","); const idx = (n) => head.indexOf(n);
  const C = { fthg: idx("FTHG"), ftag: idx("FTAG"), hthg: idx("HTHG"), htag: idx("HTAG"), h: idx("B365H"), d: idx("B365D"), a: idx("B365A"), ah: idx("AHCh") >= 0 ? idx("AHCh") : idx("AHh"), o25: idx("B365>2.5"), u25: idx("B365<2.5") };
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(","); const num = (j) => { const v = Number(c[j]); return Number.isFinite(v) ? v : null; };
    const fthg = num(C.fthg), ftag = num(C.ftag), hthg = num(C.hthg), htag = num(C.htag);
    const h = num(C.h), d = num(C.d), a = num(C.a), ah = num(C.ah);
    if ([fthg, ftag, hthg, htag, h, d, a].some((x) => x === null)) continue;
    let total = 2.6; const o = num(C.o25), u = num(C.u25);
    if (o && u) { const po = (1 / o) / (1 / o + 1 / u); total = 2.0 + po * 1.4; } // 粗略:over越便宜总进球越高
    out.push({ fthg, ftag, hthg, htag, h, d, a, ah: ah ?? 0, total });
  }
  return out;
}

async function main() {
  let M = [];
  for (const lg of LEAGUES) for (const se of SEASONS) { try { M = M.concat(await loadCsv(lg, se)); } catch {} }
  let n = 0, wld = 0, hcp = 0, hcpN = 0, score = 0, hf = 0;
  let wldDraw = 0, drawPicked = 0;
  for (const m of M) {
    n++;
    const base = devig(m.h, m.d, m.a);
    // 让球线 AHh = 主队让球(负=让);supremacy ≈ -AHh
    const sup = -m.ah; const total = Math.max(1.8, Math.min(3.6, m.total));
    const lh = Math.max(0.2, (total + sup) / 2), la = Math.max(0.2, (total - sup) / 2);
    const model = buildDerivedScoreModel(lh, la);
    // 胜负平:argmax(收盘赔率) + draw-lean(与生产一致)
    let ranked = [["3", base.home], ["1", base.draw], ["0", base.away]].sort((x, y) => y[1] - x[1]).map(([code, p]) => ({ code, probability: p }));
    const dl = evaluateDrawLean(ranked); if (dl.applies) ranked = dl.ranked;
    const pickCode = ranked[0].code;
    const actualWld = outcomeOf(m.fthg, m.ftag);
    if (pickCode === actualWld) wld++;
    if (pickCode === "1") drawPicked++;
    if (actualWld === "1") wldDraw++;
    // 比分:该方向矩阵最高概率比分
    const scorePick = bestScoreFromMatrix(model.matrix, pickCode);
    if (scorePick === `${m.fthg}-${m.ftag}`) score++;
    // 半全场:联合分布里 终场=pickCode 的最高概率
    const hfDist = halfFullProbsFromLambdas(model.expectedGoals.home, model.expectedGoals.away, 0.46);
    const finalCh = { "3": "主胜", "1": "平局", "0": "客胜" }[pickCode];
    const hfPick = Object.entries(hfDist).filter(([k]) => k.split("-")[1] === finalCh).sort((x, y) => y[1] - x[1])[0]?.[0];
    const htCh = { "3": "主胜", "1": "平局", "0": "客胜" }[outcomeOf(m.hthg, m.htag)];
    const ftCh = { "3": "主胜", "1": "平局", "0": "客胜" }[actualWld];
    if (hfPick === `${htCh}-${ftCh}`) hf++;
    // 让球:推荐方向 让球后是否覆盖(主胜→主队让 AHh 后仍赢;客胜→客队)
    if (pickCode !== "1") {
      hcpN++;
      const adjHome = m.fthg + m.ah; // 主队让球后净分
      const covered = pickCode === "3" ? adjHome > m.ftag : adjHome < m.ftag;
      if (covered) hcp++;
    }
  }
  console.log(`样本: ${n} 场(big-5 + 5 个次级联赛 × 3 赛季)`);
  console.log(`① 胜负平 命中率: ${(wld / n * 100).toFixed(2)}%  (随机基线 33%,市场上限 ~54%)`);
  console.log(`   平局: 实际占 ${(wldDraw / n * 100).toFixed(1)}%,模型推平 ${(drawPicked / n * 100).toFixed(1)}% 场`);
  console.log(`② 让球  命中率: ${(hcp / hcpN * 100).toFixed(2)}%  (n=${hcpN},随机 ~50%)`);
  console.log(`③ 比分  命中率: ${(score / n * 100).toFixed(2)}%  (顶级模型上限 ~15%)`);
  console.log(`④ 半全场 命中率: ${(hf / n * 100).toFixed(2)}%  (顶级模型上限 ~28-35%)`);
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
