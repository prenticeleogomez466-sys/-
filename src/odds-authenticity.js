/**
 * 赔率真实性检测(2026-06-02,2026-06-07 接线收口)——"必须保证所有内容真实"的代码防线。
 * ════════════════════════════════════════════════════════════════════
 * 背景:早盘/低流动性时,500 等源会挂"模板占位赔率"(主客镜像对称、未走盘),
 *   它们不是真实市场价,绝不能当真盘展示/驱动。靠人眼发现不可靠,写进代码硬拦。
 * 管线实际用 snapshot.scoreOdds.top=[{score,odds}] / halfFullOdds.top=[{halfFull,odds}],
 *   故只保留 top 数组版检测(原始 500 bf/bqc map 版无调用方,2026-06-07 删)。
 * 接线:prediction-engine.scoreFromMarket / halfFullFromMarket —— 占位盘丢弃→回退 DC 派生矩阵。
 * 检测逻辑:镜像盘(主胜向比分 vs 客胜向镜像比分 / 主胜向半全场 vs 客胜向镜像)赔率≥80%对称=占位;
 *   真盘有热门时必然主客**不对称**(热门方赔率更低)。
 */

const approxEq = (a, b, tol = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));
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
