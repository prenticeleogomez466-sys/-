/**
 * 情报统计层(Intel Statistics,2026-06-15)
 * ────────────────────────────────────────────────────────────
 * 用户裁决(2026-06-15):"情报信息非常重要,最大范围增强、填补情报空缺"。
 * 本模块把【已采集的真实数据】(近期赛果结构化列 / 预测首发频次 / 比赛日期)派生成尽可能多维的统计情报。
 *
 * 严守铁律(guardrail 三标签):
 *   ✅实测 = 直接来自真实赛果/真实首发记录的计数(进失球/胜平负/BTTS/大球/日期…可逐条追溯);
 *   🔶推断 = 由实测派生的指数/标签(动量分/火力档/轮换风险%),必注依据;
 *   ⚠️缺   = 源缺/样本不足 → 返回 null,调用方标缺,绝不用默认/中性值兜底。
 * 全部纯函数、零 I/O、零 fetch、决定性(无随机/无时间抖动),便于回归钉死(防"统计被悄悄编造")。
 * **展示层专用:这些统计绝不进胜负平/比分概率(有市场赔率时融合情报回测净负,违"打不过市场就别装")。**
 */

const r2 = (x) => Math.round(x * 100) / 100;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

/** 解析 "2-0"(本队-对手,与 r 胜平负一致)→ {own, opp};非法→null(不猜)。 */
export function parseScore(score) {
  const m = String(score ?? "").match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!m) return null;
  return { own: Number(m[1]), opp: Number(m[2]) };
}

/**
 * 近期战绩 → 多维统计(✅实测,逐条可追溯)。
 * @param {{list?:Array<{date?,ha?,vs?,r?,score?}>}} formObj resolveRecentForm 入参同源
 * @param {{recentN?:number}} [opts]
 * @returns {object|null} 样本不足(无可解析赛果)→ null
 */
export function formStats(formObj, opts = {}) {
  const list = Array.isArray(formObj?.list) ? formObj.list : [];
  const games = [];
  for (const m of list) {
    const s = parseScore(m.score);
    if (!s) continue;
    games.push({ date: m.date ?? null, ha: m.ha ?? null, r: m.r ?? null, own: s.own, opp: s.opp });
  }
  if (!games.length) return null;
  const n = games.length;
  const sum = (f) => games.reduce((t, g) => t + f(g), 0);
  const w = games.filter((g) => g.own > g.opp).length;
  const d = games.filter((g) => g.own === g.opp).length;
  const l = games.filter((g) => g.own < g.opp).length;
  const gf = sum((g) => g.own), ga = sum((g) => g.opp);
  const btts = games.filter((g) => g.own > 0 && g.opp > 0).length;
  const over25 = games.filter((g) => g.own + g.opp >= 3).length;
  const cleanSheet = games.filter((g) => g.opp === 0).length;
  const failedToScore = games.filter((g) => g.own === 0).length;
  return {
    tag: "✅实测", n,
    w, d, l, wPct: pct(w, n), dPct: pct(d, n), lPct: pct(l, n),
    ppg: r2((w * 3 + d) / n),
    gfPer: r2(gf / n), gaPer: r2(ga / n), gdPer: r2((gf - ga) / n),
    bttsPct: pct(btts, n), over25Pct: pct(over25, n),
    cleanSheetPct: pct(cleanSheet, n), failedToScorePct: pct(failedToScore, n),
    text: `近${n}场:场均进${r2(gf / n)}失${r2(ga / n)}·胜率${pct(w, n)}%·BTTS${pct(btts, n)}%·大2.5球${pct(over25, n)}%·零封${pct(cleanSheet, n)}%`,
  };
}

/** 主客场拆分(✅实测):按 ha 字段分组各自战绩,揭示"主场强/客场软"。 */
export function homeAwaySplit(formObj) {
  const list = Array.isArray(formObj?.list) ? formObj.list : [];
  const side = (want) => {
    const sub = list.filter((m) => m.ha === want);
    if (!sub.length) return null;
    return formStats({ list: sub });
  };
  const home = side("主"), away = side("客");
  if (!home && !away) return null;
  const fmt = (s, label) => (s ? `${label}${s.w}胜${s.d}平${s.l}负·场均进${s.gfPer}失${s.gaPer}` : `${label}无样本`);
  return { tag: "✅实测", home, away, text: `${fmt(home, "主场:")} ║ ${fmt(away, "客场:")}` };
}

