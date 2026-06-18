// 选择分档 跨联赛迁移验证 (backtest-tier-cross-league)
// ──────────────────────────────────────────────────────────────────────────
// 工作流①(2026-06-18):selection-tier.js 的档内命中率(T1=88.2%…T6=40.7%)拟合自
//   ALL_LEAGUES 33263 场, 但"跨弱联赛迁移未验证"。本脚本按市场隐含热门概率分档,
//   分别在 [五大联赛] 与 [其它/弱联赛] 实测档内热门命中率, 看分档是否在弱联赛同样成立。
//   口径=市场热门(收盘devig最大的主/客)胜率, 与 selection-tier 一致。
//   结论用于: 若弱联赛同档命中率与五大接近→分档可跨联赛用(诚实标);若系统偏低→标 caveat。
//
// 用法: node scripts/backtest-tier-cross-league.mjs

const BASE = "https://www.football-data.co.uk/mmz4281";
const SEASON_CODES = ["1819", "1920", "2021", "2122", "2223", "2324", "2425", "2526"];
const BIG5 = ["E0", "D1", "SP1", "I1", "F1"];
const OTHER = ["E1", "E2", "D2", "SP2", "I2", "F2", "N1", "B1", "P1", "T1", "G1", "SC0"];

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function devig3(oh, od, oa) { if (!oh || !od || !oa) return null; const ih = 1 / oh, id = 1 / od, ia = 1 / oa, s = ih + id + ia; return s > 0 ? { h: ih / s, d: id / s, a: ia / s } : null; }
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()); if (!lines.length) return [];
  const head = lines[0].split(","); const idx = (n) => head.indexOf(n); const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(","); if (c.length < 10) continue;
    const ftr = c[idx("FTR")]; if (!ftr || !"HDA".includes(ftr)) continue;
    const close = devig3(num(c[idx("AvgCH")]), num(c[idx("AvgCD")]), num(c[idx("AvgCA")]))
      ?? devig3(num(c[idx("B365CH")]), num(c[idx("B365CD")]), num(c[idx("B365CA")]));
    if (!close) continue;
    out.push({ ftr, close });
  }
  return out;
}
async function loadGroup(leagues) {
  const all = []; let ok = 0;
  for (const lg of leagues) for (const sn of SEASON_CODES) {
    try { const r = await fetch(`${BASE}/${sn}/${lg}.csv`); if (!r.ok) continue; all.push(...parseCsv(await r.text())); ok++; } catch { /* skip */ }
  }
  return { all, ok };
}

const TIERS = [
  { key: "T1≥0.80", min: 0.80, big5: 0.882 },
  { key: "T2≥0.72", min: 0.72, big5: 0.795 },
  { key: "T3≥0.65", min: 0.65, big5: 0.731 },
  { key: "T4≥0.55", min: 0.55, big5: 0.626 },
  { key: "T5≥0.45", min: 0.45, big5: 0.502 },
  { key: "T6<0.45", min: 0.00, big5: 0.407 },
];
function tierOf(p) { return TIERS.find((t) => p >= t.min); }

function tally(rows) {
  const acc = {}; for (const t of TIERS) acc[t.key] = { n: 0, hit: 0 };
  for (const m of rows) {
    const c = m.close;
    if (c.d >= c.h && c.d >= c.a) continue;
    const favSide = c.h >= c.a ? "h" : "a";
    const favP = c[favSide];
    const t = tierOf(favP);
    const actual = m.ftr === "H" ? "h" : m.ftr === "A" ? "a" : "d";
    acc[t.key].n++; if (actual === favSide) acc[t.key].hit++;
  }
  return acc;
}

(async () => {
  console.error("[load] big5…"); const b = await loadGroup(BIG5);
  console.error("[load] other/weak…"); const o = await loadGroup(OTHER);
  console.log(`\n===== 选择分档 跨联赛迁移验证 =====`);
  console.log(`五大联赛 CSV ${b.ok} 个 ${b.all.length} 场 · 其它/弱联赛 CSV ${o.ok} 个 ${o.all.length} 场\n`);
  const tb = tally(b.all), to = tally(o.all);
  console.log("档位        参照(big5拟合)  五大实测(n)        弱联赛实测(n)       五大−弱  迁移");
  let maxGap = 0;
  for (const t of TIERS) {
    const B = tb[t.key], O = to[t.key];
    const bp = B.n ? B.hit / B.n : null, op = O.n ? O.hit / O.n : null;
    const gap = (bp != null && op != null) ? (bp - op) * 100 : null;
    if (gap != null) maxGap = Math.max(maxGap, Math.abs(gap));
    const ok = gap != null && Math.abs(gap) <= 4 ? "✅一致" : gap != null ? "⚠️偏差>4pp" : "—";
    console.log(
      `${t.key.padEnd(10)} ${(t.big5 * 100).toFixed(1).padStart(6)}%       ` +
      `${bp != null ? (bp * 100).toFixed(1).padStart(5) + `%(${B.n})` : "—".padStart(8)}`.padEnd(20) +
      `${op != null ? (op * 100).toFixed(1).padStart(5) + `%(${O.n})` : "—".padStart(8)}`.padEnd(20) +
      `${gap != null ? (gap >= 0 ? "+" : "") + gap.toFixed(1) + "pp" : "—"}`.padStart(8) + `  ${ok}`
    );
  }
  console.log(`\n最大档间偏差 ${maxGap.toFixed(1)}pp → ${maxGap <= 4 ? "✅ 分档跨联赛迁移成立(弱联赛同档命中率与五大接近,可直接用·诚实标)" : "⚠️ 弱联赛需 caveat 或独立档"}`);
})();
