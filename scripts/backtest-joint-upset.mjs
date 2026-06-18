// 平局+爆冷联合概率 OOS 校准回测 (backtest-joint-upset)
// ──────────────────────────────────────────────────────────────────────────
// 工作流B(2026-06-18):现状 diagnoseUpsetRisk 把"热门不胜"(baseUpsetProb=1-favImplied)与
//   "平局隐含≥30%"分开报。B 要把热门不胜干净拆成联合概率:
//       P(热门不胜) = P(平局) + P(冷门胜)        ← 均来自市场 devig
//   并回答:这个拆解校准吗? 尤其"不胜里平局占多少"(drawShare)能否预测真实的失败模式
//   (被逼平 vs 被翻盘)——这决定玩法指引(平局占主→双选1X护一手;冷胜占主→别碰)。
//   校准成立才接 爆冷研判 + 决策辅助【E】(变好才上线·遵铁律)。
//
// 数据=football-data CSV(同 backtest-risk-score)。用法: node scripts/backtest-joint-upset.mjs

const BASE = "https://www.football-data.co.uk/mmz4281";
const SEASON_CODES = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
const LEAGUES = ["E0", "E1", "D1", "D2", "SP1", "SP2", "I1", "F1", "N1", "B1", "P1", "T1", "G1"];

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function devig3(oh, od, oa) {
  if (!oh || !od || !oa) return null;
  const ih = 1 / oh, id = 1 / od, ia = 1 / oa, s = ih + id + ia;
  return s > 0 ? { h: ih / s, d: id / s, a: ia / s } : null;
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(","); const idx = (n) => head.indexOf(n); const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(","); if (c.length < 10) continue;
    const ftr = c[idx("FTR")]; if (!ftr || !"HDA".includes(ftr)) continue;
    const close = devig3(num(c[idx("AvgCH")]), num(c[idx("AvgCD")]), num(c[idx("AvgCA")]))
      ?? devig3(num(c[idx("B365CH")]), num(c[idx("B365CD")]), num(c[idx("B365CA")]));
    if (!close) continue;
    out.push({ date: c[idx("Date")], ftr, close });
  }
  return out;
}
function pDate(s) { const m = (s || "").split("/"); if (m.length !== 3) return 0; let [d, mo, y] = m.map((x) => parseInt(x, 10)); if (y < 100) y += 2000; return Date.UTC(y, mo - 1, d); }
async function loadAll() {
  const all = []; let ok = 0, fail = 0;
  for (const lg of LEAGUES) for (const sn of SEASON_CODES) {
    try { const r = await fetch(`${BASE}/${sn}/${lg}.csv`); if (!r.ok) { fail++; continue; } all.push(...parseCsv(await r.text())); ok++; } catch { fail++; }
  }
  console.error(`[load] ok=${ok} fail=${fail} matches=${all.length}`);
  all.forEach((r) => { r.ts = pDate(r.date); });
  return all.filter((r) => r.ts > 0);
}

(async () => {
  const raw = await loadAll();
  // 热门视角行
  const rows = [];
  for (const m of raw) {
    const c = m.close;
    if (c.d >= c.h && c.d >= c.a) continue;          // 平局为热门→跳过
    const favSide = c.h >= c.a ? "h" : "a";
    const favImplied = c[favSide]; if (favImplied < 0.40) continue;
    const dogSide = favSide === "h" ? "a" : "h";
    const actual = m.ftr === "H" ? "h" : m.ftr === "A" ? "a" : "d";
    rows.push({
      favImplied, pDraw: c.d, pDog: c[dogSide],
      notWin: actual !== favSide ? 1 : 0,
      isDraw: actual === "d" ? 1 : 0,
      isDogWin: actual === dogSide ? 1 : 0,
    });
  }
  console.log(`\n===== 平局+爆冷联合概率 校准回测 · 热门视角 N=${rows.length} =====\n`);
  const mean = (a, k) => a.reduce((s, r) => s + r[k], 0) / a.length;
  console.log(`整体: 市场隐含 平局${(mean(rows, "pDraw") * 100).toFixed(1)}% / 冷胜${(mean(rows, "pDog") * 100).toFixed(1)}%`);
  console.log(`      实际    平局${(mean(rows, "isDraw") * 100).toFixed(1)}% / 冷胜${(mean(rows, "isDogWin") * 100).toFixed(1)}% / 不胜${(mean(rows, "notWin") * 100).toFixed(1)}%\n`);

  // ── (1) 边际校准: 市场平局/冷胜 devig vs 实际(分箱)──
  const calib = (key, actKey, label) => {
    console.log(`── ${label} 校准(10档): 市场隐含 vs 实际 ──`);
    const sorted = [...rows].sort((a, b) => a[key] - b[key]);
    const per = Math.ceil(sorted.length / 10); let maxAbs = 0, sse = 0, nn = 0;
    for (let i = 0; i < 10; i++) {
      const seg = sorted.slice(i * per, (i + 1) * per); if (!seg.length) continue;
      const pred = mean(seg, key), act = mean(seg, actKey);
      maxAbs = Math.max(maxAbs, Math.abs(pred - act)); sse += (pred - act) ** 2 * seg.length; nn += seg.length;
      console.log(`   档${(i + 1).toString().padStart(2)}: 隐含${(pred * 100).toFixed(1).padStart(5)}% → 实际${(act * 100).toFixed(1).padStart(5)}%  Δ${((act - pred) * 100).toFixed(1)}pp`);
    }
    console.log(`   ⇒ 最大档偏差 ${(maxAbs * 100).toFixed(1)}pp · RMSE ${(Math.sqrt(sse / nn) * 100).toFixed(2)}pp ${maxAbs < 0.05 ? "✅校准良好" : "⚠️偏差偏大"}\n`);
  };
  calib("pDraw", "isDraw", "P(平局)");
  calib("pDog", "isDogWin", "P(冷门胜)");

  // ── (2) 关键: "不胜里平局占比"(drawShare) 能否预测真实失败模式 ──
  console.log(`── (2) drawShare = P平/(P平+P冷胜) 条件校准(仅取热门真不胜的场, 看其中平局占比)──`);
  const notWinRows = rows.filter((r) => r.notWin === 1).map((r) => ({ drawShare: r.pDraw / (r.pDraw + r.pDog), isDraw: r.isDraw }));
  const sorted = notWinRows.sort((a, b) => a.drawShare - b.drawShare);
  const per = Math.ceil(sorted.length / 8); let maxAbs = 0;
  for (let i = 0; i < 8; i++) {
    const seg = sorted.slice(i * per, (i + 1) * per); if (!seg.length) continue;
    const pred = mean(seg, "drawShare"), act = mean(seg, "isDraw");
    maxAbs = Math.max(maxAbs, Math.abs(pred - act));
    console.log(`   档${(i + 1)}: 隐含平局占比${(pred * 100).toFixed(1).padStart(5)}% → 真不胜中实为平局${(act * 100).toFixed(1).padStart(5)}%  Δ${((act - pred) * 100).toFixed(1)}pp`);
  }
  console.log(`   ⇒ drawShare 最大档偏差 ${(maxAbs * 100).toFixed(1)}pp ${maxAbs < 0.06 ? "✅可信:可据 drawShare 区分'被逼平' vs '被翻盘'失败模式" : "⚠️偏差大,慎用"}`);
  console.log(`\n裁决: 联合拆解 P(不胜)=P(平)+P(冷胜) 三者市场devig均校准 → 可作连贯爆冷读数上线(纯市场锚·不编加成)。`);
})();