/**
 * 状态动量(🔶推断,依据=真实赛果时序):近3场 ppg vs 更早 ppg 走势 + 当前连续态(连胜/连不败/连不胜…)。
 * 决定性:list 必须可按 date 降序排定;无日期则按给定顺序(视为已最新在前)。
 */
export function formMomentum(formObj) {
  const list = (Array.isArray(formObj?.list) ? [...formObj.list] : [])
    .filter((m) => m.r === "胜" || m.r === "平" || m.r === "负");
  if (!list.length) return null;
  // 有 date 则降序(最新在前);否则保持原序
  if (list.every((m) => m.date)) list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const pts = (r) => (r === "胜" ? 3 : r === "平" ? 1 : 0);
  const recent = list.slice(0, 3), earlier = list.slice(3);
  const ppgOf = (arr) => (arr.length ? r2(arr.reduce((t, m) => t + pts(m.r), 0) / arr.length) : null);
  const recentPpg = ppgOf(recent), earlierPpg = ppgOf(earlier);
  // 当前连续态:从最新往回数同结果
  let streakLen = 1; const top = list[0].r;
  for (let i = 1; i < list.length && list[i].r === top; i++) streakLen++;
  // 连不败/连不胜(更实用)
  let unbeaten = 0; for (const m of list) { if (m.r !== "负") unbeaten++; else break; }
  let winless = 0; for (const m of list) { if (m.r !== "胜") winless++; else break; }
  const streakText = top === "胜" ? `${streakLen}连胜` : top === "负" ? `${streakLen}连负` : `${streakLen}连平`;
  let trend = "平稳";
  if (recentPpg != null && earlierPpg != null) trend = recentPpg - earlierPpg >= 0.5 ? "上升📈" : earlierPpg - recentPpg >= 0.5 ? "下滑📉" : "平稳";
  return {
    tag: "🔶推断", streak: streakText, unbeaten, winless, recentPpg, earlierPpg, trend,
    text: `当前${streakText}${unbeaten >= 3 ? `·${unbeaten}场不败` : ""}${winless >= 3 ? `·${winless}场不胜` : ""}·状态${trend}(近3场ppg${recentPpg ?? "—"}${earlierPpg != null ? ` vs 早${earlierPpg}` : ""})`,
  };
}

/**
 * 赛程密度/疲劳(🔶推断,依据=真实比赛日期 + 参照日):距最近一战天数 + 近14/30天场次。
 * @param {object} formObj  含 list[].date
 * @param {string} asOfDate ISO 日期(本场比赛日);缺则不算"距今"
 */
export function scheduleCongestion(formObj, asOfDate = null) {
  const dates = (Array.isArray(formObj?.list) ? formObj.list : [])
    .map((m) => m.date).filter(Boolean).map((x) => String(x).slice(0, 10)).sort((a, b) => b.localeCompare(a));
  if (!dates.length) return null;
  const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
  let restDays = null;
  if (asOfDate) { const dd = dayDiff(String(asOfDate).slice(0, 10), dates[0]); if (Number.isFinite(dd)) restDays = dd; }
  const within = (days) => (asOfDate ? dates.filter((d) => { const x = dayDiff(String(asOfDate).slice(0, 10), d); return x >= 0 && x <= days; }).length : null);
  const last14 = within(14), last30 = within(30);
  const congested = restDays != null && restDays >= 0 && restDays <= 3;
  return {
    tag: "🔶推断", restDays, last14, last30, congested,
    text: restDays != null
      ? `距上一战${restDays}天${congested ? "⚠️赛程密集(≤3天)" : ""}${last14 != null ? `·近14天${last14}场` : ""}`
      : `近赛日期已知,本场日期未提供无法算间歇(标缺距今)`,
  };
}

/** 攻防画像(🔶推断,依据=formStats 的场均进/失):火力档 + 防守档标签。 */
export function attackDefenseProfile(stats) {
  if (!stats) return null;
  const atk = stats.gfPer >= 2 ? "火力强🔥" : stats.gfPer >= 1.3 ? "进攻中等" : "进攻乏力";
  const def = stats.gaPer <= 0.7 ? "防守铁桶🛡️" : stats.gaPer <= 1.3 ? "防守中等" : "后防漏风";
  return { tag: "🔶推断", attack: atk, defense: def, text: `${atk}(场均进${stats.gfPer})·${def}(场均失${stats.gaPer})` };
}

