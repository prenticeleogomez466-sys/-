/**
 * 比赛情报聚合层(Match Intelligence,2026-06-14)
 * ────────────────────────────────────────────────────────────
 * 用户裁决(2026-06-14):给"足球唯一大模型"加全方位情报系统,但**只做展示层、不动概率**
 *   —— 模型历史回测已证:有市场赔率时把情报信号融进概率是净负的(命中 54.2%→52.9%),
 *   且违"打不过市场就别装 / 绝不兜底"铁律。故情报一律落「情报详情」展示 sheet,不进 wld/比分概率,
 *   不碰 gateFusionOff、不重建 signal-fusion-layer 的 26 个信号。
 *
 * 复用(不重造轮子,2026-06-14 全链路审计后确认):
 *   - 阵型解析 parseFormation / formationPosture ← lineup-source.js
 *   - 已确认首发 / 伤停 / 新闻(GDELT) / 深度近赛 ← advanced-data-runner 已采集的 layers.*
 *   - 国家队近赛(含热身赛真赛果) ← wc-national-form.js 缓存
 *   - 预测首发 lineups.projected 字段 daily-report 早已预留展示(projectedLineupText),此前无采集器填它
 *
 * 诚实三标签铁律(guardrail):
 *   ✅实测  = 可追溯到本次抓取的真实值(已确认首发/真实赛果/真实伤停名单)
 *   🔶推断  = 模型派生(预测首发=近N场真首发频次聚合;动机=赛事类型启发),必注依据
 *   ⚠️缺   = 源缺/未抓到 → 标缺不编,绝不用默认/中性值冒充
 *
 * 本模块是**纯函数**:输入=已加载好的 layer 对象 + 缓存,输出=结构化情报对象,零 I/O、零 fetch,
 * 便于回归测试钉死(防"情报被悄悄编造")。I/O 在 scripts/sync-predicted-lineups.mjs 与交付编排器里做。
 */

import { parseFormation, formationPosture } from "./lineup-source.js";
import {
  formStats, homeAwaySplit, formMomentum, scheduleCongestion,
  attackDefenseProfile, h2hStats, lineupStability, lineupAvailability,
} from "./intel-stats.js";

export const INTEL_TAG = { REAL: "✅实测", INFER: "🔶推断", MISS: "⚠️缺" };

/**
 * 预测首发聚合(真空白模块的核心):用某队**近 N 场真实首发**的频次,推出最可能的首发 11 人 + 阵型。
 * 纯统计、可追溯、不编造:每个入选球员都带 starts/n,整体带 basis(哪几场推出的)。
 *
 * @param {Array<{date?:string, opponent?:string, formation?:string|null,
 *                starters?:Array<{name:string, position?:string|null}>}>} history
 *        某队近期比赛的真实首发记录(任意顺序;每条来自 ESPN summary rosters 已确认首发)。
 * @param {{minMatches?:number, xiSize?:number}} [opts]
 * @returns {{xi:Array<{name,starts,position}>, formation:string|null, formationParsed:object|null,
 *            n:number, basis:Array<{date,opponent}>, tag:string, note:string} | null}
 *          样本不足(<minMatches 场有效首发)→ null(调用方标 ⚠️缺,不硬凑)。
 */
