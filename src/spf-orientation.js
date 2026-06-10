// 500.com pl_spf_2 / pl_nspf_2 方向定向共享模块(缺陷#3#13,2026-06-10)。
// 背景:500 两份 XML 的内容会互换(文件名不可信)。2026-06-09 按文件名硬解析把胜平负/让球喂反,
//   匈牙利 1X2 1.17 大热被推客胜(真钱事故)。离散度自动定向当时只修了 build-scrape-from-xml 一条链,
//   每日无人值守主链 ingest-500-jingcai-fallback 与收盘冻结 capture-closing-live 仍按文件名硬映射。
// 本模块把"离散度投票定向"抽成唯一实现,三条链共用:
//   原理:悬殊/大热场 1X2 三项赔率的离散度(max/min)远大于让球盘
//   (匈牙利 1X2 1.17/5.35/11.5 比≈9.8 vs 让-2 3.11/3.36/1.96 比≈1.7)。
//   逐场比两 feed 离散度投票,多数票判哪个 feed 是 1X2。
// 铁律(feedback_no_fallback_absolute):投票不确定(平票/无样本)返回 "uncertain",
//   调用方必须标⚠️人工复核并阻断落盘,绝不按文件名硬猜兜底。

/** 三项赔率离散度 max/min;行形如 {win,draw,lost}(500 row 属性)或 {home,draw,away}。无效行返回 null。 */
export function tripleRatio(row) {
  if (!row) return null;
  const v = [
    Number(row.win ?? row.home),
    Number(row.draw),
    Number(row.lost ?? row.away),
  ].filter((x) => Number.isFinite(x) && x > 0);
  return v.length === 3 ? Math.max(...v) / Math.min(...v) : null;
}

export const ORIENT_A_IS_1X2 = "A_IS_1X2";
export const ORIENT_B_IS_1X2 = "B_IS_1X2";
export const ORIENT_UNCERTAIN = "uncertain";

/**
 * 对齐行对投票定向。
 * @param {Array<{a:object|null,b:object|null}>} pairs 同一场比赛在两 feed 的最新行
 * @returns {{orientation:string, voteA:number, voteB:number, sampled:number}}
 *   orientation: "A_IS_1X2" | "B_IS_1X2" | "uncertain"(平票/零样本——绝不硬猜)
 */
export function orientRowPairs(pairs, { factor = 1.3 } = {}) {
  let voteA = 0;
  let voteB = 0;
  let sampled = 0;
  for (const { a, b } of pairs ?? []) {
    const ra = tripleRatio(a);
    const rb = tripleRatio(b);
    if (ra == null || rb == null) continue;
    sampled += 1;
    if (ra > rb * factor) voteA += 1;       // feedA 更离散 → feedA 是 1X2
    else if (rb > ra * factor) voteB += 1;  // feedB 更离散 → feedB 是 1X2
  }
  const orientation = voteA > voteB ? ORIENT_A_IS_1X2 : voteB > voteA ? ORIENT_B_IS_1X2 : ORIENT_UNCERTAIN;
  return { orientation, voteA, voteB, sampled };
}

/**
 * 便捷形:两个 Map(matchnum → 最新行),按键交集对齐后投票。
 */
export function orientRowMaps(mapA, mapB, opts) {
  const pairs = [];
  for (const [key, a] of mapA ?? []) {
    if (mapB?.has?.(key)) pairs.push({ a, b: mapB.get(key) });
  }
  return orientRowPairs(pairs, opts);
}

/**
 * 逐场互换残留守护(feed 级定向之后的第二道闸):
 *   让球盘本应比同场 1X2 更收敛(让球线就是为了拉平);若某场"让球"三项离散度反而显著高于
 *   "胜平负",说明该场两套赔率仍是喂反的(或 feed 内部分场错位)。
 *   旧实现(ingest :125-129)比较 euro.latest——oddsSet 输出根本没有 .latest 字段,守护是死代码,
 *   且只 console.error 不阻断;本函数修为读 .current,命中由调用方设 exitCode 并阻断落盘。
 * @param {{current:{home,draw,away}}|null} euro 胜平负 oddsSet
 * @param {{current:{home,draw,away}}|null} handicap 让球 oddsSet
 * @param {{factor?:number}} [opts] factor 默认 2(留余量防误伤无人值守真钱管线;真互换悬殊场比值≈5.8 远超)
 * @returns {string|null} 命中返回告警文案,否则 null。euro=null 悬殊场无从逐场比对,
 *   返回 null(其方向已由 feed 级离散度投票覆盖,不算绕过)。
 */
export function swapGuardViolation(euro, handicap, { factor = 2, line = null } = {}) {
  const e = euro?.current ?? null;
  const h = handicap?.current ?? null;
  if (!e || !h) return null;
  const re = tripleRatio(e);
  const rh = tripleRatio(h);
  if (re == null || rh == null) return null;
  // 2026-06-10 世界杯审计洞1:均势场+竞彩整数深让球线(|线|≥1)让球离散天然高(实测 4002 韩捷 4.11/1.17=3.5、
  //   7011 科厄 2.3,页面证实为正确定向非互换),×2 必误报且整日阻断落盘;真互换形态比值≈5.8-6.5(06-09 事故实测)。
  //   |线|≥1 时阈值提至 ×5:两侧均有余量;让0/未知线保持 ×2 原灵敏度。feed 级离散度投票仍是第一道闸不受影响。
  const eff = line != null && Math.abs(Number(line)) >= 1 ? Math.max(factor, 5) : factor;
  if (rh > re * eff) {
    return `让球三项离散度(${rh.toFixed(2)})显著高于胜平负(${re.toFixed(2)},阈值×${eff}),疑似 spf/nspf 互换残留`;
  }
  return null;
}