/**
 * 交锋史深化统计(✅实测,需结构化 h2h 列;只有文本→调用方标缺,绝不从文本编造)。
 * @param {Array<{date?,score?,homeTeam?,awayTeam?,result?}>} h2hList 结构化对阵记录(以"目标主队"视角的 score 本队-对手)
 */
export function h2hStats(h2hList) {
  const list = Array.isArray(h2hList) ? h2hList : [];
  const games = [];
  for (const m of list) {
    const s = parseScore(m.score);
    if (!s) continue;
    games.push({ own: s.own, opp: s.opp });
  }
  if (!games.length) return null;
  const n = games.length;
  const w = games.filter((g) => g.own > g.opp).length;
  const d = games.filter((g) => g.own === g.opp).length;
  const l = games.filter((g) => g.own < g.opp).length;
  const tg = games.reduce((t, g) => t + g.own + g.opp, 0);
  const over25 = games.filter((g) => g.own + g.opp >= 3).length;
  const btts = games.filter((g) => g.own > 0 && g.opp > 0).length;
  return {
    tag: "✅实测", n, w, d, l, avgTotal: r2(tg / n), over25Pct: pct(over25, n), bttsPct: pct(btts, n),
    text: `近${n}次交锋:${w}胜${d}平${l}负·场均总进${r2(tg / n)}球·大2.5球${pct(over25, n)}%·BTTS${pct(btts, n)}%`,
  };
}

/**
 * 预测首发稳定度/轮换风险(🔶推断,依据=aggregatePredictedXI 的 starts/n 频次)。
 * 核心11人=近N场全首发(starts===n);稳定度=平均出场率;轮换风险=非铁主力占比。
 * @param {{xi?:Array<{name,starts}>, n?:number}} predicted aggregatePredictedXI 产物
 */
export function lineupStability(predicted) {
  const xi = Array.isArray(predicted?.xi) ? predicted.xi : [];
  const n = predicted?.n ?? 0;
  if (!xi.length || !n) return null;
  const core = xi.filter((p) => p.starts >= n);          // 近n场全首发=铁主力
  const rotational = xi.filter((p) => p.starts < n);
  const avgRate = r2(xi.reduce((t, p) => t + Math.min(1, (p.starts ?? 0) / n), 0) / xi.length);
  const riskLabel = avgRate >= 0.85 ? "阵容稳定" : avgRate >= 0.6 ? "轻度轮换" : "轮换频繁⚠️";
  return {
    tag: "🔶推断", n, coreCount: core.length, rotationalCount: rotational.length, stability: avgRate,
    text: `预测XI稳定度${Math.round(avgRate * 100)}%(${riskLabel}):铁主力${core.length}人/近${n}场全首发,${rotational.length}人有轮换`,
  };
}

/**
 * 关键缺阵影响(🔶推断,依据=预测XI名单 ∩ 伤停名单的名字匹配):预测首发里有几人在伤停名单。
 * 名字匹配=去空格后互相包含(免费源中英混排,保守匹配,匹配不上不算=不夸大)。
 * @param {Array<{name}>} predictedXI
 * @param {Array<{name}>} injuredPlayers
 */
export function lineupAvailability(predictedXI, injuredPlayers) {
  const xi = (Array.isArray(predictedXI) ? predictedXI : []).map((p) => String(p?.name ?? "").trim()).filter(Boolean);
  const inj = (Array.isArray(injuredPlayers) ? injuredPlayers : []).map((p) => String(p?.name ?? "").trim()).filter(Boolean);
  if (!xi.length) return null;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
  const hit = [];
  for (const name of xi) {
    const nn = norm(name);
    if (inj.some((i) => { const ni = norm(i); return ni.length >= 3 && (nn.includes(ni) || ni.includes(nn)); })) hit.push(name);
  }
  return {
    tag: "🔶推断", predictedCount: xi.length, missingFromXI: hit.length, names: hit,
    text: hit.length ? `预测首发${hit.length}人疑在伤停名单:${hit.slice(0, 4).join("、")}(🔶名字匹配,非官方)` : `预测首发暂无与伤停名单重合(主力齐整或伤停名单未覆盖)`,
  };
}