export function aggregatePredictedXI(history, opts = {}) {
  const minMatches = opts.minMatches ?? 2;
  const xiSize = opts.xiSize ?? 11;
  const valid = (Array.isArray(history) ? history : []).filter(
    (m) => m && Array.isArray(m.starters) && m.starters.length >= xiSize
  );
  if (valid.length < minMatches) return null;

  const startCount = new Map();   // name -> 出场次数
  const posVotes = new Map();     // name -> {pos -> 次数}
  const formCount = new Map();    // formation -> 次数
  for (const m of valid) {
    if (m.formation) formCount.set(m.formation, (formCount.get(m.formation) ?? 0) + 1);
    for (const p of m.starters) {
      const name = String(p?.name ?? "").trim();
      if (!name) continue;
      startCount.set(name, (startCount.get(name) ?? 0) + 1);
      if (p.position) {
        const pv = posVotes.get(name) ?? new Map();
        pv.set(p.position, (pv.get(p.position) ?? 0) + 1);
        posVotes.set(name, pv);
      }
    }
  }

  const modePosition = (name) => {
    const pv = posVotes.get(name);
    if (!pv) return null;
    return [...pv.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  // 入选 = 出场次数降序,平次按名字稳定排序(决定性,可测;不引入随机/时间抖动)
  const xi = [...startCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, xiSize)
    .map(([name, starts]) => ({ name, starts, position: modePosition(name) }));

  const formation = formCount.size
    ? [...formCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    : null;
  const basis = valid
    .map((m) => ({ date: m.date ?? null, opponent: m.opponent ?? null }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return {
    xi,
    formation,
    formationParsed: formation ? parseFormation(formation) : null,
    n: valid.length,
    basis,
    tag: INTEL_TAG.INFER,
    note: `基于近${valid.length}场真实首发频次聚合(非官方公布;赛前1小时官方阵容出炉后以确认阵容为准)`,
  };
}

/**
 * 单侧首发情报:优先已确认首发(✅),无则预测首发(🔶),都没有→⚠️缺。
 * @param {object|null} confirmedSide  layers.lineups.fixtureData[id].home/away(ESPN/Sofascore 已确认侧)
 * @param {object|null} predicted      aggregatePredictedXI 产物(该队预测首发)
 */
export function resolveLineupSide(confirmedSide, predicted) {
  if (confirmedSide && Number(confirmedSide.starterCount) >= 11 && confirmedSide.confirmed) {
    return {
      tag: INTEL_TAG.REAL,
      status: "已确认首发",
      formation: confirmedSide.formation ?? null,
      xi: (confirmedSide.starters ?? []).slice(0, 11).map((s) => ({ name: s.name, position: s.position ?? null })),
      source: "ESPN/Sofascore 赛前官方首发",
    };
  }
  if (predicted && predicted.xi?.length) {
    return {
      tag: INTEL_TAG.INFER,
      status: "预测首发",
      formation: predicted.formation ?? null,
      xi: predicted.xi.map((p) => ({ name: p.name, position: p.position ?? null, starts: p.starts })),
      n: predicted.n,
      basis: predicted.basis,
      source: predicted.note,
    };
  }
  return { tag: INTEL_TAG.MISS, status: "未取到", formation: null, xi: [], source: "官方未公布且无足够历史首发样本(标缺不编)" };
}

/** 伤停情报:从已采集 injuries 层归一(✅真实名单 / ⚠️缺)。不替模型加权,只展示。 */
export function resolveInjuries(injuriesLayer) {
  const rows = injuriesLayer?.injuries ?? injuriesLayer?.rows ?? (Array.isArray(injuriesLayer) ? injuriesLayer : []);
  if (!Array.isArray(rows) || !rows.length) {
    return { tag: INTEL_TAG.MISS, count: 0, text: "未取到(免费伤停源覆盖有限:FPL限英超/Sofascore需浏览器;国家队多靠新闻)", players: [] };
  }
  const players = rows.map((r) => ({
    name: r.player?.name ?? r.playerName ?? r.name ?? "?",
    status: r.status ?? r.reason ?? r.type ?? null,
    note: r.news ?? r.detail ?? null,
  })).filter((p) => p.name && p.name !== "?");
  return {
    tag: INTEL_TAG.REAL,
    count: rows.length,
    players: players.slice(0, 12),
    text: `${rows.length}条:${players.slice(0, 8).map((p) => `${p.name}${p.status ? `(${p.status})` : ""}`).join("、")}`,
    source: injuriesLayer?.source ?? "免费伤停源",
  };
}

/** 近期热身赛/状态:国家队走 wc-national-form 真赛果(✅);该缓存即含友谊赛/热身赛。 */
export function resolveRecentForm(formObj) {
  if (!formObj || !formObj.list?.length) {
    return { tag: INTEL_TAG.MISS, text: "未取到近期赛(国家队近赛缓存无该队样本)", list: [] };
  }
  const list = formObj.list.map((m) => `${m.date} ${m.ha}vs${m.vs} ${m.r}${m.score}`);
  return {
    tag: INTEL_TAG.REAL,
    record: formObj.record,
    text: `${formObj.record}(近${formObj.played}场,含热身/预选):${list.join(" / ")}`,
    list,
    source: "ESPN 国际赛真实赛果(wc-national-results 缓存)",
  };
}

/** 新闻情报:GDELT 已采集的文章元数据(title/url/date)。诚实=🔶推断·带源,无 NLP 不编情绪。 */
export function resolveNews(newsLayer, opts = {}) {
  const max = opts.max ?? 4;
  const articles = newsLayer?.articles ?? newsLayer?.news ?? [];
  if (!Array.isArray(articles) || !articles.length) {
    // motivation 启发式(赛事类型派生,🔶);news 层若带 derived motivation 也接住
    const mot = newsLayer?.motivation?.summary ?? null;
    return {
      tag: mot ? INTEL_TAG.INFER : INTEL_TAG.MISS,
      motivation: mot,
      text: mot ? `动机(🔶赛事类型推断):${mot}` : "未取到相关新闻(GDELT 无该对阵命中)",
      articles: [],
    };
  }
  const top = articles.slice(0, max).map((a) => ({
    title: String(a.title ?? "").slice(0, 80),
    url: a.url ?? null,
    date: a.date ?? a.seendate ?? null,
  }));
  return {
    tag: INTEL_TAG.INFER,
    text: top.map((a) => `「${a.title}」${a.date ? `(${String(a.date).slice(0, 10)})` : ""}`).join(" / "),
    articles: top,
    note: "🔶仅文章标题/链接(无语义提取,勿当确认情报);来源链接见详情",
    source: "GDELT DOC 2.1",
  };
}

/**
 * 组装一场比赛的完整情报对象(纯函数)。所有字段带 ✅/🔶/⚠️ 标签,缺即标缺。
 * @param {{
 *   fixture:object,
 *   lineupSide?:{home?:object, away?:object, confirmed?:boolean}|null,  // layers.lineups.fixtureData[id]
 *   predictedHome?:object|null, predictedAway?:object|null,            // aggregatePredictedXI 产物
 *   injuriesLayer?:object|null,                                        // layers.injuries.fixtureData[id]
 *   newsLayer?:object|null,                                            // layers.news.fixtureData[id]
 *   homeForm?:object|null, awayForm?:object|null,                      // wc-national-form.recentForm 产物
 * }} input
 */
/** 全网赛前情报伤停(web-intel 缓存)→ 中文 + 来源标注;媒体报道可追溯到 URL=✅实测,🔶存疑项保留原标记。 */
export function resolveWebInjuries(items, sources) {
  if (!Array.isArray(items) || !items.length) return null;
  const text = items.map((i) => `${i.team}:${i.name}${i.status ? `(${i.status})` : ""}`).join(" ║ ");
  const note = sources?.length ? `\n〔来源:${sources.length}处赛前媒体(详见"情报来源"列);🔶为媒体存疑项,非官方确认〕` : "";
  return { tag: INTEL_TAG.REAL, count: items.length, players: items, text: text + note, source: "全网赛前媒体(非官方)" };
}

/** "X胜Y平Z负" → 积分/场均分(纯展示派生,无则 null,不编造)。 */
function parseRecordPoints(record) {
  const m = String(record ?? "").match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return null;
  const w = Number(m[1]), d = Number(m[2]), l = Number(m[3]);
  const games = w + d + l;
  if (!games) return null;
  return { w, d, l, games, ppg: Math.round(((w * 3 + d) / games) * 100) / 100 };
}

/**
 * 主客情报对位研判(2026-06-15 情报增强):把已组装的逐维情报压成一句"谁信息更全/状态更好/阵型怎么碰",
 * 严守铁律——纯展示层,只对位已有情报,**绝不进任何概率**,缺的维度标⚠️缺不编。
 * 维度: ①首发情报确定度(✅已确认>🔶预测>⚠️缺) ②近期状态场均分(双方真赛果ppg) ③阵型对位(姿态) ④伤停分边。
 * @param {object} intel buildMatchIntel 组装中的对象(home/away/injuries 已就位)
 */
export function buildIntelComparison(intel) {
  const H = intel.home, A = intel.away;
  const rank = (t) => (t === INTEL_TAG.REAL ? 2 : t === INTEL_TAG.INFER ? 1 : 0);
  const lh = H.lineup, la = A.lineup;
  const dh = rank(lh.tag), da = rank(la.tag);
  const lineupEdge = (dh === 0 && da === 0)
    ? { tag: INTEL_TAG.MISS, text: "双方首发均未取到(标缺)" }
    : { tag: (dh === 2 && da === 2) ? INTEL_TAG.REAL : INTEL_TAG.INFER,
        text: `首发 主${lh.status}/客${la.status}${dh !== da ? `(${dh > da ? "主" : "客"}方信息更确定)` : ""}` };

  const ph = parseRecordPoints(H.recentForm.record), pa = parseRecordPoints(A.recentForm.record);
  const formEdge = (ph && pa)
    ? (() => { const diff = Math.round((ph.ppg - pa.ppg) * 100) / 100;
        return { tag: INTEL_TAG.REAL, homePpg: ph.ppg, awayPpg: pa.ppg, diff,
          text: `近期场均分 主${ph.ppg} vs 客${pa.ppg}${Math.abs(diff) >= 0.5 ? `(${diff > 0 ? "主" : "客"}状态更佳·差${Math.abs(diff)})` : "(状态接近)"}` }; })()
    : { tag: INTEL_TAG.MISS, text: "近期状态对比不全(一方或双方近赛缺)" };

  let tacticalNote = null;
  if (lh.formation && la.formation) {
    const pH = formationPosture(lh.formation), pA = formationPosture(la.formation);
    if (pH && pA) {
      const desc = (p) => (p.attacking ? "压上(真三前锋)" : p.defensive ? "低位防守(5后卫)" : "均衡");
      tacticalNote = { tag: (lh.tag === INTEL_TAG.REAL && la.tag === INTEL_TAG.REAL) ? INTEL_TAG.REAL : INTEL_TAG.INFER,
        text: `阵型对位 主${pH.raw}·${desc(pH)} vs 客${pA.raw}·${desc(pA)}` };
    }
  }

  let injuryNote = null;
  const inj = intel.injuries;
  if (inj?.players?.length && inj.players[0]?.team) {
    const cnt = {};
    for (const p of inj.players) if (p.team) cnt[p.team] = (cnt[p.team] ?? 0) + 1;
    injuryNote = { tag: INTEL_TAG.REAL, text: `伤停分边:${Object.entries(cnt).map(([t, c]) => `${t}${c}人`).join("、")}` };
  } else if (inj?.tag === INTEL_TAG.REAL && inj.count) {
    injuryNote = { tag: INTEL_TAG.REAL, text: `伤停共${inj.count}条(源未分边)` };
  }

  // 攻防对比(✅,依据统计层场均进失)+ 状态动量对比(🔶)
  let statEdge = null;
  const hs = intel.home?.stats?.stats, as = intel.away?.stats?.stats;
  if (hs && as) {
    const atkDiff = Math.round((hs.gfPer - as.gfPer) * 100) / 100;
    statEdge = { tag: INTEL_TAG.REAL, atkDiff, text: `攻防 主进${hs.gfPer}失${hs.gaPer} vs 客进${as.gfPer}失${as.gaPer}${Math.abs(atkDiff) >= 0.5 ? `(${atkDiff > 0 ? "主" : "客"}火力更强)` : ""}` };
  }
  let momentumEdge = null;
  const hm = intel.home?.stats?.momentum, am = intel.away?.stats?.momentum;
  if (hm && am) momentumEdge = { tag: INTEL_TAG.INFER, text: `状态 主${hm.streak}·${hm.trend} vs 客${am.streak}·${am.trend}` };

  const dims = [lineupEdge, formEdge, statEdge, momentumEdge, tacticalNote, injuryNote].filter((x) => x && x.tag !== INTEL_TAG.MISS);
  return {
    tag: dims.length ? ((lineupEdge.tag === INTEL_TAG.REAL && formEdge.tag === INTEL_TAG.REAL) ? INTEL_TAG.REAL : INTEL_TAG.INFER) : INTEL_TAG.MISS,
    lineupEdge, formEdge, statEdge, momentumEdge, tacticalNote, injuryNote,
    text: dims.length ? dims.map((x) => `${x.tag}${x.text}`).join(" ║ ") : "⚠️缺(暂无可对位的情报维度)",
    note: "🔶情报维度对位研判,展示层不进任何概率(铁律:打不过市场不融合);缺维标缺不编",
  };
}

export function buildMatchIntel(input) {
  const fx = input.fixture ?? {};
  const ls = input.lineupSide ?? null;
  const web = input.webIntel ?? null; // D:\football-model-data\intel\web-intel-<date>.json 的该场对象
  const webInj = web ? resolveWebInjuries(web.injuries, web.sources) : null;
  const intel = {
    match: `${fx.homeTeam ?? "?"} vs ${fx.awayTeam ?? "?"}`,
    home: {
      lineup: resolveLineupSide(ls?.home ?? null, input.predictedHome ?? null),
      recentForm: resolveRecentForm(input.homeForm ?? null),
    },
    away: {
      lineup: resolveLineupSide(ls?.away ?? null, input.predictedAway ?? null),
      recentForm: resolveRecentForm(input.awayForm ?? null),
    },
    // 伤停:优先全网赛前媒体真实情报(免费结构化源对国家队为空墙时);无则退回采集层 injuries。
    injuries: webInj ?? resolveInjuries(input.injuriesLayer ?? null),
    // 新闻/战意:优先 web 综合(🔶含分析),无则退回 GDELT/motivation。
    news: web?.news ? { tag: INTEL_TAG.INFER, text: web.news, source: "全网赛前媒体综合", articles: [] } : resolveNews(input.newsLayer ?? null),
    // 扩展情报维度(全网公开赛前情报,展示层不进概率):交锋史/小组形势/球队风格·关键球员·主帅/场地天气/盘口/来源。
    web: web ? {
      h2h: web.h2h ?? null, group: web.group ?? null, style: web.style ?? null,
      venue: web.venue ?? null, odds: web.odds ?? null, sources: web.sources ?? [],
    } : null,
  };
  // ── 情报统计层(2026-06-15 最大范围增强):从已采真实数据派生多维统计,纯展示不进概率 ──
  const kdate = fx.matchDateTime ?? fx.date ?? fx.kickoff ?? null;
  const injPlayers = intel.injuries?.players ?? [];
  const injOf = (teamName) => injPlayers.filter((p) => !p.team || p.team === teamName); // 有 team 字段按队分,无则全给(保守)
  const sideStats = (formObj, predicted, teamName) => {
    const stats = formStats(formObj);
    return {
      stats,                                              // ✅近期进失/胜率/BTTS/大球/零封
      split: homeAwaySplit(formObj),                      // ✅主客场拆分
      momentum: formMomentum(formObj),                    // 🔶状态动量/连续态
      profile: attackDefenseProfile(stats),              // 🔶攻防画像
      congestion: scheduleCongestion(formObj, kdate),    // 🔶赛程密度/疲劳
      stability: lineupStability(predicted),             // 🔶预测XI稳定度/轮换风险
      availability: lineupAvailability(predicted?.xi, injOf(teamName)), // 🔶关键缺阵
    };
  };
  intel.home.stats = sideStats(input.homeForm ?? null, input.predictedHome ?? null, fx.homeTeam);
  intel.away.stats = sideStats(input.awayForm ?? null, input.predictedAway ?? null, fx.awayTeam);
  // 交锋史深化:仅在结构化 h2h 列存在时统计;只有文本→标缺(绝不从文本编造数字)
  intel.h2hStats = h2hStats(input.h2hList ?? null);

  // 整场情报成熟度:几项真实可追溯(用于 banner 统计 / 排序,不做下注建议)
  const realBits = [
    intel.home.lineup.tag === INTEL_TAG.REAL, intel.away.lineup.tag === INTEL_TAG.REAL,
    intel.home.recentForm.tag === INTEL_TAG.REAL, intel.away.recentForm.tag === INTEL_TAG.REAL,
    intel.injuries.tag === INTEL_TAG.REAL,
  ].filter(Boolean).length;
  intel.maturity = realBits; // 0..5
  intel.comparison = buildIntelComparison(intel); // 主客情报对位研判(2026-06-15,纯展示不进概率)
  return intel;
}
