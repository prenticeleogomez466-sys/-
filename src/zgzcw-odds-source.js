/**
 * 中国足彩网(zgzcw)百家指数/凯利 源(2026-06-04)——竞彩盘口"百家欧赔共识 + 离散度"。
 * ────────────────────────────────────────────────────────────
 * 比赛列表(odds.zgzcw.com)JS 渲染→浏览器层抓 matchId+队名(scripts 里);**本模块纯解析**(可单测):
 *   每场分析页 `fenxi.zgzcw.com/<matchId>/bjop`(静态 HTML,Node 直连可取)含:
 *   - 平均欧赔行:即时主/平/客 + 初盘主/平/客(open→close 漂移=真实盘口异动)
 *   - 离散度:各公司赔率方差(高=分歧大/不确定)
 * 喂市场快照的 europeanOdds(百家共识=另一路市场锚,可与 500/The Odds API 交叉验证) + 描述层 dispersion。
 * 纪律:作市场数据源/描述层接入,**不擅自当提命中率的概率信号**(动概率需回测,遵命中率闭环硬规则)。
 * 免费、无 key(遵"只要免费")。
 */

/** 从 bjop 页 HTML 的某 `<tr>` 块里按序取 data="数字" 赔率(跳过 data="0" 的公司标签列)。 */
function oddsDataInRow(rowHtml) {
  const nums = [];
  const re = /data="([\d.]+)"/g;
  let m;
  while ((m = re.exec(rowHtml)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) nums.push(v);
  }
  // 首个常为 data="0"(公司列),去掉前导 0
  return nums[0] === 0 ? nums.slice(1) : nums;
}

/** 取含关键词的 <tr> 整块 HTML(到下一个 </tr>)。 */
function rowContaining(html, keyword) {
  const i = html.indexOf(keyword);
  if (i < 0) return null;
  const start = html.lastIndexOf("<tr", i);
  const end = html.indexOf("</tr>", i);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end);
}

/**
 * 解析 zgzcw bjop(百家欧赔)页 → 百家共识赔率(即时+初盘)+ 离散度。
 * 返回 { consensus:{ current:{home,draw,away}, initial:{home,draw,away} }, dispersion:{home,draw,away}|null, ok }。
 * 解析不到 → { ok:false }。
 */
export function parseZgzcwBjop(html) {
  if (typeof html !== "string" || !html.includes("平均欧赔")) return { ok: false };
  const row = rowContaining(html, "平均欧赔");
  if (!row) return { ok: false };
  const d = oddsDataInRow(row);
  // d 前 6 个 = 即时(主平客) + 初盘(主平客)
  if (d.length < 6 || !(d[0] > 1 && d[1] > 1 && d[2] > 1)) return { ok: false };
  const current = { home: d[0], draw: d[1], away: d[2] };
  const initial = { home: d[3], draw: d[4], away: d[5] };
  // 离散度:文本 "离散度 a b c"(主平客方差)。从纯文本取该词后 3 个数。
  let dispersion = null;
  const txt = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const di = txt.indexOf("离散度");
  if (di >= 0) {
    const after = txt.slice(di, di + 60).match(/[\d.]+/g);
    if (after && after.length >= 3) dispersion = { home: Number(after[0]), draw: Number(after[1]), away: Number(after[2]) };
  }
  return { ok: true, consensus: { current, initial }, dispersion, source: "zgzcw 百家欧赔" };
}

/** 抓单场 bjop 页(Node 直连,静态 HTML)。返回解析结果。 */
export async function fetchZgzcwBjopOdds(matchId, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("当前环境无 fetch");
  const r = await fetchImpl(`http://fenxi.zgzcw.com/${matchId}/bjop`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", Referer: "https://odds.zgzcw.com/" },
  });
  if (!r.ok) return { ok: false, matchId, error: `HTTP ${r.status}` };
  const html = await r.text();
  return { ...parseZgzcwBjop(html), matchId };
}

/** 百家共识 → 隐含概率(去 vig 归一),供交叉验证/描述。 */
export function zgzcwImpliedProbs(consensusCurrent) {
  if (!consensusCurrent) return null;
  const { home, draw, away } = consensusCurrent;
  if (!(home > 1 && draw > 1 && away > 1)) return null;
  const r = 1 / home + 1 / draw + 1 / away;
  return { home: (1 / home) / r, draw: (1 / draw) / r, away: (1 / away) / r, overround: r - 1 };
}

/**
 * 一场 zgzcw 行(列表页 {home,away,league,date} + bjop 解析 consensus)→ 市场快照对象。
 * europeanOdds 用 {initial:初盘, current:即时};source 标 zgzcw-百家欧赔 作第三路独立锚。
 * 离散度走 dispersion 字段(market-store normalize 会丢弃,只进描述层 sidecar,不污染概率引擎)。
 */
export function buildZgzcwSnapshot(row, parsed, fallbackDate) {
  if (!row || !parsed?.ok || !parsed.consensus?.current) return null;
  const { current, initial } = parsed.consensus;
  return {
    date: (row.dateIso || fallbackDate || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? fallbackDate,
    homeTeam: row.home,
    awayTeam: row.away,
    competition: row.league ?? "",
    sequence: row.seq ?? "",
    europeanOdds: { initial, current },
    dispersion: parsed.dispersion ?? null,
    source: "zgzcw-百家欧赔",
    collectedAt: row.collectedAt ?? null,
  };
}

/**
 * 交叉验证:zgzcw 去 vig 概率 vs 主锚(500/The Odds API)去 vig 概率。
 * 返回 { maxAbsDiff, agree, divergent, biggestLeg, note }。两路都缺则 null。
 * 纯描述/告警,不改任何概率(分歧大=提示人核对,非自动改盘)。
 */
export function crossValidateZgzcw(zgzcwProbs, primaryProbs, threshold = 0.06) {
  if (!zgzcwProbs || !primaryProbs) return null;
  const legs = ["home", "draw", "away"];
  let maxAbsDiff = 0;
  let biggestLeg = null;
  for (const leg of legs) {
    const d = Math.abs((zgzcwProbs[leg] ?? 0) - (primaryProbs[leg] ?? 0));
    if (d > maxAbsDiff) { maxAbsDiff = d; biggestLeg = leg; }
  }
  const divergent = maxAbsDiff >= threshold;
  return {
    maxAbsDiff: Math.round(maxAbsDiff * 10000) / 10000,
    biggestLeg,
    agree: !divergent,
    divergent,
    note: divergent
      ? `百家共识与主锚在「${biggestLeg}」分歧 ${(maxAbsDiff * 100).toFixed(1)}pp,建议人工核对`
      : "百家共识与主锚一致(分歧<阈值)",
  };
}
