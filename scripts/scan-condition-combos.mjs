/**
 * scan-condition-combos.mjs —— 挖「多条件组合 → 高概率结果」(2026-06-22 用户:不能单一数据·几个条件组合起来高概率出某结果)。
 * 维度桶:欧赔档·让球线档·平赔档·1X2走势·大小球走势·让球线走势。枚举 2~3 维组合 × 结果(方向/大小球/半全场),
 * leak-safe 70/30,只报 TRAIN&TEST 都"某结果≥阈值+样本足"的组合=真·高概率条件组合(交叉验证过)。命中≠盈利。
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
const all = collectHistoricalMatches(4000).filter((m) => m.marketHistorical && m.homeGoals != null && m.awayGoals != null && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

function bucket(m) {
  const mh = m.marketHistorical, o = mh.openProbs, c = mh.closeProbs; if (!o || !c) return null;
  const favHome = c.home >= c.away, fk = favHome ? "home" : "away";
  const favProb = c[fk], drawProb = c.draw, a = mh.asian || {};
  const favOdds = 1 / favProb, drawOdds = 1 / drawProb;
  const favDrift = c[fk] - o[fk];
  const ahAbs = a.lineClose != null ? Math.abs(a.lineClose) : (a.line != null ? Math.abs(a.line) : null);
  const lineMove = a.lineClose != null && a.line != null ? Math.abs(a.lineClose) - Math.abs(a.line) : null;
  const ouDrift = mh.overProbClose != null && mh.overProb != null ? mh.overProbClose - mh.overProb : null;
  // 离散桶(每个维度;null=该维度本场缺→该维度不参与组合)
  const D = {};
  D["欧赔"] = favOdds < 1.3 ? "超热" : favOdds < 1.6 ? "大热" : favOdds < 2.1 ? "中热" : "势均";
  D["让球线"] = ahAbs == null ? null : ahAbs < 0.25 ? "平/浅" : ahAbs < 1.0 ? "中盘" : ahAbs < 1.625 ? "深" : "悬殊让2+";
  D["平赔"] = drawOdds < 3.2 ? "低平赔" : drawOdds < 3.7 ? "中平赔" : "高平赔";
  D["1X2走势"] = favDrift > 0.02 ? "热门加注" : favDrift < -0.02 ? "热门退烧" : "平稳";
  D["大小球走势"] = ouDrift == null ? null : ouDrift >= 0.03 ? "大球加注" : ouDrift <= -0.03 ? "大球退烧" : "走平";
  D["让球线走势"] = lineMove == null ? null : lineMove >= 0.25 ? "线加深" : lineMove <= -0.25 ? "线减浅" : "线不动";
  const outcome = m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw";
  const res = {
    "方向:主胜": outcome === "home" ? 1 : 0, "方向:客胜": outcome === "away" ? 1 : 0, "方向:平局": outcome === "draw" ? 1 : 0,
    "方向:热门胜": outcome === fk ? 1 : 0, "大球": (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0, "小球": (m.homeGoals + m.awayGoals) <= 2.5 ? 1 : 0,
  };
  return { D, res, favHome };
}
const rows = all.map(bucket).filter(Boolean);
const cut = Math.floor(rows.length * 0.7); const TR = rows.slice(0, cut), TE = rows.slice(cut);
const DIMS = ["欧赔", "让球线", "平赔", "1X2走势", "大小球走势", "让球线走势"];
const RESULTS = Object.keys(rows[0].res);
const MIN_TR = 150, MIN_TE = 70, HI = { "大球": 0.60, "小球": 0.60, "方向:主胜": 0.62, "方向:客胜": 0.62, "方向:平局": 0.40, "方向:热门胜": 0.62 };

// 枚举 2 维 和 3 维组合(每维取其出现的桶值)
function combos(k) {
  const out = [];
  const idx = [...Array(DIMS.length).keys()];
  const pick = (start, cur) => { if (cur.length === k) { out.push([...cur]); return; } for (let i = start; i < idx.length; i++) pick(i + 1, [...cur, idx[i]]); };
  pick(0, []); return out;
}
const found = [];
for (const k of [2, 3]) {
  for (const dimSet of combos(k)) {
    // 收集 TRAIN 里该维组合的所有桶值组合
    const seen = new Map();
    for (const r of TR) {
      const key = dimSet.map((di) => r.D[DIMS[di]]);
      if (key.some((v) => v == null)) continue;
      const kk = key.join(" + ");
      (seen.get(kk) ?? seen.set(kk, []).get(kk)).push(r);
    }
    for (const [kk, trS] of seen) {
      if (trS.length < MIN_TR) continue;
      const teS = TE.filter((r) => dimSet.map((di) => r.D[DIMS[di]]).join(" + ") === kk);
      if (teS.length < MIN_TE) continue;
      for (const res of RESULTS) {
        const trR = trS.reduce((s, r) => s + r.res[res], 0) / trS.length;
        const teR = teS.reduce((s, r) => s + r.res[res], 0) / teS.length;
        if (trR >= HI[res] && teR >= HI[res]) {
          found.push({ dims: dimSet.map((di) => DIMS[di]).join("+"), cond: kk, res, trR, teR, trN: trS.length, teN: teS.length, k });
        }
      }
    }
  }
}
// 去重(同 cond+res 取一次)+ 按 TEST 概率降序
const uniq = new Map();
for (const f of found) { const id = f.cond + "→" + f.res; if (!uniq.has(id) || uniq.get(id).teR < f.teR) uniq.set(id, f); }
const top = [...uniq.values()].sort((a, b) => b.teR - a.teR);
console.log(`样本 ${rows.length}(TR ${TR.length}/TE ${TE.length})｜枚举2~3维组合,报 TRAIN&TEST 都达阈值的`);
console.log(`\n══ 高概率条件组合(交叉验证过·TEST概率降序)共 ${top.length} 条 ══`);
const pc = (x) => (x * 100).toFixed(0) + "%";
for (const f of top.slice(0, 30)) console.log(`  [${f.cond}] → ${f.res}  TEST ${pc(f.teR)}(TRAIN ${pc(f.trR)}·n=${f.teN})`);
console.log(`\n诚实:这些是"几个条件都符合→某结果高概率"的真组合(leak-safe双验);命中≠盈利(收盘已定价),供选择性出手/做胆。`);
