// 世界杯【出线情景 + 名次路径动机】因子(2026-06-19 建)——把"小组第几出线会碰谁/想碰谁"纳入逐场分析。
// ════════════════════════════════════════════════════════════════════════════════════════
// 设计哲学(遵 wc-match-model 既有口径):
//   - 路径(名次→R32对手/半区)= 真实赛制结构,确定性,作【透明决定因素观察】展示,不偷改概率。
//   - 末轮"必须赢/平即可/已出线轮换/双方默契平"= 真实可推导的动机,**只在数学明确(剩1场)时**给强标注;
//     对概率的影响默认 no-op(factor=1.0),仅在 opts.applyMotivation 显式开启时给保守 nudge——因无 OOS 回测,
//     遵铁律不偷偷改概率。强度建议值已给,等回测/用户裁决再启用。
// 纯函数,零 IO:积分榜/对阵/bracket 由调用方传入(wc-knockout-path.mjs 或 wc-match-model 的 caller)。

// R32 位次→象限/半区(与 wc-knockout-path 一致)
const QUARTERS = { Q1: [73, 74, 75, 77], Q2: [76, 78, 79, 80], Q3: [81, 82, 83, 84], Q4: [85, 86, 87, 88] };
const HALF = { Q1: "上半区", Q2: "上半区", Q3: "下半区", Q4: "下半区" };

/** 由 bracket.r32 + 组字母给出该组第1/第2名所在的 r32 赛号、象限、半区(确定性,不依赖赛果)。 */
export function positionPath(bracketR32, groupLetter) {
  const slotMatch = {};
  for (const m of bracketR32) { slotMatch[m.home] = m.m; slotMatch[m.away] = m.m; }
  const qOf = (mno) => Object.entries(QUARTERS).find(([, ms]) => ms.includes(mno))?.[0] || null;
  const out = {};
  for (const r of ["1", "2"]) {
    const slot = r + groupLetter, mno = slotMatch[slot], q = qOf(mno);
    // 对手位次(同场另一边)
    const mm = bracketR32.find((x) => x.m === mno);
    const oppSlot = mm.home === slot ? mm.away : mm.home;
    out["pos" + r] = { slot, r32Match: mno, quarter: q, half: q ? HALF[q] : null, oppSlot };
  }
  return out; // {pos1:{slot,r32Match,quarter,half,oppSlot}, pos2:{...}}
}

/**
 * 末轮(剩 1 场)出线情景:对 team 在其小组的处境给确定性动机标签。
 * @param table  groupTable() 结果(已按名次排序,元素含 team/pts/gd/gf)
 * @param team   关注队
 * @param remainingOpponent  team 末轮对手
 * @param topN   出线名额(本届组内前2;第三能否出线跨组定,这里只判"锁前2/争前2/出局边缘")
 */
export function finalRoundScenario(table, team, remainingOpponent, topN = 2) {
  const me = table.find((r) => r.team === team);
  if (!me) return { tier: "unknown" };
  const pos = table.indexOf(me) + 1;
  const cutPts = table[topN - 1]?.pts ?? 0;        // 当前第2名积分
  const firstChasePts = table[topN]?.pts ?? 0;     // 当前第3名积分(追赶者)
  const gapAhead = (table[topN - 2]?.pts ?? me.pts) - me.pts; // 距前一名
  // 已稳前2:即便输,追赶者赢也追不上(净胜球粗略不计,保守用积分)
  const lockedTop = pos <= topN && me.pts > firstChasePts + 3;
  const win3 = me.pts + 3;
  let tier, need, note;
  if (lockedTop) {
    tier = "likely-through";
    need = "已基本锁定出线,末轮无需冒进";
    note = "可能轮换/保留体能 → 强度略降、爆冷风险升";
  } else if (pos <= topN) {
    tier = me.pts - firstChasePts >= 1 ? "draw-enough" : "win-to-secure";
    need = tier === "draw-enough" ? "平即可保住前2(看追赶者)" : "需不败/取胜确保前2";
    note = tier === "draw-enough" ? "可能控场求稳 → 进球数偏低" : "正常争胜";
  } else {
    tier = win3 > cutPts ? "must-win" : "must-win-and-pray";
    need = win3 > cutPts ? "必须取胜方有望挤进前2" : "胜也未必够(还需其他场配合)";
    note = "死中求生 → 强度拉满、后程压上失球风险升";
  }
  return { tier, pos, need, note, points: me.pts, gd: me.gd };
}

/**
 * 一场末轮对阵的"默契球"嫌疑:双方若都靠一个平局即可携手出线(经典算计),平局概率上修、进球下修。
 * 仅在双方都【平即可出线/双方都已基本锁定】时为真。诚实:只标嫌疑,不强行改赔。
 */
export function mutualDrawSuspect(homeScenario, awayScenario) {
  const safe = (s) => s && (s.tier === "draw-enough" || s.tier === "likely-through");
  return !!(safe(homeScenario) && safe(awayScenario));
}

/**
 * 动机→强度乘子(默认 no-op)。仅当 apply=true 时返回保守建议值(待回测验证再生产启用)。
 * 返回 {home,away}=各自 form 乘子(>1 斗志↑,<1 摆烂/控场)。
 */
export function scenarioIntensity(homeScenario, awayScenario, apply = false) {
  if (!apply) return { home: 1.0, away: 1.0, applied: false };
  const f = (s) => s?.tier === "must-win" ? 1.03
    : s?.tier === "must-win-and-pray" ? 1.02
    : s?.tier === "likely-through" ? 0.97
    : s?.tier === "draw-enough" ? 0.99 : 1.0;
  return { home: f(homeScenario), away: f(awayScenario), applied: true };
}

/** 组装一场比赛的完整路径+情景观察块(供 wc-match-model 输出展示)。standings 可选(无则只给路径)。 */
export function matchPathScenario({ bracketR32, groupLetter, table = null, home = null, away = null, finalRound = false }) {
  const path = groupLetter ? positionPath(bracketR32, groupLetter) : null;
  let scenario = null;
  if (table && home && away && finalRound) {
    const hs = finalRoundScenario(table, home, away);
    const as = finalRoundScenario(table, away, home);
    scenario = { home: hs, away: as, mutualDrawSuspect: mutualDrawSuspect(hs, as) };
  }
  return { path, scenario };
}
