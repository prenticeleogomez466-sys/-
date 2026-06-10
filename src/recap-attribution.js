/**
 * 复盘自动归因(2026-05-31)—— 每场结算后自动分类"为什么对/为什么错",形成可落地的反思。
 * ────────────────────────────────────────────────────────────
 * 遵 feedback_deep_analysis_postmortem:不只统计命中率,要根因归类、总结、反思、提炼改进。
 * 输入:已结算的 ledger 行(含 primary/actual/概率/信心/比分推/实际比分/competition)。
 * 输出:每行一个 {category, why} + 全量分类汇总,供日报"复盘归因"页 + 改进项提炼。
 */

const code = (label) => (label === "主胜" ? "home" : label === "客胜" ? "away" : label === "平局" ? "draw" : label);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function totalGoals(score) {
  const m = String(score ?? "").match(/(\d+)\s*-\s*(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) : null;
}

/**
 * 单行归因。
 * @param {object} row ledger 行
 * @returns {{hit:boolean, category:string, why:string, lessons:string[]}|null}
 */
export function attributeRow(row) {
  if (!row?.actual || row.hit == null) return null;
  const ph = num(row.probabilityHome), pd = num(row.probabilityDraw), pa = num(row.probabilityAway);
  const probs = { home: ph, draw: pd, away: pa };
  const sorted = [ph, pd, pa].sort((a, b) => b - a);
  const gap = sorted[0] - sorted[1];
  const conf = num(row.confidence);
  const predCode = code(row.primary);
  const actCode = code(row.actual);
  const favProb = probs[predCode] ?? sorted[0];
  const lessons = [];

  // 比分 λ 偏差(预测 vs 实际总进球)
  const predTG = totalGoals(row.scorePrimary);
  const actTG = totalGoals(row.actualScore);
  const tgBias = (predTG != null && actTG != null) ? actTG - predTG : null;
  if (tgBias != null && Math.abs(tgBias) >= 3) lessons.push(`比分总进球偏差${tgBias > 0 ? "+" : ""}${tgBias}(实${actTG}/推${predTG})`);

  if (row.hit) {
    // —— 为什么对 ——
    let category, why;
    if (favProb >= 0.65 && conf >= 70) { category = "强热门兑现"; why = `公认大热(${(favProb * 100).toFixed(0)}%·信心${conf})如期兑现,高可信`; }
    else if (gap < 0.12 || conf < 40) { category = "低信心蒙对"; why = `近硬币局(gap ${(gap * 100).toFixed(0)}%·信心${conf})方向蒙对,非真优势,勿高估`; lessons.push("低信心命中不计入'真本事',下次仍属高方差"); }
    else { category = "正常命中"; why = `中等信心(${(favProb * 100).toFixed(0)}%·gap${(gap * 100).toFixed(0)}%)方向正确`; }
    return { hit: true, category, why, lessons };
  }

  // —— 为什么错 ——
  let category, why;
  if (actCode === "draw" && predCode !== "draw" && pd < 0.30) {
    category = "平局低估";
    why = `实际打平,但模型仅给平局 ${(pd * 100).toFixed(0)}%(<30%)→ 低估平局(常见于小球/均势/低战意联赛)`;
    lessons.push(`平局低估:检查该联赛(${row.competition ?? "?"})历史平局率是否被压;考虑加平局校准`);
  } else if (favProb >= 0.60) {
    category = "强热门爆冷";
    why = `推方向占 ${(favProb * 100).toFixed(0)}%却被翻盘${actTG != null && predTG != null && actTG - predTG >= 3 ? "(且大比分)" : ""}→ 过度自信/真爆冷`;
    lessons.push("强热门翻车:多属不可预见爆冷,但需查是否忽略主客场/伤停/状态");
  } else if (gap < 0.30 || conf < 50) {
    category = "硬币局判错";
    why = `低信心硬币局(gap ${(gap * 100).toFixed(0)}%·信心${conf})方向判错 → 本无真实优势`;
    lessons.push("硬币局:验证'选择分层'——这类场就不该单选/搏胆,应覆盖或放弃");
  } else if (predCode !== "draw" && actCode !== "draw" && predCode !== actCode) {
    category = "方向反转";
    why = `推${row.primary}实${row.actual},主客判反 → 球队强弱/主客场优势估反`;
    lessons.push(`方向反转:查该联赛主客场优势(如英超主场弱)与球队近况是否估反`);
  } else {
    category = "一般未中";
    why = `推${row.primary}实${row.actual}`;
  }
  return { hit: false, category, why, lessons };
}

/**
 * 全量归因汇总。
 * @param {Array} rows 已结算 ledger 行
 * @returns {{settled,hit,accuracy,byCategory,byLeague,lessons,topImprovements}}
 */
export function attributeRecap(rows) {
  const settled = (rows ?? []).filter((r) => r?.actual && r.hit != null);
  const items = settled.map((r) => ({ row: r, attr: attributeRow(r) })).filter((x) => x.attr);
  const byCategory = {};
  const byLeague = {};
  const lessonCount = {};
  for (const { row, attr } of items) {
    byCategory[attr.category] = (byCategory[attr.category] ?? 0) + 1;
    const lg = row.competition ?? "?";
    (byLeague[lg] ??= { n: 0, hit: 0 }).n++;
    if (attr.hit) byLeague[lg].hit++;
    for (const l of attr.lessons) lessonCount[l] = (lessonCount[l] ?? 0) + 1;
  }
  const hit = items.filter((x) => x.attr.hit).length;
  // 接住率(2026-06-10 用户定口径"单选为主+接住率为辅"):单选中 或 模型主动标双选的场任一双选方向兑现。
  //   只认 doubleChanceRecommended===true 的场(模型赛前主动提示),不放宽到事后任意次选,防口径注水。
  const jc = (label) => (label === "主胜" ? "3" : label === "平局" ? "1" : label === "客胜" ? "0" : String(label ?? ""));
  const caught = items.filter((x) =>
    x.attr.hit || (x.row.doubleChanceRecommended === true
      && Array.isArray(x.row.doubleChanceCodes ?? null)
      && x.row.doubleChanceCodes.map(String).includes(jc(x.row.actual)))
  ).length;
  // 提炼 top 改进项:出现≥2 次的教训 + 命中率最差(样本≥2)的联赛
  const topImprovements = [
    ...Object.entries(lessonCount).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c}场)`),
    ...Object.entries(byLeague).filter(([, v]) => v.n >= 2 && v.hit / v.n <= 0.34).map(([lg, v]) => `联赛弱项 ${lg}:命中 ${v.hit}/${v.n} → 需专项校准`),
  ];
  return {
    settled: settled.length,
    hit,
    accuracy: settled.length ? Math.round(hit / settled.length * 1000) / 10 : null,
    caught,
    caughtRate: settled.length ? Math.round(caught / settled.length * 1000) / 10 : null,
    byCategory,
    byLeague,
    items: items.map((x) => ({ match: x.row.match, competition: x.row.competition, hit: x.attr.hit, category: x.attr.category, why: x.attr.why })),
    topImprovements,
  };
}

/**
 * 复盘看板头行(2026-06-11 用户裁决③:复盘=单选命中为主+接住率为辅)。
 * 口径注明:接住率=单选中 或 双选触发场任一方向兑现(只认赛前 doubleChanceRecommended===true,防注水)。
 */
export function attributionHeadline(attr) {
  if (!attr?.settled) return "暂无已结算场次(等赛果回填)";
  const caught = attr.caughtRate != null
    ? ` · 接住 ${attr.caught}(${attr.caughtRate}%)〔接住率=单选中或双选触发场任一兑现·辅助指标〕`
    : "";
  return `结算 ${attr.settled} · 命中 ${attr.hit}(${attr.accuracy}%)${caught}`;
}
