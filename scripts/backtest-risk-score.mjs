// 连续风险分(0-100) 数据驱动回测 (backtest-risk-score)
// ──────────────────────────────────────────────────────────────────────────
// 目的(用户裁决"四项全挖到底"·工作流A): 把现有"高/中/低"三档离散风险升级为
// 连续 0-100 风险分前, 先用真实历史 OOS 实测:
//   1) 各候选风险因子对"热门不胜(=投热门会输)"的边际效应(分层 + z 检验);
//   2) 连续风险分 vs 现有三档, 谁的分辨率(loss 预测 Brier / 校准 / 单调性)更高;
//   3) 时间切分(前70%训练→后30%测试)防泄漏, 测试集见真章。
// 变好才建模块、变差就证伪存档(遵 feedback_hitrate_closed_loop / no_fabrication)。
//
// 数据 = football-data.co.uk CSV(同 signal-crossval): 开盘Avg / 收盘AvgC(去vig) +
//   亚盘水位 + 亚盘让球线AHh + 大球Avg>2.5 + 赛果FTR。
// 口径 = 每场取"市场热门"(收盘隐含最大的主或客, 排除平局为热门的极少数),
//   pick=热门, 实际 loss = FTR≠热门方向(即热门不胜)。这正是用户日常最常下的注型。
//
// 用法: node scripts/backtest-risk-score.mjs

const BASE = "https://www.football-data.co.uk/mmz4281";
const SEASON_CODES = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
const LEAGUES = ["E0", "E1", "D1", "D2", "SP1", "SP2", "I1", "F1", "N1", "B1", "P1", "T1", "G1"];

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function devig3(oh, od, oa) {
  if (!oh || !od || !oa) return null;
  const ih = 1 / oh, id = 1 / od, ia = 1 / oa, s = ih + id + ia;
  return s > 0 ? { h: ih / s, d: id / s, a: ia / s } : null;
}
function devig2(oh, oa) {
  if (!oh || !oa) return null;
  const ih = 1 / oh, ia = 1 / oa, s = ih + ia;
  return s > 0 ? ih / s : null;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(",");
  const idx = (name) => head.indexOf(name);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c.length < 10) continue;
    const ftr = c[idx("FTR")];
    if (!ftr || !"HDA".includes(ftr)) continue;
    const open = devig3(num(c[idx("AvgH")]), num(c[idx("AvgD")]), num(c[idx("AvgA")]))
      ?? devig3(num(c[idx("B365H")]), num(c[idx("B365D")]), num(c[idx("B365A")]));
    const close = devig3(num(c[idx("AvgCH")]), num(c[idx("AvgCD")]), num(c[idx("AvgCA")]))
      ?? devig3(num(c[idx("B365CH")]), num(c[idx("B365CD")]), num(c[idx("B365CA")]));
    if (!close) continue;
    // 亚盘让球线(主队视角): AHh / AHCh / B365AHh
    const ahLine = num(c[idx("AHCh")]) ?? num(c[idx("AHh")]) ?? num(c[idx("B365AHh")]);
    // 大球2.5 概率(去vig)
    const over = devig2(num(c[idx("Avg>2.5")]), num(c[idx("Avg<2.5")]))
      ?? devig2(num(c[idx("B365>2.5")]), num(c[idx("B365<2.5")]));
    out.push({ date: c[idx("Date")], ftr, open, close, ahLine, over });
  }
  return out;
}
function parseDate(s) {
  const m = (s || "").split("/");
  if (m.length !== 3) return 0;
  let [d, mo, y] = m.map((x) => parseInt(x, 10));
  if (y < 100) y += 2000;
  return Date.UTC(y, mo - 1, d);
}
async function loadAll() {
  const all = []; let ok = 0, fail = 0;
  for (const league of LEAGUES) for (const season of SEASON_CODES) {
    try {
      const r = await fetch(`${BASE}/${season}/${league}.csv`);
      if (!r.ok) { fail++; continue; }
      all.push(...parseCsv(await r.text())); ok++;
    } catch { fail++; }
  }
  console.error(`[load] CSV ok=${ok} fail=${fail}, matches=${all.length}`);
  all.forEach((r) => { r.ts = parseDate(r.date); });
  return all.filter((r) => r.ts > 0).sort((a, b) => a.ts - b.ts);
}

// ── 把一场转成"热门视角"特征行 ──
function toFeatureRow(m) {
  const { close, open, ftr } = m;
  // 热门 = 收盘隐含最大的主/客(排除平局为最大的极少数均势场)
  if (close.d >= close.h && close.d >= close.a) return null; // 平局为热门→跳过(无明确单边热门)
  const favSide = close.h >= close.a ? "h" : "a";
  const favImplied = close[favSide];
  if (favImplied < 0.40) return null; // 太均势不算热门
  const loss = (ftr === "H" ? "h" : ftr === "A" ? "a" : "d") !== favSide ? 1 : 0;
  const baseLoss = 1 - favImplied;              // 市场共识:热门不胜概率
  const drawImplied = close.d;
  const favDrift = open && Number.isFinite(open[favSide]) ? close[favSide] - open[favSide] : null;
  const ahAbs = Number.isFinite(m.ahLine) ? Math.abs(m.ahLine) : null;
  return { ts: m.ts, favSide, favImplied, loss, baseLoss, drawImplied, favDrift, ahAbs, over: m.over };
}

