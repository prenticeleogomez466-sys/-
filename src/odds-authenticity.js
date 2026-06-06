/**
 * 赔率真实性检测(2026-06-02)——"必须保证所有内容真实"的代码防线。
 * ════════════════════════════════════════════════════════════════════
 * 背景:早盘/低流动性时,500 等源会挂"模板占位赔率"(主客对称、未走盘),
 *   它们不是真实市场价,绝不能当真盘展示/驱动。靠人眼发现不可靠,写进代码硬拦。
 * 检测信号:
 *   ① 比分盘 aXY 与 bYX 对称(主胜比分=镜像客胜比分)→ 占位;
 *   ② 半全场 主主==客客 且 主客==客主 → 占位;
 *   ③ 胜平负三项与"开==收"完全没动 + 数值是整模板 → 早盘未走(弱信号)。
 * 真盘在有热门时必然主客**不对称**(热门方比分赔率更低)。
 */

const approxEq = (a, b, tol = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));

/** 比分盘是否占位(主客对称)。bf: {a10,b10,a21,b21,...}(aXY=主胜向, bXY=客胜向镜像)。 */
export function isScoreTemplate(bf) {
  if (!bf || typeof bf !== "object") return false;
  const pairs = [];
  for (const k of Object.keys(bf)) {
    if (!/^a\d\d$/.test(k)) continue;
    const bk = "b" + k.slice(1);
    if (bk in bf) pairs.push([bf[k], bf[bk]]);
  }
  if (pairs.length < 4) return false;
  const symCount = pairs.filter(([a, b]) => approxEq(a, b)).length;
  return symCount / pairs.length >= 0.8; // ≥80% 主客对称 → 占位
}

/** 半全场盘是否占位(主主==客客 且 主客==客主)。bqc 中文键。 */
export function isHalfFullTemplate(bqc) {
  if (!bqc || typeof bqc !== "object") return false;
  return approxEq(bqc["主主"], bqc["客客"]) && approxEq(bqc["主客"], bqc["客主"]) && approxEq(bqc["主平"], bqc["客平"]);
}

// ── top 数组版(2026-06-07 接线):管线实际用 snapshot.scoreOdds.top=[{score,odds}] /
//    halfFullOdds.top=[{halfFull,odds}],不是原始 500 的 bf/bqc map。原模块只认 map 故一直是
//    孤儿、这道"禁假编"防线没生效。下面按 top 数组判占位:镜像盘(主胜向 vs 客胜向)赔率对称=占位。
const swapHomeAway = (s) => s === "主胜" ? "客胜" : s === "客胜" ? "主胜" : s; // 平局自镜像
/** 比分 top 是否占位:score "h-a" 与镜像 "a-h" 赔率≥80%对称(且≥4对镜像)。 */
export function isScoreTopTemplate(top) {
  const rows = Array.isArray(top) ? top : Array.isArray(top?.top) ? top.top : [];
  const odds = new Map();
  for (const r of rows) {
    const m = String(r?.score ?? "").replace(":", "-").match(/^(\d+)\s*-\s*(\d+)$/);
    if (m && Number.isFinite(Number(r.odds))) odds.set(`${m[1]}-${m[2]}`, Number(r.odds));
  }
  let pairs = 0, sym = 0, seen = new Set();
  for (const [k, v] of odds) {
    const [h, a] = k.split("-");
    if (h === a) continue;              // 平局比分(1-1)自镜像,跳过
    const mk = `${a}-${h}`;
    if (!odds.has(mk) || seen.has(k) || seen.has(mk)) continue;
    seen.add(k); seen.add(mk); pairs++;
    if (approxEq(v, odds.get(mk))) sym++;
  }
  return pairs >= 4 && sym / pairs >= 0.8;
}
/** 半全场 top 是否占位:主胜向 vs 客胜向镜像赔率≥80%对称(且≥3对)。 */
export function isHalfFullTopTemplate(top) {
  const rows = Array.isArray(top) ? top : Array.isArray(top?.top) ? top.top : [];
  const odds = new Map();
  for (const r of rows) {
    const hf = String(r?.halfFull ?? "").trim();
    if (/^(主胜|客胜|平局)-(主胜|客胜|平局)$/.test(hf) && Number.isFinite(Number(r.odds))) odds.set(hf, Number(r.odds));
  }
  let pairs = 0, sym = 0, seen = new Set();
  for (const [k, v] of odds) {
    const [x, y] = k.split("-");
    const mk = `${swapHomeAway(x)}-${swapHomeAway(y)}`;
    if (mk === k || !odds.has(mk) || seen.has(k) || seen.has(mk)) continue; // 平局-平局 等自镜像跳过
    seen.add(k); seen.add(mk); pairs++;
    if (approxEq(v, odds.get(mk))) sym++;
  }
  return pairs >= 3 && sym / pairs >= 0.8;
}

/**
 * 综合判定一场抓取的赔率真实性。
 * @returns {{authentic:boolean, templateMarkets:string[], note:string}}
 */
export function assessOddsAuthenticity({ bf, bqc, spf } = {}) {
  const tpl = [];
  if (isScoreTemplate(bf)) tpl.push("比分");
  if (isHalfFullTemplate(bqc)) tpl.push("半全场");
  const authentic = tpl.length === 0;
  return {
    authentic,
    templateMarkets: tpl,
    note: authentic ? "盘口已走、主客不对称=真盘" : `占位/模板盘(主客对称未走盘):${tpl.join("、")} — 不可当真盘用/展示`,
  };
}