// ── 工具:加权均值 + 两比例 z 检验 ──
function rate(rows) { const n = rows.length; const k = rows.reduce((s, r) => s + r.loss, 0); return { n, k, p: n ? k / n : 0 }; }
function ztest(a, b) {
  const p = (a.k + b.k) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  return se > 0 ? (a.p - b.p) / se : 0;
}

// ── 现有三档(diagnoseUpsetRisk band): baseLoss≥0.35高 / ≥0.25中 / else低 ──
function tier3(baseLoss) { return baseLoss >= 0.35 ? "高" : baseLoss >= 0.25 ? "中" : "低"; }

// ── 极简 logistic 回归(手写梯度下降, 无依赖) ──
function fitLogistic(X, y, { iters = 4000, lr = 0.3, l2 = 1e-4 } = {}) {
  const d = X[0].length; let w = new Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    let gb = 0; const gw = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const p = 1 / (1 + Math.exp(-z)); const e = p - y[i];
      gb += e; for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
    }
    b -= lr * gb / X.length;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / X.length + l2 * w[j]);
  }
  return { w, b };
}
function predictLogistic(model, x) {
  let z = model.b; for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
  return 1 / (1 + Math.exp(-z));
}
function brier(ps, ys) { return ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / ps.length; }
function logloss(ps, ys) {
  return -ps.reduce((s, p, i) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return s + (ys[i] * Math.log(q) + (1 - ys[i]) * Math.log(1 - q)); }, 0) / ps.length;
}

(async () => {
  const raw = await loadAll();
  const rows = raw.map(toFeatureRow).filter(Boolean);
  console.log(`\n===== 风险分回测 · 热门视角 N=${rows.length} 场(${LEAGUES.length}联赛×${SEASON_CODES.length}季)=====\n`);
  const overall = rate(rows);
  console.log(`基准: 热门整体不胜率 ${(overall.p * 100).toFixed(1)}%\n`);

  // ── (1) 各因子边际效应(全样本分层 + z)──
  console.log("── (1) 候选风险因子边际效应(同热门强度内对比, z>2 显著)──");
  // 控制 favImplied 强度档, 看每个因子的增量
  const strata = [[0.40, 0.50], [0.50, 0.60], [0.60, 0.72], [0.72, 1.01]];
  const factorTest = (name, predFn) => {
    let pooledA = { n: 0, k: 0 }, pooledB = { n: 0, k: 0 }; const lines = [];
    for (const [lo, hi] of strata) {
      const seg = rows.filter((r) => r.favImplied >= lo && r.favImplied < hi);
      const withF = seg.filter((r) => predFn(r) === true);
      const without = seg.filter((r) => predFn(r) === false);
      if (withF.length < 30 || without.length < 30) continue;
      const a = rate(withF), b = rate(without);
      pooledA.n += a.n; pooledA.k += a.k; pooledB.n += b.n; pooledB.k += b.k;
      lines.push(`    热门${(lo * 100) | 0}-${(hi * 100) | 0}%: 命中因子 ${(a.p * 100).toFixed(1)}%(n${a.n}) vs 无 ${(b.p * 100).toFixed(1)}%(n${b.n}) Δ${((a.p - b.p) * 100).toFixed(1)}pp`);
    }
    if (!pooledA.n || !pooledB.n) { console.log(`  ${name}: 样本不足`); return; }
    const A = { ...pooledA, p: pooledA.k / pooledA.n }, B = { ...pooledB, p: pooledB.k / pooledB.n };
    const z = ztest(A, B);
    console.log(`  【${name}】合计(控强度后): 有 ${(A.p * 100).toFixed(1)}% vs 无 ${(B.p * 100).toFixed(1)}% = Δ${((A.p - B.p) * 100).toFixed(1)}pp, z=${z.toFixed(2)} ${Math.abs(z) > 2 ? "✅显著" : "✗噪声"}`);
    lines.forEach((l) => console.log(l));
  };
  factorTest("平局隐含≥30%", (r) => r.drawImplied != null ? r.drawImplied >= 0.30 : null);
  factorTest("热门退烧(favDrift<-0.02)", (r) => r.favDrift == null ? null : r.favDrift < -0.02);
  factorTest("热门加注(favDrift>+0.02)", (r) => r.favDrift == null ? null : r.favDrift > 0.02);
  factorTest("让球线浅(|AH|≤1)", (r) => r.ahAbs == null ? null : r.ahAbs <= 1.0);
  factorTest("大球概率低(over≤0.46)", (r) => r.over == null ? null : r.over <= 0.46);

  // ── (2) 连续风险分 vs 三档: 时间切分 70/30 防泄漏 ──
  console.log("\n── (2) 连续风险分 vs 现有三档(时间切分: 前70%训练→后30%测试)──");
  const cut = Math.floor(rows.length * 0.7);
  const train = rows.slice(0, cut), test = rows.slice(cut);
  // 特征: [baseLoss, drawImplied, retreat, add, ahShallow, overLow]; 缺值→中性0
  const feat = (r) => [
    r.baseLoss,
    r.drawImplied ?? 0.27,
    r.favDrift != null && r.favDrift < -0.02 ? 1 : 0,
    r.favDrift != null && r.favDrift > 0.02 ? 1 : 0,
    r.ahAbs != null && r.ahAbs <= 1.0 ? 1 : 0,
    r.over != null && r.over <= 0.46 ? 1 : 0,
  ];
  const Xtr = train.map(feat), ytr = train.map((r) => r.loss);
  const Xte = test.map(feat), yte = test.map((r) => r.loss);

  // 模型0 = 纯市场基线(baseLoss 直接当 loss 概率)
  const p0 = test.map((r) => r.baseLoss);
  // 模型1 = 只重校准 baseLoss(logistic 单特征)
  const m1 = fitLogistic(train.map((r) => [r.baseLoss]), ytr);
  const p1 = test.map((r) => predictLogistic(m1, [r.baseLoss]));
  // 模型2 = baseLoss + 全部因子
  const m2 = fitLogistic(Xtr, ytr);
  const p2 = test.map((x, i) => predictLogistic(m2, Xte[i]));
  // 三档基线 = 用训练集每档实测 loss 率当预测
  const tierMean = {}; for (const t of ["高", "中", "低"]) { const seg = train.filter((r) => tier3(r.baseLoss) === t); tierMean[t] = seg.length ? rate(seg).p : overall.p; }
  const p3 = test.map((r) => tierMean[tier3(r.baseLoss)]);

  const report = (name, ps) => console.log(`  ${name.padEnd(26)} Brier=${brier(ps, yte).toFixed(4)}  LogLoss=${logloss(ps, yte).toFixed(4)}`);
  console.log(`  [测试集 N=${test.length}]  (Brier/LogLoss 越低越好)`);
  report("三档离散(高/中/低)", p3);
  report("①纯市场基线 baseLoss", p0);
  report("②重校准 baseLoss", p1);
  report("③base+全因子(连续分)", p2);

  // 连续分系数(看哪个因子真进了模型)
  const fn = ["baseLoss", "drawImplied", "退烧", "加注", "让球浅", "大球低"];
  console.log(`\n  连续分 logistic 系数(标准化前·绝对值大=影响大):`);
  m2.w.forEach((w, i) => console.log(`    ${fn[i].padEnd(12)} ${w >= 0 ? "+" : ""}${w.toFixed(3)}`));
  console.log(`    截距 ${m2.b.toFixed(3)}`);

  // ── (3) 连续分校准表(测试集): 风险分10档实际不胜率 ──
  console.log(`\n── (3) 连续风险分校准(测试集, 10档): 预测风险 vs 实际不胜率 ──`);
  const withScore = test.map((r, i) => ({ score: p2[i], loss: r.loss })).sort((a, b) => a.score - b.score);
  const B = 10, per = Math.ceil(withScore.length / B);
  for (let i = 0; i < B; i++) {
    const seg = withScore.slice(i * per, (i + 1) * per);
    if (!seg.length) continue;
    const pred = seg.reduce((s, r) => s + r.score, 0) / seg.length;
    const act = seg.reduce((s, r) => s + r.loss, 0) / seg.length;
    const bar = "█".repeat(Math.round(act * 30));
    console.log(`    档${(i + 1).toString().padStart(2)}: 风险分${(pred * 100).toFixed(0).padStart(3)} → 实际不胜${(act * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }
  // 分辨率 = 最高档 - 最低档 实际不胜率差(越大区分力越强)
  const lo10 = withScore.slice(0, per), hi10 = withScore.slice(-per);
  const spreadCont = (rate(hi10).p - rate(lo10).p) * 100;
  const tierLow = test.filter((r) => tier3(r.baseLoss) === "低"), tierHigh = test.filter((r) => tier3(r.baseLoss) === "高");
  const spread3 = (tierHigh.length && tierLow.length) ? (rate(tierHigh).p - rate(tierLow).p) * 100 : null;
  console.log(`\n  分辨率(高风险段实际不胜 − 低风险段): 连续分 ${spreadCont.toFixed(1)}pp  vs  三档 ${spread3 != null ? spread3.toFixed(1) + "pp" : "n/a"}`);
  console.log(`\n  裁决: 连续分 Brier ${brier(p2, yte) < brier(p3, yte) ? "<" : "≥"} 三档 → ${brier(p2, yte) < brier(p3, yte) ? "✅ 连续分更优(可上线)" : "⚠️ 未超三档(不上线/只取连续化本身)"}`);
})();
