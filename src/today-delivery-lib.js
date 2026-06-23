// 输出层单写者收敛(2026-06-10 缺陷#5#7#8#12#16#17#20):
//   xlsx(20列专业版)+ 手机页(核心7列点开看全部)+ 英文固定URL页(football.html)
//   三面渲染的唯一真相源。所有"今日交付"脚本一律经 scripts/today-full-coverage.mjs → 本库,
//   旧旁路写者(today-*/render-today-mobile 等多套并行生成器)已于 2026-06-15 全部摘除,出表唯一路径=today-full-coverage.mjs。
// 纯函数,不碰 fs —— 可单测(日期必传/banner真计数/审计背书缺文件不写/双日期三面一致)。

// 决策辅助层(2026-06-16:把 honest-pass-gate/分歧雷达/组合凯利/精选 4 个原 test-only 模块产品化进交付,消灭僵尸)。
//   全为纯函数·零 fs·基于真回测实证常量,只标注不替用户弃赛(守 feedback_confidence_not_autosuppress)。
import { honestPass } from "./honest-pass-gate.js";
import { rankByDivergence } from "./market-divergence-radar.js";
import { assessPortfolioRisk } from "./portfolio-kelly.js";
import { selectHighConfidence } from "./selective-picks.js";
import { riskScore } from "./risk-score.js";
import { jointUpsetBreakdown } from "./upset-trap-detector.js";
import { handicapReferenceRows, ouReferenceRows, europeanBand, ouBand, waterSanity, sanityVerdictLabel } from "./handicap-sanity.js";
import { handicapResultBand, htResultBand, teamGoalsBand, htGoalsBand, anomalyVs, depthLabel, depthBin, handicapResultReferenceRows, extendedDepthReferenceRows } from "./extended-market-bands.js";
import { assessStrengthVsMarket, ppgOf } from "./strength-market-match.js";
import { assessMatchOdds, payoutVerdict } from "./odds-value-lib.js";
import { bookmakerIntent } from "./bookmaker-intent.js";
import { comboTriggers, RULES as COMBO_RULES } from "./combo-triggers.js";
import { synthesize } from "./cross-market-synthesizer.js";
import { playerDisplay } from "./player-name-zh.js";
import { formationPosture } from "./lineup-source.js";

// ── 日期解析:显式参数必须合法,缺参用本机 UTC+8 当日;非法直接 throw(fail-loud,绝不猜) ──
export function resolveDeliveryDate(arg, now = new Date()) {
  if (arg != null && arg !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      throw new Error(`日期参数非法:"${arg}"(要求 YYYY-MM-DD)。拒绝猜测日期,不出表。`);
    }
    return arg;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// ── 各赔种真实填充计数(缺陷#8:banner 分子用实数,绝不写 N/N 假全覆盖) ──
// 判定依据 = 渲染串里的 ✅ 真盘标记(euroStr/hcStr/ouRealStr/scoreMktStr/hfMktStr/asianStr 只在真有数据时打 ✅)。
export function buildOddsFillCounts(rows) {
  const has = (s) => /✅/.test(String(s ?? ""));
  return {
    total: rows.length,
    euro: rows.filter((r) => has(r.euro)).length,
    handicap: rows.filter((r) => /✅500让球/.test(String(r.hc ?? ""))).length,
    score: rows.filter((r) => has(r.scoreMkt)).length,
    halffull: rows.filter((r) => has(r.hfMkt)).length,
    ou: rows.filter((r) => /✅500总进球/.test(String(r.ouReal ?? ""))).length,
    asian: rows.filter((r) => has(r.asian)).length,
  };
}

// ── 市场输入降级显著标注(缺陷#12:odds.xml失败/大小球缺/外盘401 → 不打✅,banner 明示) ──
export function buildDegradeNote(counts, covMissing) {
  const n = counts.total;
  const gaps = [];
  if (counts.euro < n) gaps.push(`欧赔缺${n - counts.euro}场`);
  if (counts.handicap < n) gaps.push(`让球赔率缺${n - counts.handicap}场`);
  if (counts.score < n) gaps.push(`比分盘缺${n - counts.score}场`);
  if (counts.halffull < n) gaps.push(`半全场盘缺${n - counts.halffull}场`);
  if (counts.ou < n) gaps.push(`大小球缺${n - counts.ou}场`);
  if (counts.asian < n) gaps.push(`亚盘(外盘)缺${n - counts.asian}场`);
  if (covMissing) gaps.push("近5/H2H/画像整层未补全(coverage缺)");
  if (!gaps.length) return "";
  return `⚠️市场输入降级:${gaps.join("、")}——缺口逐格已标⚠️未打✅,缺就标缺不冒充。`;
}

// ── banner 赔率覆盖段(逐赔种实数) ──
export function buildOddsCoverageLine(counts) {
  const n = counts.total;
  return `欧赔${counts.euro}/${n}·让球${counts.handicap}/${n}·比分${counts.score}/${n}·半全场${counts.halffull}/${n}·大小球${counts.ou}/${n}(500竞彩真盘实数)+亚盘${counts.asian}/${n}(DK+titan007双源)`;
}

// ════════════════════════════════════════════════════════════════════════════
// 2026-06-11 渲染层升级(用户裁决,最高优先):
//   ① 世界杯模型先验透明列组(Elo先验/confedAdj/场馆λ/出线夺冠%)——归属"世界杯模型",
//      与市场锚列(足球大模型)并排,两模型贡献一眼分清;非WC场标"—"。
//   ② 让球方向列=模型真实裁决(handicapWld argmax),可与胜平负不同向;不同向时格内注逻辑
//      (修订旧"四列同向"铁律:让球列放行真实裁决,胜负平/比分/半全场三列仍同向)。
//   ③ 串关安全度三级(信心档+risk+证伪标签);只标注不替用户弃赛。
//   ④ 数据审计工作表(场×数据维度矩阵,每格=值+来源+抓取时间+三标签)+ 内容审计区。
// 全部纯函数,不碰 fs,可单测。
// ════════════════════════════════════════════════════════════════════════════

// ── ① 世界杯模型先验透明列组(仅世界杯场;缺哪项标哪项,绝不编) ──
export function wcPriorCells({ isWc, prior, lambdaCtx, wcLine }) {
  if (!isWc) return { elo: "⚠️非世界杯场缺(俱乐部联赛无国家队Elo先验,胜负平由每日大模型给)", lambda: "—", tourney: "—" };
  let elo;
  if (prior?.probabilities) {
    const p = prior.probabilities;
    const adj = Number(prior.confedAdj) || 0;
    const ha = Number(prior.homeAdv) || 0;
    const sgn = (v) => `${v >= 0 ? "+" : ""}${v}`;
    elo = `主${Math.round(p.home * 100)}%/平${Math.round(p.draw * 100)}%/客${Math.round(p.away * 100)}%(eloDiff${sgn(prior.eloDiff)}·洲际校正confedAdj${sgn(adj)}${ha ? `·东道主+${ha}` : ""})✅Elo底座`;
  } else {
    elo = "⚠️Elo先验缺(任一队不在48强Elo名单,标缺不编)";
  }
  let lambda;
  if (lambdaCtx?.isWC) {
    const v = lambdaCtx.venue;
    lambda = `×${lambdaCtx.lambdaMult}${v ? `(${v.city}·海拔${v.altitude_m}m${v.indoor ? "·恒温顶棚" : ""})` : ""}${lambdaCtx.factors?.length ? `｜${lambdaCtx.factors.join("；")}` : ""}`;
  } else {
    lambda = "⚠️场馆λ缺(世界杯上下文未解析)";
  }
  return { elo, lambda, tourney: wcLine || "⚠️超算json缺(出线/夺冠%未算)" };
}

// ── ② 让球方向·模型真实裁决(handicapWld argmax;与胜平负不同向时注逻辑) ──
export function handicapVerdictParts({ line, wldCode, wldLabel, hw, marketDist, lineReal = true, stale = false }) {
  if (!hw?.pickCode) return { text: "⚠️让球真实裁决缺(无让球三态分布)", sameDir: null, note: null, verdict: null, modelPct: null, marketPct: null };
  // 2026-06-13 铁律(用户三次重申"不许冒充·我要下注"):竞彩官方让球线未抓到时,过盘%只能按推断线算=不可信。
  //   按 feedback_no_fallback_absolute=标缺不冒充:本场不出让球过盘数字,绝不用推断线盖✅500冒充真实裁决。
  if (!lineReal) {
    return {
      text: "⚠️竞彩官方让球线未抓到→本场不出让球(让/受让后胜平负)分析(让球赔率✅500在,具体线以竞彩App实际为准;绝不用推断线冒充真实让球裁决)",
      sameDir: null, note: "line-missing", verdict: null, modelPct: null, marketPct: null, lineReal: false,
    };
  }
  const L = Number(line) || 0;
  const absL = Math.abs(L);
  const lineStr = L > 0 ? `受让+${L}` : L < 0 ? `让${L}` : "平手";
  const mKey = { "3": "home", "1": "push", "0": "away" }[hw.pickCode];
  const modelPct = Math.round((hw.probability ?? hw.probabilities?.[mKey] ?? 0) * 100);
  const marketPct = marketDist && Number.isFinite(marketDist[mKey]) ? Math.round(marketDist[mKey] * 100) : null;
  const sameDir = hw.pickCode === String(wldCode);
  // 让球文字(2026-06-15 用户裁决):不用"过盘/走盘",改主队视角"让N球后/受让N球后 胜·平·负"。
  //   pickCode 3=主队让(受让)后胜 · 1=让球后平(走盘退款) · 0=主队让(受让)后负(客队赢盘)。
  const hcSide = L < 0 ? "让" + absL + "球后" : L > 0 ? "受让" + absL + "球后" : "";
  const pickPhrase = { "3": `${hcSide}胜`, "1": `${hcSide}平`, "0": `${hcSide}负` }[hw.pickCode] ?? hw.pick;
  let note = null;
  if (!sameDir) {
    if (wldCode === "3" && L < 0) {
      note = hw.pickCode === "1" ? `主胜但最可能恰好只赢${absL}球→让球后打平(平)` : `主胜但难净胜${absL}球→让${absL}球后负(客队受让后胜)`;
    } else if (wldCode === "0" && L > 0) {
      note = hw.pickCode === "1" ? `客胜但最可能恰好只赢${absL}球→受让后打平(平)` : `客胜但难净胜${absL}球→主队受让${absL}球后胜`;
    } else {
      note = `胜平负主推${wldLabel ?? "—"},让球盘(${lineStr})按比分分布真实裁决=${pickPhrase}——让球问"让/受让后的胜平负"非直接"谁赢",两问可不同向`;
    }
  }
  // 模型 vs 市场过盘分歧旗标(2026-06-14 用户审计抓出:同向场也可能模型/市场差很大却不警告)。
  //   回测铁律「分歧越大市场越准」(见 reference_signal_backtest_findings)→ ≥15pp 强制标"以市场为准·勿当胆",
  //   不分同向/不同向。典型:科特迪瓦vs厄瓜多尔 让球客胜 模型51% vs 市场16%(35pp)= 模型高估,押冷门。
  const divergePp = marketPct != null ? Math.abs(modelPct - marketPct) : null;
  const divergeFlag = (divergePp != null && divergePp >= 15)
    ? `\n⚠️模型与市场让球分歧${divergePp}pp(模型${modelPct}%/市场${marketPct}%)——「分歧越大市场越准」以市场为准,模型该盘勿当胆`
    : "";
  // stale:官方线本次空抓、保留的上次真线(2026-06-16 裁决A)——明确标"可能过时",诚实不冒充实时。
  const staleTag = stale ? `\n⚠️上次捕获(可能过时):本次500未刷出官方让球线,沿用上次真线〔${lineStr}〕,以竞彩App实际为准` : "";
  const text = `${pickPhrase} ${modelPct}%(模型)${marketPct != null ? ` vs ${marketPct}%(市场)` : "(市场赔率⚠️缺)"}〔${lineStr}〕${sameDir ? "·与胜平负同向" : `\n⚠️与胜平负不同向:${note}`}${divergeFlag}${staleTag}`;
  return { text, sameDir, note, verdict: hw.pick, modelPct, marketPct, lineStr, divergePp, stale: !!stale };
}

// ── 盘口为主(2026-06-15 用户裁决):500竞彩 1X2(europeanOdds)de-vig 真盘口共识 = 主推/信心/注金的主口径,模型只附参考。──
//   返回真盘口的胜平负 de-vig 分布 + 热门方向/概率/赔率;1X2 未开售(europeanOdds 缺)→ null(调用方退让球档)。
export function marketWldPrimary(snapshot) {
  const e = snapshot?.europeanOdds?.current;
  if (!e || !Number.isFinite(e.home) || !Number.isFinite(e.draw) || !Number.isFinite(e.away)) return null;
  const ss = 1 / e.home + 1 / e.draw + 1 / e.away;
  const dist = { home: (1 / e.home) / ss, draw: (1 / e.draw) / ss, away: (1 / e.away) / ss };
  const entries = [["3", "home", e.home], ["1", "draw", e.draw], ["0", "away", e.away]]
    .map(([code, key, odds]) => ({ code, key, odds, prob: dist[key] }))
    .sort((a, b) => b.prob - a.prob);
  return { ...entries[0], dist, overround: ss };
}

// ── ③ 串关安全度(信心档+risk+证伪标签 三级;只标注供搭串参考) ──
export function parlaySafety({ tier, risk, advLabel }) {
  const t = String(tier ?? ""), a = String(advLabel ?? "");
  if (/硬币/.test(t)) return { grade: "⛔", text: "⛔串关排除(硬币场·势均无真优势)" };
  if (/证伪/.test(a)) return { grade: "⛔", text: "⛔串关排除(三视角对抗证伪场)" };
  const why = [];
  if (!/一档|二档/.test(t)) why.push(`信心档不足(${t || "档位缺"})`);
  if (String(risk ?? "") === "高") why.push("risk=高");
  if (!a) why.push("证伪未覆盖该场");
  if (!why.length) return { grade: "🟢", text: "🟢串关候选(一/二档·非高风险·未被证伪)" };
  return { grade: "🟡", text: `🟡谨慎(${why.join("·")})` };
}
export const PARLAY_ORDER_NOTE = "串关安全度三级:🟢可串=一/二档+非高风险+证伪未杀;🟡谨慎=档位/风险/审计覆盖任一不足;⛔别串=硬币场或三视角证伪场。";

// ── H2H 渲染:新版本地49k历史库对象({source,label,meetings})+ 旧版 ESPN 数组兼容;库无记录如实标⚠️ ──
//   2026-06-16 诚实修正:库无记录 ≠ "已查证真零交锋"。49k库覆盖有限(如法国-塞内加尔2002世界杯交手过却未收),
//   故措辞改为"库无记录·未独立核实",不冒充"已查证"(守 feedback_no_fabrication_live_only)。
export function renderH2hCell(h2h, homeZh) {
  if (!h2h) return "⚠️未取到";
  if (Array.isArray(h2h)) {
    return h2h.length ? h2h.map((x) => `${x.date} ${homeZh}${x.gf}-${x.ga}(${x.res})`).join(" / ") : "近赛季窗口无交锋(ESPN免费源限近赛季)";
  }
  const ms = Array.isArray(h2h.meetings) ? h2h.meetings : [];
  if (!ms.length) return `⚠️本地49k历史库无交锋记录·未独立核实(真零交锋 或 库未收,如法/塞2002交手过未收)〔${h2h.source ?? "源缺"}〕`;
  const flip = (score) => { const m = String(score).match(/(\d+)-(\d+)/); return m ? `${m[2]}-${m[1]}` : score; };
  const view = ms.slice(0, 4).map((m) => {
    const homeFirst = !h2h.homeEn || m.home === h2h.homeEn;
    const sc = homeFirst ? m.score : flip(m.score);
    return `${m.date} ${homeZh}${sc}(${m.resForFixtureHome ?? "—"}·${m.tournament ?? ""}${m.neutral ? "·中立" : ""})`;
  }).join(" / ");
  return `${view}${ms.length > 4 ? ` 等${ms.length}次` : ""} ${h2h.label ?? (h2h.source ? `✅${h2h.source}` : "")}`;
}

/**
 * 结构化H2H → intel-stats.h2hStats 可消费的"主队视角{score}"列(2026-06-15:填补"结构化交锋统计"空缺)。
 * 兼容两形态:①数组(ESPN,{gf,ga}=主队视角直接用) ②{meetings}(本地49k历史库,按 homeEn 定向、客先则flip)。
 * 全来自真实赛果(✅),无可解析交锋→null(调用方标缺,绝不编)。
 */
export function h2hToStatsList(h2h) {
  if (!h2h) return null;
  if (Array.isArray(h2h)) {
    const list = h2h.filter((x) => Number.isFinite(x.gf) && Number.isFinite(x.ga))
      .map((x) => ({ date: x.date ?? null, score: `${x.gf}-${x.ga}` }));
    return list.length ? list : null;
  }
  const ms = Array.isArray(h2h.meetings) ? h2h.meetings : [];
  if (!ms.length) return null;
  const flip = (s) => { const m = String(s).match(/(\d+)-(\d+)/); return m ? `${m[2]}-${m[1]}` : null; };
  const list = ms.map((m) => {
    const homeFirst = !h2h.homeEn || m.home === h2h.homeEn;
    const sc = homeFirst ? String(m.score) : flip(m.score);
    return sc && /\d+-\d+/.test(sc) ? { date: m.date ?? null, score: sc } : null;
  }).filter(Boolean);
  return list.length ? list : null;
}

// ── 亚盘双源渲染(DK+titan007 并存;口径分歧以 titan007 即时盘为准并注明) ──
export function renderAsianDualCell(ah) {
  const t7 = ah?.titan007, dk = ah?.dk;
  const fmtT7 = (l, txt) => `${Number(l) > 0 ? `主让${l}` : Number(l) < 0 ? `主受让${Math.abs(l)}` : "平手"}(${txt ?? ""})`;
  const parts = [];
  if (t7?.live) {
    parts.push(`titan007即时 ${fmtT7(t7.live.line, t7.live.lineText)} 水主${t7.live.homeWater}/客${t7.live.awayWater}(初盘${fmtT7(t7.init?.line, t7.init?.lineText)}·${t7.companiesCount ?? "?"}家·主参${t7.primaryCompany?.name ?? "—"})✅titan007`);
  }
  if (dk?.line != null) {
    parts.push(`DK ${dk.line} 主${dk.homeOdds}/客${dk.awayOdds}${dk.openLine && dk.openLine !== dk.line ? `(开${dk.openLine}→异动)` : ""} ✅${dk.source ?? "ESPN/DraftKings"}`);
  }
  if (!parts.length) return "⚠️未取到(DK/titan007双源均缺)";
  let div = "";
  if (t7?.live && dk?.line != null) {
    const dkHomeGive = -parseFloat(dk.line); // DK 负=主让 → 转 titan007 口径(正=主让)
    if (Number.isFinite(dkHomeGive) && Math.abs(dkHomeGive - Number(t7.live.line)) > 1e-9) {
      div = `\n⚠️双源口径分歧(DK主让${dkHomeGive} vs titan007主让${t7.live.line})——以titan007即时盘为准(抓取${String(t7.fetchedAt ?? "").slice(0, 16) || "?"}Z)`;
    }
  }
  return parts.join(" ｜ ") + div;
}

// ── 欧赔外盘参考(竞彩未开售场;🔶仅方向参考,非可投注口径) ──
export function renderEuroRefCell(euroRef) {
  if (!euroRef?.value) return null;
  const v = euroRef.value;
  return `🔶外盘百家平均 ${v.home}/${v.draw}/${v.away}(titan007 ${euroRef.companies ?? "?"}家·竞彩未开售仅方向参考,非可投注口径)`;
}

// ── 三列同向自检(胜负平/比分/半全场;让球列按 2026-06-11 新口径放行真实裁决,不再纳入硬约束) ──
export function threeColumnCoherence(rows) {
  const dirWld = (s) => { if (/未开售/.test(String(s))) return null; const m = String(s).match(/(主胜|平局|客胜)/); return m ? m[1] : null; };
  const dirScore = (s) => { const m = String(s).match(/(\d+)\s*-\s*(\d+)/); if (!m) return null; const h = +m[1], a = +m[2]; return h > a ? "主胜" : h < a ? "客胜" : "平局"; };
  const dirHf = (s) => { const m = String(s).match(/(主胜|平局|客胜)-(主胜|平局|客胜)/); return m ? m[2] : null; };
  let checked = 0, skipped = 0; const violations = [];
  for (const r of rows) {
    const w = dirWld(r.wld), sc = dirScore(r.score), hf = dirHf(r.halffull);
    if (!w || !sc || !hf) { skipped++; continue; }
    checked++;
    if (w !== sc || w !== hf) violations.push(`${r.match}:胜负平=${w}/比分=${sc}/半全场=${hf}`);
  }
  return { checked, skipped, violations, ok: violations.length === 0 };
}

// ── ④ 数据审计工作表(场×维度矩阵 + 内容审计区) ──
// ── 四玩法独立真实裁决(2026-06-11 用户裁决,取代"四列同向"显示锁):
//    胜负平=模型综合;让球=模型vs市场过盘真实裁决(0610口径);比分/半全场=各自500盘口de-vig真实热门(✅市场)主推,
//    模型方向一致视图退居次行。方向可不同向但每个不同向必须带依据;绝不为"看起来独特"人造分歧——
//    盘口与胜负平真同向时如实标"同向共振"。内部真钱管线(validatePredictionConsistency 核 wldConsistent)零改动。 ──
const SCORE_DIR = (score) => { const m = String(score).match(/^(\d+)\s*-\s*(\d+)$/); if (!m) return null; const a = +m[1], b = +m[2]; return a > b ? "3" : a === b ? "1" : "0"; };
export const DIR_LABEL = { "3": "主胜", "1": "平局", "0": "客胜" };
const FT_DIR = (hf) => { const ft = String(hf ?? "").split("-")[1]?.trim(); return ft === "主胜" ? "3" : ft === "平局" ? "1" : ft === "客胜" ? "0" : null; };

export function marketScoreView(p) {
  const sp = p.scorePicks ?? {};
  const md = Array.isArray(sp.marketDistribution) && sp.marketDistribution.length ? sp.marketDistribution : null;
  const wld = p.pick?.code != null ? String(p.pick.code) : null;
  if (!md) return { fromMarket: false, dir: null, sameAsWld: null, cell: null, basis: "比分盘未开售/模板盘弃用→退模型DC矩阵🔶" };
  const top = md.slice(0, 3);
  const dir = SCORE_DIR(top[0].score);
  const sameAsWld = wld != null && dir != null ? dir === wld : null;
  const fmt = (d) => `${d.score}(${Math.round(d.probability * 100)}%)`;
  // 方向一致比分(2026-06-22 修「说胜却推荐1-1」误解):比分盘里方向==胜负平、概率最高的那格——
  //   顺胜负平方向买比分时选它,避免"看好主胜但比分给1-1"读成矛盾。
  const sameDir = wld != null ? md.filter((d) => SCORE_DIR(d.score) === wld).sort((a, b) => b.probability - a.probability)[0] : null;
  const wldName = wld != null ? DIR_LABEL[wld] : "?";
  let tail;
  if (sameAsWld === false) {
    // 诠释清楚:单一最可能比分(可平局) ≠ 最可能结果(胜负平);两者并存不矛盾,并给顺方向比分。
    tail = ` ｜ ⚠️不是矛盾:这是「单一最可能比分」=${top[0].score}(均势盘平局格单格最高);胜负平看好${wldName}是因为各种${wldName}比分概率加起来更大。`
      + (sameDir ? `要顺${wldName}方向买比分→选 ${fmt(sameDir)}。` : `(盘口暂无明显${wldName}方向比分格。)`);
  } else if (sameAsWld) {
    tail = " ·与胜负平同向共振(主推比分方向=胜负平方向,放心顺买)";
  } else {
    tail = "";
  }
  const cell = `盘口主推 ${top.map(fmt).join(" / ")} ✅500比分盘de-vig` + tail;
  return { fromMarket: true, dir, sameAsWld, cell, basis: "500比分盘de-vig真实众数", top, wld, sameDir: sameDir ?? null, sameDirScore: sameDir?.score ?? null };
}

export function marketHalfFullView(p) {
  const hp = p.halfFullPicks ?? {};
  const md = Array.isArray(hp.marketDistribution) && hp.marketDistribution.length ? hp.marketDistribution : null;
  const wld = p.pick?.code != null ? String(p.pick.code) : null;
  if (!md) return { fromMarket: false, dir: null, sameAsWld: null, cell: null, basis: "半全场盘未开售/模板盘弃用→退模型半场联合矩阵🔶" };
  const top = md.slice(0, 3);
  const dir = FT_DIR(top[0].halfFull);
  const sameAsWld = wld != null && dir != null ? dir === wld : null;
  const fmt = (d) => `${d.halfFull}(${Math.round(d.probability * 100)}%)`;
  // 方向一致半全场(同比分修法):终场方向==胜负平、概率最高那格,顺方向买半全场选它。
  const sameDir = wld != null ? md.filter((d) => FT_DIR(d.halfFull) === wld).sort((a, b) => b.probability - a.probability)[0] : null;
  const wldName = wld != null ? DIR_LABEL[wld] : "?";
  let tail;
  if (sameAsWld === false) {
    tail = ` ｜ ⚠️不是矛盾:这是「单一最可能半全场」=${top[0].halfFull}(单格最高);胜负平看好${wldName}是因为${wldName}各半全场格概率加起来更大。`
      + (sameDir ? `要顺${wldName}方向买半全场→选 ${fmt(sameDir)}。` : `(盘口暂无明显${wldName}方向格。)`);
  } else if (sameAsWld) {
    tail = " ·与胜负平同向共振(主推终场方向=胜负平方向)";
  } else {
    tail = "";
  }
  const cell = `盘口主推 ${top.map(fmt).join(" / ")} ✅500半全场盘de-vig` + tail;
  return { fromMarket: true, dir, sameAsWld, cell, basis: "500半全场盘de-vig真实众数", top, wld, sameDir: sameDir ?? null, sameDirHalfFull: sameDir?.halfFull ?? null };
}

// 信号面板:只用本次实抓证据拼装(欧赔初→现、亚盘开→现+水位、竞彩让球盘de-vig、大小球),阵容未出如实标⚠️。
//   共振/背离判定措辞诚实:欧赔答"谁赢"、亚盘/让球盘答"过不过盘",两问不同向≠矛盾,标"赢球与过盘分离"。
export function buildSignalPanel({ euroCur, euroIni, asian, hcDist, ouLine, lineupKnown = false }) {
  const parts = []; const dirs = {};
  if (euroCur && [euroCur.home, euroCur.draw, euroCur.away].every((x) => Number.isFinite(Number(x)))) {
    const cur = { "3": Number(euroCur.home), "1": Number(euroCur.draw), "0": Number(euroCur.away) };
    const fav = Object.entries(cur).sort((a, b) => a[1] - b[1])[0][0];
    dirs.euro = fav;
    let move = "";
    if (euroIni && Number.isFinite(Number(euroIni.home))) {
      const ini = { "3": Number(euroIni.home), "1": Number(euroIni.draw), "0": Number(euroIni.away) };
      const d = cur[fav] - ini[fav];
      move = Math.abs(d) >= 0.01 ? (d < 0 ? `·热门${DIR_LABEL[fav]}水位压入(${ini[fav]}→${cur[fav]},资金进)` : `·热门${DIR_LABEL[fav]}水位走高(${ini[fav]}→${cur[fav]},资金出)`) : "·初现持平";
    }
    parts.push(`欧赔:热门=${DIR_LABEL[fav]}${move}`);
  } else parts.push("欧赔:⚠️未开售");
  if (asian && asian.line != null) {
    const lean = Number(asian.homeOdds) < Number(asian.awayOdds) ? "主" : "客";
    const moved = asian.openLine != null && String(asian.openLine) !== String(asian.line);
    dirs.asianLean = lean === "主" ? "3" : "0";
    parts.push(`亚盘:让${asian.line}${moved ? `(开${asian.openLine}→现${asian.line}·盘口异动)` : "(开盘未动)"}·水位偏${lean}(主${asian.homeOdds}/客${asian.awayOdds})`);
  } else parts.push("亚盘:⚠️未取到");
  if (hcDist && hcDist.home != null) {
    const lean = hcDist.home > hcDist.away ? "3" : "0";
    dirs.hcLean = lean;
    parts.push(`竞彩让球盘:让球后资金偏${DIR_LABEL[lean] === "主胜" ? "主" : "客"}(主让球后胜${Math.round(hcDist.home * 100)}%/客受让后胜${Math.round(hcDist.away * 100)}%)`);
  } else parts.push("竞彩让球盘:⚠️缺");
  if (ouLine) parts.push(ouLine);
  let verdict = "";
  if (dirs.euro && dirs.hcLean) {
    if (dirs.euro === dirs.hcLean && (!dirs.asianLean || dirs.asianLean === dirs.euro)) {
      verdict = `🟣三盘共振${DIR_LABEL[dirs.euro]}(欧赔/亚盘/让球盘同侧)`;
    } else {
      // 精确点名分歧腿(不笼统):逐盘列方向,谁背离一眼可见
      const side = (d) => (d === "3" ? "主" : d === "0" ? "客" : "平");
      const segs = [`欧赔热门=${side(dirs.euro)}`];
      if (dirs.asianLean) segs.push(`亚盘水位偏${side(dirs.asianLean)}`);
      segs.push(`让球盘资金偏${side(dirs.hcLean)}`);
      verdict = `🟠盘口信号分歧:${segs.join(" / ")}——欧赔答"谁赢"、亚盘/让球盘答"让(受让)后的胜平负",分歧=赢球难赢盘信号,玩法间方向不同有据`;
    }
  }
  parts.push(lineupKnown ? "阵容:✅已出(已按首发重算)" : "阵容:⚠️未公布(开赛前~1h LineupWatch自动按首发重分析推送)");
  if (verdict) parts.push(verdict);
  return { text: parts.join(" ‖ "), dirs, verdict };
}

// 方向矩阵审计:四玩法方向逐场列出;任何与胜负平不同向的格必须带依据(basis),无依据=FAIL(拒交付)。
export function directionMatrixAudit(entries) {
  const lines = []; const errors = [];
  for (const e of entries) {
    const cells = [];
    for (const m of e.markets) {
      cells.push(`${m.name}=${m.dirLabel ?? "—"}${m.sameAsWld === false ? `(不同向·依据:${m.basis || "❌缺依据"})` : ""}`);
      if (m.sameAsWld === false && !m.basis) errors.push(`${e.match}:${m.name}与胜负平不同向但无依据`);
    }
    lines.push(`${e.match}:胜负平=${e.wldLabel ?? "—"} ｜ ${cells.join(" ｜ ")}`);
  }
  return { ok: errors.length === 0, lines, errors };
}

// 2026-06-20 用户:审计完整性要覆盖 初盘异动/阵容/伤病红牌(末尾追加3维·保留原12维列序)。
// 这3维=「数据是否真采到」的完整性维度,从行内真实字段(signals)+情报(intelByMatch)派生,缺即标缺不编。
export const AUDIT_DIMENSIONS = ["欧赔", "让球", "比分", "半全场", "大小球", "亚盘DK", "亚盘titan007", "欧赔参考(外盘)", "近5", "H2H", "国际赛画像", "世界杯先验", "初盘异动", "阵容", "伤病红牌"];
export function auditCell(tag, value, src, t) {
  return `${tag} ${value}｜源:${src}｜抓取:${t ?? "时间未记录"}`;
}
// 完整性三维(诚实派生·不编):初盘异动从 signals 欧赔段判初盘是否捕获+异动;阵容/伤病优先取情报真值,缺则标缺。
export function auditCompleteness(r, it) {
  const sig = String(r.signals || "");
  const segs = sig.split("‖").map((s) => s.trim());
  const euroSeg = segs.find((s) => /^欧赔/.test(s)) || "";
  let opening;
  if (/资金进|水位压入|资金出|水位走高|退烧/.test(euroSeg)) opening = `✅实测 初盘已捕获·有异动(${euroSeg.replace(/^欧赔[:：]/, "").trim().slice(0, 40)})｜源:500/ESPN 初→现`;
  else if (/初现持平/.test(euroSeg)) opening = "✅实测 初盘已捕获·无明显移动｜源:500/ESPN 初→现";
  else if (/未开售/.test(euroSeg)) opening = "⚠️缺 欧赔未开售·无初盘可比";
  else opening = "⚠️缺 初盘未捕获→无法判异动/庄家意图(标缺不编·续鲜后可判)";
  const hs = it?.home?.lineup?.status, as = it?.away?.lineup?.status;
  let lineup;
  if (hs || as) {
    const tag = (s) => /确认|官方/.test(String(s)) ? "✅实测" : "🔶推断";
    lineup = `${tag(hs || as)} 主:${hs ?? "⚠️缺"} 客:${as ?? "⚠️缺"}｜源:情报详情(近N场首发频次·官方出转✅)`;
  } else if (/阵容[:：]\s*✅已出/.test(sig)) lineup = "✅实测 首发已出·已按首发重算";
  else if (/阵容[:：]\s*⚠️未公布/.test(sig)) lineup = "⚠️缺 首发未公布·开赛前~1h LineupWatch 按首发重分析";
  else lineup = "⚠️缺 阵容状态未登记";
  const itx = it?.injuries?.text;
  const inj = (itx && !/^⚠️/.test(String(itx)))
    ? `🔶推断 ${String(itx).replace(/\n/g, " ").slice(0, 90)}｜源:全网媒体(见情报详情·非官方确认·不进概率)`
    : "⚠️缺 免费结构化伤停源对国家队为空墙→见情报详情媒体核录列(标缺不编·不进概率)";
  return { "初盘异动": opening, "阵容": lineup, "伤病红牌": inj };
}
export function buildAuditSheet({ date, rows, contentAudit, intelByMatch }) {
  const header = ["#", "对阵", ...AUDIT_DIMENSIONS];
  const body = rows.map((r) => {
    const comp = auditCompleteness(r, intelByMatch?.[r.match] ?? null);
    return [String(r.idx), r.match, ...AUDIT_DIMENSIONS.map((d) => comp[d] ?? r.audit?.[d] ?? "⚠️缺(该维未登记)")];
  });
  const tail = [[""], ["—— 内容审计区(2026-06-11 口径) ——"], ...(contentAudit ?? []).map((x) => (Array.isArray(x) ? x : [x]))];
  return { name: "数据审计", rows: [[`🔍 数据审计 · ${date} · ${rows.length}场×${AUDIT_DIMENSIONS.length}维(每格=三标签+值+来源+抓取时间;末3维=采集完整性)`], header, ...body, ...tail] };
}

// ── 情报详情工作表(2026-06-14 情报系统·展示层,不动概率) ──
// 每场:预测/确认首发XI+阵型 / 关键伤停 / 近期热身赛 / 新闻动机,每格带 ✅实测/🔶推断/⚠️缺 来源标签。
// intelByMatch[`home|away`] = src/match-intel.buildMatchIntel 产物;缺该场 → 整行如实标缺(不编)。
// 阵型态势标签(formationPosture 真解析:N后N中N前→攻势/守势/均衡);无法解析→空串不编。
function postureTag(formation) {
  const p = formationPosture(formation);
  if (!p) return "";
  const t = p.attacking ? "攻势" : p.defensive ? "守势" : "均衡";
  return `(${t}·${p.defenders}后${p.midfielders}中${p.forwards}前)`;
}
// 阵型对位研判(主客 posture 对撞→阵地战/对攻/反击,真解析派生,无则缺)。
function formationMatchup(homeF, awayF) {
  const ph = formationPosture(homeF), pa = formationPosture(awayF);
  if (!ph || !pa) return null;
  const lab = (p) => p.attacking ? "攻" : p.defensive ? "守" : "衡";
  const h = lab(ph), a = lab(pa);
  let read;
  if (h === "攻" && a === "守") read = "主攻客守→主队压上打阵地战·客队摆大巴反击(易闷或被反)";
  else if (h === "守" && a === "攻") read = "主守客攻→客队压上·主队防反";
  else if (h === "攻" && a === "攻") read = "双攻对攻→开放·大球倾向";
  else if (h === "守" && a === "守") read = "双守→闷战·小球倾向";
  else read = "均衡对位→看临场";
  return `主${homeF}(${ph.defenders}后${ph.midfielders}中${ph.forwards}前·${h}) vs 客${awayF}(${pa.defenders}后${pa.midfielders}中${pa.forwards}前·${a})→${read}`;
}
function intelLineupCell(side) {
  if (!side || !side.xi) return "⚠️缺";
  // 2026-06-16 用户:情报详情用中文+细胞级。知名球员转公认中文名+位置中文+逐人首发频次(X/N·铁主力/轮换),生僻保留原文不瞎音译(防编造)。
  const names = side.xi.map((p) => playerDisplay(p, side.n)).join("、");
  const form = side.formation ? ` ${side.formation}${postureTag(side.formation)}` : "";
  const head = `${side.tag} ${side.status}${form}`;
  if (!names) return `${head}(${side.source ?? "无名单"})`;
  const prov = side.status === "预测首发" ? `\n〔${side.source}〕` : (side.source ? `\n〔${side.source}〕` : "");
  return `${head}:${names}${prov}`;
}
const intelCell = (v) => (v == null || v === "" ? "⚠️缺" : String(v));
const intelSourcesCell = (web) => {
  const s = web?.sources ?? [];
  return s.length ? s.map((u, i) => `[${i + 1}] ${u}`).join("\n") : "⚠️缺";
};
export function buildIntelSheet({ date, rows, intelByMatch }) {
  const banner = `🕵️ 情报详情 · ${date} · 细胞级:逐球员预测首发(中文名·位置·近N场首发频次X/N·铁主力/轮换)+阵型态势/对位·伤停停赛/近期战绩多维统计/交锋史/小组形势/球队风格·关键球员·主帅/场地天气/新闻战意/来源(展示层·不动概率·每格带✅实测/🔶推断/⚠️缺)`;
  const header = ["#", "对阵", "主队预测/确认首发(逐人位置·首发频次·阵型态势·稳定度·缺阵)", "客队预测/确认首发(逐人位置·首发频次·阵型态势·稳定度·缺阵)", "关键伤停/停赛",
    "主队近期战绩·统计(进失/胜率/BTTS/大球/主客/动量/攻防/赛程)", "客队近期战绩·统计(进失/胜率/BTTS/大球/主客/动量/攻防/赛程)", "交锋史(H2H深化)", "小组形势/重要性", "球队风格·关键球员·主帅", "场地·天气",
    "新闻·战意/动机", "情报来源(URL)", "情报成熟度", "阵型对位+情报对位研判(🔶不进概率)"];
  const EMPTY = [String, "", "⚠️缺(无情报)", "⚠️缺(无情报)", "⚠️缺", "⚠️缺", "⚠️缺", "⚠️缺", "⚠️缺", "⚠️缺", "⚠️缺", "⚠️缺", "⚠️缺", "0/5", "⚠️缺"];
  // 近期战绩单元格=原始赛果 + 统计层(📊场均进失/胜率/BTTS/大球 🏠主客拆分 📈动量 ⚔️攻防 🗓️赛程),全✅/🔶可追溯
  const formCell = (side) => {
    const parts = [];
    if (side?.recentForm?.text) parts.push(side.recentForm.text);
    const st = side?.stats ?? {};
    if (st.stats?.text) parts.push("📊" + st.stats.text);
    if (st.split?.text) parts.push("🏠" + st.split.text);
    if (st.momentum?.text) parts.push("📈" + st.momentum.text);
    if (st.profile?.text) parts.push("⚔️" + st.profile.text);
    if (st.congestion?.text) parts.push("🗓️" + st.congestion.text);
    return parts.length ? parts.join("\n") : "⚠️缺";
  };
  // 首发单元格=确认/预测XI + 🔄稳定度/轮换风险 + 🚑预测首发疑伤停(名字匹配)
  const lineupPlus = (lineupSide, sideStats) => {
    const base = intelLineupCell(lineupSide);
    const extra = [];
    if (sideStats?.stability?.text) extra.push("🔄" + sideStats.stability.text);
    if (sideStats?.availability?.missingFromXI > 0) extra.push("🚑" + sideStats.availability.text);
    return extra.length ? base + "\n" + extra.join("\n") : base;
  };
  // 交锋史=📊结构化深化统计(有则✅) + 媒体文本;结构化数据缺则标缺不编
  const h2hCell = (it2, w2) => {
    const parts = [];
    if (it2.h2hStats?.text) parts.push("📊" + it2.h2hStats.text);
    if (w2?.h2h) parts.push(w2.h2h);
    if (!it2.h2hStats && w2?.h2h) parts.push("⚠️结构化交锋数据未采集,上为媒体文本");
    return parts.length ? parts.join("\n") : "⚠️缺";
  };
  // 情报综合结论(2026-06-18 用户:情报要给清楚结论)——读对位各维度→偏向哪边+关键看点,纯展示不进概率
  const intelConclusion = (it2) => {
    const c = it2?.comparison;
    if (!c || !c.text || String(c.text).startsWith("⚠️")) return null;
    let h = 0, a = 0; const pts = [];
    if (c.formEdge?.diff != null && Math.abs(c.formEdge.diff) >= 0.3) {
      c.formEdge.diff > 0 ? h++ : a++;
      pts.push(`近期状态${c.formEdge.diff > 0 ? "主队" : "客队"}更佳(场均分差${Math.abs(c.formEdge.diff)})`);
    }
    if (c.statEdge?.atkDiff != null && Math.abs(c.statEdge.atkDiff) >= 0.4) {
      c.statEdge.atkDiff > 0 ? h++ : a++;
      pts.push(`场均火力${c.statEdge.atkDiff > 0 ? "主队" : "客队"}更强`);
    }
    if (c.injuryNote?.text) pts.push(c.injuryNote.text);
    if (c.lineupEdge?.text && /更确定/.test(c.lineupEdge.text)) pts.push(/主.*更确定/.test(c.lineupEdge.text) ? "主队阵容情报更确定(客队存变数)" : "客队阵容情报更确定(主队存变数)");
    if (c.tacticalNote?.text) pts.push(c.tacticalNote.text);
    const lean = h > a ? "情报面整体偏向主队" : a > h ? "情报面整体偏向客队" : "情报面两端大体均衡";
    return `📌情报综合:${lean}。${pts.length ? "主要看点——" + pts.join(";") + "。" : ""}⚠️此为展示层研判,不进胜负平/比分概率(铁律:打不过市场不融合);临场以官方确认阵容为准。`;
  };
  const body = rows.map((r) => {
    const it = intelByMatch?.[r.match] ?? null;
    if (!it) return [String(r.idx), r.match, ...EMPTY.slice(2)];
    const w = it.web ?? null;
    // 阵型对位(formationPosture 真解析派生·细胞级):主客攻防态势对撞→阵地战/对攻/反击,接进对位研判
    const fm = formationMatchup(it.home.lineup?.formation, it.away.lineup?.formation);
    const concl = intelConclusion(it);
    const compText = [concl, fm ? "🎯阵型对位:" + fm : null, it.comparison?.text].filter(Boolean).join("\n") || "⚠️缺";
    return [String(r.idx), r.match,
      lineupPlus(it.home.lineup, it.home.stats), lineupPlus(it.away.lineup, it.away.stats),
      intelCell(it.injuries.text), formCell(it.home), formCell(it.away),
      h2hCell(it, w), intelCell(w?.group), intelCell(w?.style),
      intelCell(w?.venue), intelCell(it.news.text), intelSourcesCell(w), `${it.maturity}/5`,
      compText];
  });
  const tail = [[""],
    ["情报口径", "预测首发=🔶近期真实首发频次聚合(赛前1h官方阵容出即转✅);近期战绩=✅ESPN国际赛真实赛果(含友谊/预选);伤停停赛/交锋史/小组形势/球队风格·主帅/场地天气/新闻战意=全网公开赛前情报(Sports Mole/ESPN/RotoWire/FOX/Goal/Opta/FIFA等),媒体报道·🔶非官方确认,逐条URL见'情报来源'列;🔶为媒体存疑项。免费结构化伤停源对国家队为空墙,故改走全网媒体核录(中文)。"],
    ["铁律", "情报只作展示与研判,绝不进胜负平/比分概率(有市场赔率时融合情报回测净负,违'打不过市场就别装')。缺即标缺,不用默认/中性值冒充;每条可追溯到来源。"],
  ];
  return { name: "情报详情", rows: [[banner], header, ...body, ...tail] };
}

// ── 决策辅助工作表(2026-06-16:4 个原 test-only 模块产品化·全基于真回测实证·只标注不弃赛) ──
//   A 逐场诚实过关闸(honest-pass-gate:把对抗证伪写成确定性 5 条硬伤,零token每日可判·复盘实证落地)
//   B 今日精选(selective-picks:高置信桶≥65%·选择性=真edge,附桶级历史命中参考)
//   C 模型↔市场分歧雷达(market-divergence-radar:Σ|模型−市场|降序,高分歧场置顶供人工复核)
//   D 组合注金相关性闸(portfolio-kelly:同场跨玩法相关簇+全天总暴露上限,纯保护真钱不抬注)
// 入参 rows[].decision = today-full-coverage buildDecisionInput 产物(缺=该场不参与,如实标)。
export function buildDecisionAidsSheet({ date, rows }) {
  const banner = `🧭 决策辅助 · ${date} · 诚实过关闸/今日精选/分歧雷达/组合注金闸(全基于真回测实证·只标注风险,不自动弃赛)`;
  const di = rows.map((r) => r.decision).filter(Boolean);
  if (!di.length) {
    return { name: "决策辅助", rows: [[banner], ["⚠️ 当日无可归一的盘口推荐行(1X2/让球盘口均未开售或缺),决策辅助本次不出(如实不编)。"]] };
  }
  const out = [[banner]];

  // ── A 逐场诚实过关闸 ──
  out.push([]);
  out.push([`【A】逐场诚实过关闸 + 连续风险分(honest-pass-gate 5条硬伤=观望;风险分=市场隐含"这注不中"概率0-100·OOS校准[25531场]·因子只标注不计入分数=不双重计数)`]);
  out.push(["对阵", "推荐方向", "模型概率", "本地EV", "风险分(0-100)", "风险档", "风险驱动(为什么)", "诚实裁决", "硬伤明细(过则空)"]);
  let passN = 0;
  for (const d of di) {
    const hp = honestPass({ prob: d.prob, ev: d.ev, risk: d.risk, competition: d.competition, divergencePp: d.divergencePp, aligned: d.aligned });
    if (hp.pass) passN++;
    // 连续风险分(2026-06-18 工作流A):核心分=市场隐含 pick 不中概率;缺市场→null 如实标
    const rs = riskScore({
      pick: d.pickKey, marketProbs: d.marketProbs, modelProbs: d.modelProbs,
      over25: d.over25, ahLineAbs: d.ahLineAbs, softLeague: d.softLeague,
    });
    out.push([
      d.match, d.dir,
      d.modelProb != null ? `${Math.round(d.modelProb * 100)}%` : (d.marketProb != null ? `盘口${Math.round(d.marketProb * 100)}%(1X2未开售)` : "⚠️缺"),
      d.ev != null ? d.ev.toFixed(4) : "⚠️缺(无赔率无法验证价值)",
      rs ? `${rs.score}` : "⚠️缺(无市场隐含无法量化)",
      rs ? rs.band : (d.risk ?? "⚠️缺"),
      rs && rs.drivers.length ? rs.drivers.map((x) => `${x.tag}(${x.note})`).join(" ｜ ") : "无额外风险旗标",
      hp.verdict,
      hp.failReasons.length ? hp.failReasons.join(" ｜ ") : "—",
    ]);
  }
  // EV 缺值统计(2026-06-18 工作流②):多少注因缺当前赔率无法验证 EV → 覆盖率健康度
  const evMissing = di.filter((d) => d.ev == null).length;
  const evCovPct = di.length ? Math.round((di.length - evMissing) / di.length * 100) : 0;
  out.push([`小结`, `诚实过关 ${passN}/${di.length} 注进推荐池,其余转观望(只标注风险,不自动弃赛)`]);
  out.push([`EV覆盖`, `${di.length - evMissing}/${di.length} 注有当前赔率可验证EV(覆盖率${evCovPct}%)` + (evMissing ? `·${evMissing}注缺赔率无法验证价值(已在EV列标缺·非过关项)` : `·全覆盖`)]);

  // ── B 今日精选 ──
  out.push([]);
  out.push([`【B】今日精选(selective-picks·模型favorite概率≥65%强热门桶;选择性=真edge的产品化,低于门槛≠弃赛=不进精选)`]);
  const sel = selectHighConfidence(di.map((d) => ({ match: d.match, favoriteProb: d.modelProb ?? d.marketProb, pick: d.dir, competition: d.competition })), { minConfidence: 0.65 });
  if (sel.selected.length) {
    out.push(["对阵", "推荐方向", "概率", "桶", "桶级历史命中参考"]);
    for (const s of sel.selected) out.push([s.match, s.pick, `${Math.round(s.favoriteProb * 100)}%`, s.bucket, s.refHit]);
    out.push([`覆盖`, `精选 ${sel.coverage.selected}/${sel.coverage.total} 场(覆盖率${sel.coverage.rate != null ? Math.round(sel.coverage.rate * 100) + "%" : "—"})·只推高桶,代价是覆盖↓`]);
  } else {
    out.push(["—", "今日无模型概率≥65%的精选场(全覆盖天花板~55%,无强热门桶=如实不硬凑精选)"]);
  }

  // ── C 模型↔市场分歧雷达 ──
  out.push([]);
  out.push([`【C】模型↔市场分歧雷达(market-divergence-radar·Σ|模型−市场|降序;实证"分歧越大市场越对"→默认作风险旗标,不反向下注)`]);
  out.push(["对阵", "Σ分歧度", "模型主推", "市场主推", "同向?", "旗标"]);
  const radar = rankByDivergence(di.map((d) => ({ match: d.match, competition: d.competition, modelProbs: d.modelProbs, marketProbs: d.marketProbs })), { threshold: 0.25 });
  const pk = { home: "主胜", draw: "平局", away: "客胜" };
  for (const x of radar) {
    out.push([
      x.match,
      x.hasMarket ? x.divergence.toFixed(3) : "⚠️无市场分布",
      pk[x.modelPick] ?? "—", x.hasMarket ? (pk[x.marketPick] ?? "—") : "—",
      x.agree == null ? "—" : (x.agree ? "同向" : "⚠️背离"),
      x.flagged ? "🟠高分歧·优先人工复核" : (x.hasMarket ? "正常" : "—"),
    ]);
  }

  // ── D 组合注金相关性闸 ──
  out.push([]);
  out.push([`【D】组合注金相关性闸(portfolio-kelly·同场跨玩法=同一赛果驱动的相关簇,逐注下注=同风险重复放大;纯降额保护真钱不抬注)`]);
  const port = assessPortfolioRisk(di.filter((d) => d.stakeUnits != null).map((d) => ({ id: d.match, match: d.match, market: "胜负平/让球主推", stakeUnits: d.stakeUnits })), { perMatchCap: 2.0, totalCap: 10.0 });
  out.push(["全天建议总注(单位)", `${port.totalBefore}U`, "相关性闸调整后", `${port.totalAfter}U`, "基础注", `${100}元/单位档系数`]);
  if (port.warnings.length) for (const w of port.warnings) out.push(["⚠️闸触发", w]);
  else out.push(["闸状态", "未触发(全天总暴露在 10U 内·单场无多玩法相关簇超限);逐注注金见主表💰列"]);
  out.push(["铁律", "只降额不抬注·这是组合风险提示,不是替你弃赛"]);

  // ── E 爆冷风险档(upset-trap-detector·经验基线锚:势均60%/微热门52%/中等热门42%/强热门30%/超级大热18%) ──
  //   实证(reference_data_change_5yr_empirics 33278场+复盘):爆冷不可预测、只可分档管理。中等热门以下=高爆冷区,
  //   单押命中骤降→建议双选/观望(复盘"双选救回8场"即此机理);不反向押冷(逆市命中仅22.7%)。
  const ups = di.filter((d) => d.upset).map((d) => d.upset ? { ...d.upset, match: d.match, dir: d.dir, marketProbs: d.marketProbs } : null).filter(Boolean);
  if (ups.length) {
    out.push([]);
    out.push([`【E】爆冷风险档 + 平局/冷胜联合拆解(upset-trap 经验基线锚 + jointUpsetBreakdown 把"热门不胜"拆成 平局+冷胜·OOS校准[25531场]·drawShare定失败模式→精准玩法指引;不反向押冷)`]);
    out.push(["对阵", "盘口主推", "热门档", "爆冷风险", "档位", "热门不胜拆解(平/冷胜)", "失败模式", "玩法建议"]);
    const advice = (lvl, tier) => {
      const hot = /超级大热|强热门/.test(tier || "");
      if (hot && (lvl === "低" || lvl === "标准")) return "可单押(强热门·爆冷基线低)";
      if (lvl === "高" || /势均|微热门/.test(tier || "")) return "🟠高爆冷区·建议双选(1X/X2)或观望·勿单押";
      return "🟡中爆冷·偏向双选护一手";
    };
    for (const u of ups.sort((a, b) => (b.risk ?? 0) - (a.risk ?? 0))) {
      // 联合拆解(2026-06-18 工作流B):纯市场devig·缺市场则该格标缺不编
      const j = jointUpsetBreakdown(u.marketProbs);
      const breakdown = j ? `不胜${Math.round(j.notWin * 100)}%=平${Math.round(j.draw * 100)}%+冷胜${Math.round(j.dogWin * 100)}%(平占${Math.round(j.drawShare * 100)}%)` : "⚠️无市场分布";
      out.push([u.match, u.dir, u.tier ?? "—", u.risk != null ? `${Math.round(u.risk * 100)}%` : "—", u.level ?? "—", breakdown, j ? j.failureMode : "—", j ? j.guidance : advice(u.level, u.tier)]);
    }
    out.push(["机理", "爆冷不可预测只可分档:复盘实证中等热门以下高发·市场也测不准(逆市无edge)→管理风险而非预测冷门。联合拆解告诉你'不胜'主要来自被逼平还是被翻盘:平占高→双选含平护得住;冷胜占高→平局护不住,要么强信心要么观望。"]);
  }

  return { name: "决策辅助", rows: out };
}

// ── 盘口合理性工作表(2026-06-16 用户重写:逐场写清胜负平/让球胜负平/让球线/欧赔/亚盘水位/大小球的真实赔率数字,
//    对照历史正常区间(直接写赔率数字),判深浅,临界也写数字,不用 P5/P95 黑话)──
//   标准=12458场五大联赛(7季)实测;每场按亚盘线锚定实力档→给同档欧赔正常区间;赔率落区外=过深/过浅。
// 盘口合理性·一句话总结(2026-06-20 用户:简单直白·先严密分析后给直接结论)。
//   核心=实力↔盘口匹配度(独立Elo+近5 vs 盘口定价)→直白说合理/高估热门/低估热门/背离 + 深浅怎么用。
function sanityOneLine(r) {
  const s = r.sanity;
  const svm = r.strengthInputs ? assessStrengthVsMarket(r.strengthInputs) : null;
  const v = svm?.verdict || "";
  let core;
  if (/背离/.test(v)) core = "盘口热门方与纸面实力相反→强烈信号:信市场别逆、谨慎";
  else if (/高估/.test(v)) core = "盘口高估热门(让偏深/价偏低)→热门没Elo那么强,别追热门·受让方或平有值";
  else if (/低估/.test(v)) core = "盘口低估热门(让偏浅)→热门比盘口更强,买热门/让球更稳";
  else if (/匹配|合理/.test(v)) core = "盘口对得起两队实力·定价合理(按盘口正常对待)";
  else core = "缺独立实力源(非48强/非WC)→只能看盘口自洽·标缺不编";
  let depth = "";
  if (s?.verdict === "过深") depth = ";让球偏深=热门要多进球才过盘→受让/爆冷有值·深让别当胆";
  else if (s?.verdict === "过浅") depth = ";让球偏浅=热门更强→直胜稳·贪深让易赢球输盘";
  return core + depth;
}
export function buildHandicapSanitySheet({ date, rows }) {
  const banner = `📐 盘口合理性 · ${date} · 一句话:这场盘口开得正不正常?用 12458 场五大联赛(7季)历史当尺子量。`
    + `\n每场看三件事:①【实力 vs 盘口】先按国家队Elo+近5战算出这两队"该让几球",再对比庄家实际开的盘——一致=合理;庄家让多了=高估热门(冷门有价值);让少了=低估热门。`
    + `\n②【逐玩法量深浅】胜负平/让球/大小球/比分/半全场/亚盘水位 的真实赔率,落在历史正常区间内=🟢正常;比历史最低还低=🔴过浅(热门被高估·让太少);比最高还高=🔴过深;"离临界还差多少"列写明还差几个赔率点踩线。`
    + `\n③【资金动向】亚盘水位偏哪边=钱压谁;开盘→现在盘口怎么移动(历史:被加注的热门56.4%赢、退烧的只45.5%·仅方向参考)。`
    + `\n数据标签:✅实测=500/亚盘真盘 · 🔶模型=竞彩不单卖该玩法→用DC矩阵算的 · ⚠️缺=没抓到就标缺、不编。历史频次只帮你判断,不是稳赢点(公开盘口打不过收盘线)。`;
  const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  const dec = (x) => { const v = num(x); return v == null ? "—" : v.toFixed(2); };
  const pc = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
  const rg = (a) => (a ? `${a[0]}–${a[2]}(中${a[1]})` : "—");
  // 热门胜赔深浅:赔率低=热门强=让太少=过浅;赔率高=热门弱=让太多=过深(与热门隐含%口径一致)
  const judgeFav = (val, band) => {
    if (val == null || !band) return { tag: "—", gap: "—" };
    if (val < band[0]) return { tag: "🔴过浅", gap: `本场${val.toFixed(2)} 低于历史最低${band[0]}(差${(band[0] - val).toFixed(2)})` };
    if (val > band[2]) return { tag: "🔴过深", gap: `本场${val.toFixed(2)} 高于历史最高${band[2]}(差${(val - band[2]).toFixed(2)})` };
    return { tag: "🟢合理", gap: `本场${val.toFixed(2)} 落在${band[0]}–${band[2]}内` };
  };
  // 三路赔率 de-vig → 隐含%(让球胜负平/半场胜负平用):缺/脏→null 不编
  const devig3 = (o3) => {
    if (!o3) return null;
    const h = num(o3.home), d = num(o3.draw), a = num(o3.away);
    if (!(h > 1 && d > 1 && a > 1)) return null;
    const inv = 1 / h + 1 / d + 1 / a;
    return { home: (1 / h) / inv, draw: (1 / d) / inv, away: (1 / a) / inv };
  };
  const p1 = (x) => Math.round(Number(x) * 1000) / 10;     // 概率→一位小数%
  const sgn = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${x}`);
  // 平赔/冷赔纯描述(非热门方不判深浅)
  const judgePlain = (val, band) => {
    if (val == null || !band) return { tag: "—", gap: "—" };
    if (val < band[0]) return { tag: "偏低", gap: `本场${val.toFixed(2)} 低于最低${band[0]}` };
    if (val > band[2]) return { tag: "偏高", gap: `本场${val.toFixed(2)} 高于最高${band[2]}` };
    return { tag: "区间内", gap: `本场${val.toFixed(2)} 在${band[0]}–${band[2]}` };
  };
  // 7 列(与底部历史总表同宽);列头只在顶部出现一次,配合冻结窗格——区块用 ━━ 分隔,各行对齐顶部列头。
  const colHeader = ["玩法/盘口", "本场真实赔率", "历史正常区间(数字)", "落点深浅", "离临界还差多少", "大白话解读", "数据标签"];
  const SEP = (txt) => [txt, "", "", "", "", "", ""];   // 区段标题行:补满 7 列(首列承载文本)
  const out = [[banner], colHeader];

  for (const r of rows) {
    const o = r.sanityOdds ?? {};
    const s = r.sanity;
    const isModel = /模型/.test(String(r.favProbSource ?? ""));
    const anchor = o.anchorLine ?? o.ahLine ?? o.jcLine;                 // 强度锚=亚盘优先,缺则竞彩让球线兜底
    const eb = europeanBand(anchor);                                     // 欧赔区间(按强度锚档)
    const favHome = o.euro ? num(o.euro.home) <= num(o.euro.away) : (anchor != null ? num(anchor) < 0 : null);
    const jcCell = o.jcLine == null ? "让球线未抓到" : (Number(o.jcLine) === 0 ? "平手(让0)" : `让${o.jcLine}球`);
    const ahCell = o.ahLine == null
      ? (o.anchorIsAsian ? "亚盘线未抓到" : `亚盘未抓到→用竞彩让球线${anchor != null ? (Number(anchor) === 0 ? "(平手)" : `(让${anchor})`) : ""}锚强度`)
      : `${o.ahLine}(主水${dec(o.ahHomeWater)}/客水${dec(o.ahAwayWater)})`;
    out.push(SEP(""));
    out.push(SEP(`━━ ${r.match} ━━　竞彩${jcCell}　｜亚盘 ${ahCell}　｜${favHome == null ? "热门方未定" : favHome ? "主队=热门" : "客队=热门"}`));
    out.push(SEP(`📌一句话:${sanityOneLine(r)}`));

    // ① 胜负平 / 欧洲赔率(让0直胜)
    if (o.euro) {
      const homeBand = eb ? (favHome ? eb.win : eb.dog) : null;
      const awayBand = eb ? (favHome ? eb.dog : eb.win) : null;
      const drawBand = eb ? eb.draw : null;
      const noBand = eb ? "—" : "⚠️亚盘线无对应历史档·不硬套";
      const jh = (favHome ? judgeFav : judgePlain)(num(o.euro.home), homeBand);
      const jd = judgePlain(num(o.euro.draw), drawBand);
      const ja = (favHome ? judgePlain : judgeFav)(num(o.euro.away), awayBand);
      out.push([`胜负平·主胜(欧洲${favHome ? "·热门" : "·冷门"})`, dec(o.euro.home), homeBand ? rg(homeBand) : noBand, jh.tag, jh.gap, favHome ? "主队=热门:赔率比历史更低→让太少(过浅)、更高→让太多(过深)" : "主队=冷门方·参照同档冷赔", "✅实测500欧赔"]);
      out.push([`胜负平·平局(欧洲)`, dec(o.euro.draw), drawBand ? rg(drawBand) : noBand, jd.tag, jd.gap, "平赔偏低=市场看高平局概率", "✅实测500欧赔"]);
      out.push([`胜负平·客胜(欧洲${favHome ? "·冷门" : "·热门"})`, dec(o.euro.away), awayBand ? rg(awayBand) : noBand, ja.tag, ja.gap, favHome ? "客队=冷门方·参照同档冷赔" : "客队=热门:赔率更低→让太少(过浅)、更高→过深", "✅实测500欧赔"]);
    } else {
      out.push([`胜负平·欧洲赔率`, "⚠️1X2未开售(悬殊盘只卖让球)", eb ? `同档热门胜${rg(eb.win)}/平${rg(eb.draw)}/客${rg(eb.dog)}` : "—", "—", "—", "1X2未开售→无直胜赔可比,下行用模型热门隐含仅参考", "⚠️缺"]);
    }

    // ② 热门隐含胜率(综合深浅裁决·盘口合理性核心)
    if (s && s.band) {
      const vCell = `${pc(s.favProb)}${isModel ? "·🔶模型" : "·✅盘口de-vig"}`;
      const verdict = (isModel ? "🔶仅参考·" : "") + sanityVerdictLabel(s).tag;
      const gap = s.exceeded
        ? `热门隐含${pc(s.favProb)} ${s.verdict === "过深" ? `低于正常下限${pc(s.band.p5)}` : `高于正常上限${pc(s.band.p95)}`} ${s.gapPp}个百分点`
        : `落在${pc(s.band.p5)}–${pc(s.band.p95)}内`;
      out.push([`热门隐含胜率(综合裁决)`, vCell, `${pc(s.band.p5)}–${pc(s.band.p95)}(中${pc(s.band.p50)})·N=${s.band.n}`, verdict, gap,
        isModel ? "1X2未开售·模型估非盘口·仅参考" : s.verdict === "合理" ? "盘口与历史同强度常态一致" : s.verdict === "过深" ? "让球比该强度该有的深→受让方/爆冷有值" : "让球比该有的浅→热门更强·受让方过盘易",
        isModel ? "🔶模型" : "✅盘口de-vig"]);
    } else if (s) {
      out.push([`热门隐含胜率(综合裁决)`, `${pc(s.favProb)}${isModel ? "·🔶模型" : ""}`, "无该线≥30样本历史档", "—", "—", "该让球线历史样本不足·不硬套", isModel ? "🔶模型" : "✅盘口"]);
    } else {
      out.push([`热门隐含胜率(综合裁决)`, "—", "—", "⚠️缺", "—", "缺亚盘线或1X2隐含·不判(不编)", "⚠️缺"]);
    }

    // ②b 独立实力对比 + 实力↔盘口匹配度(2026-06-18 用户:不能只看盘口自洽·要先独立实力对比再判盘口是否匹配·合理)
    //   实力=✅纯Elo先验(独立于盘口)+✅ESPN近5;换算"实力应得让球线/胜率" vs 盘口实际→匹配=合理/高估/低估/方向背离。
    const svm = r.strengthInputs ? assessStrengthVsMarket(r.strengthInputs) : null;
    if (svm) {
      const ep = r.strengthInputs.eloProb;
      const eloFavZh = svm.eloFavSide === "home" ? "主队" : "客队";
      const hp = svm.homePpg, ap = svm.awayPpg;
      const formStr = (hp != null && ap != null) ? `近5场均分 主${hp}/客${ap}${svm.formAgreesElo === false ? "(⚠️与Elo强弱相反)" : ""}` : "近5场均分缺";
      // 行1:独立实力基准(不看盘口)
      out.push([`实力对比(独立·不看盘口)`,
        `Elo先验 主胜${p1(ep.home)}%/平${p1(ep.draw)}%/客胜${p1(ep.away)}%(eloDiff${svm.eloDiff >= 0 ? "+" : ""}${svm.eloDiff})`,
        `${formStr}`, "—", "—",
        `✅WC国家队Elo(独立于盘口)+ESPN近5真实战绩=纸面实力基准;${eloFavZh}为实力热门(胜率${p1(svm.eloFavProb)}%)`,
        "✅实测Elo+✅ESPN近5"]);
      // 行2:实力↔盘口匹配度裁决(本块结论·回答"盘口给的是否合理")
      const expCell = `实力应得≈让${svm.eloFairLine ?? "—"}球·热门胜率${p1(svm.eloFavProb)}%`;
      const mktCell = `盘口实际让${svm.marketLineAbs ?? "—"}球·热门隐含${svm.marketFavProb != null ? p1(svm.marketFavProb) + "%" : "—"}`;
      const diffCell = `${svm.probGapPp != null ? `胜率${sgn(svm.probGapPp)}pp` : ""}${svm.lineGap != null ? `${svm.probGapPp != null ? "·" : ""}让球${sgn(svm.lineGap)}球` : ""}` || "—";
      out.push([`🎯实力↔盘口匹配度(是否合理)`, `${expCell}　VS　${mktCell}`, "实力基准 vs 盘口定价", svm.verdict, diffCell, svm.read, "✅Elo+✅盘口·诚实:分歧时市场通常更准不鼓励逆市"]);
    } else if (r.strengthInputs === null || r.strengthInputs === undefined) {
      out.push([`🎯实力↔盘口匹配度(是否合理)`, "⚠️Elo先验缺(非48强名单/非WC)→无法独立实力对比", "—", "—", "—", "无独立实力源·标缺不编(不拿盘口自我循环冒充实力判断)", "⚠️缺"]);
    }

    // ③ 让球胜负平(竞彩=亚洲让球·2026-06-18 用户:补合理区间):实测赔率→de-vig隐含% vs 该让球线历史真实赛果频次→异动
    const hcpImp = devig3(o.hcp);
    const hrb = handicapResultBand(o.jcLine);
    if (o.hcp && hcpImp && hrb) {
      const lh = p1(hcpImp.home), ld = p1(hcpImp.draw), la = p1(hcpImp.away);
      const aH = anomalyVs(lh, hrb.homeWin), aD = anomalyVs(ld, hrb.draw), aA = anomalyVs(la, hrb.awayWin);
      const worst = [aH, aD, aA].reduce((b, x) => Math.abs(x.deltaPp ?? 0) > Math.abs(b.deltaPp ?? 0) ? x : b);
      out.push([`让球胜负平·竞彩${jcCell}(亚洲让球)`,
        `主${dec(o.hcp.home)}/平${dec(o.hcp.draw)}/客${dec(o.hcp.away)}\n→隐含 让球主胜${lh}%/平${ld}%/客胜${la}%(✅de-vig)`,
        `历史 让球主胜${hrb.homeWin}%/平${hrb.draw}%/客胜${hrb.awayWin}%(N=${hrb.n})`,
        worst.tag, `主${sgn(aH.deltaPp)}/平${sgn(aD.deltaPp)}/客${sgn(aA.deltaPp)}pp`,
        `竞彩让球后胜平负实测隐含 vs 该让球线历史真实赛果频次;偏离≥8pp=异动(本场该向被定价偏离常态·值得多看)`,
        "✅实测500让球+✅真实赛果频次"]);
    } else if (o.hcp) {
      out.push([`让球胜负平·竞彩${jcCell}(亚洲让球)`, `主${dec(o.hcp.home)}/平${dec(o.hcp.draw)}/客${dec(o.hcp.away)}`,
        hrb ? `历史 让球主胜${hrb.homeWin}%/平${hrb.draw}%/客胜${hrb.awayWin}%(N=${hrb.n})` : "该让球线无≥30历史样本·不硬套",
        "仅列值", "—", "让球赔率在但无法de-vig(脏/不全)或无该线历史频次", "✅实测500让球"]);
    } else {
      out.push([`让球胜负平·竞彩(亚洲让球)`, "⚠️让球赔率未抓到", "—", "—", "—", "缺·不编", "⚠️缺"]);
    }

    // ④ 大小球 2.5(竞彩de-vig隐含%·给同档历史over/under赔参照,不做深浅裁决)
    const ob = ouBand(o.over25);
    if (o.over25 != null) {
      out.push([`大小球2.5`, `大${pc(o.over25)}/小${pc(o.under25)}(竞彩de-vig隐含)`, ob ? `该档over赔${rg(ob.over)}·under中${ob.underMid}(N=${ob.n})` : "—", "参考", o.over25 >= 0.55 ? "偏大球档" : o.over25 <= 0.45 ? "偏小球档" : "中性档", "本场为竞彩总进球de-vig隐含%(非原始over/under赔)→只给同档历史赔率参照", "✅实测500总进球"]);
    } else {
      out.push([`大小球2.5`, "⚠️总进球未抓到", "—", "—", "—", "缺·不编", "⚠️缺"]);
    }

    // ④b 扩展玩法合理区间+异动(2026-06-18 用户:分队进球数/半场胜负平/半场进球数也要区间+异动)
    //   强度档锚=亚盘线优先(缺退竞彩让球线);历史=12458场真实赛果频次(✅);本场=✅实测优先,竞彩不单卖→🔶DC矩阵派生(注明)。
    const anchorDepth = o.anchorLine;
    const favIsHome = favHome !== false;       // 历史频次分热门/非热门;favHome null 时默认主队=热门(1X2通常在·罕见误标)
    const ext = o.ext;
    const tg = teamGoalsBand(anchorDepth);
    // 主/客 进球数大小(进≥2球·over1.5):🔶DC矩阵边际 vs 同强度档历史真实频次
    const teamGoalRow = (sideName, sideKey) => {
      const tgm = ext?.teamGoals?.[sideKey];
      const liveP = tgm ? p1(tgm.over15) : null;
      const sideIsFav = (sideKey === "home") === favIsHome;
      const histP = tg ? (sideIsFav ? tg.favOver15 : tg.dogOver15) : null;
      if (liveP == null || histP == null) {
        return [`${sideName}进球≥2(over1.5)`, liveP != null ? `🔶模型${liveP}%` : "⚠️无矩阵", tg ? `历史${histP}%(${depthLabel(tg.bin)})` : "无强度档样本", "—", "—", "竞彩不单卖分队进球→🔶DC矩阵派生(缺则标缺不编)", liveP != null ? "🔶模型+✅真实频次" : "⚠️缺"];
      }
      const an = anomalyVs(liveP, histP);
      return [`${sideName}进球≥2(over1.5)`, `🔶模型${liveP}%`, `历史${histP}%(${depthLabel(tg.bin)}·${sideIsFav ? "热门" : "非热门"}方·N=${tg.n})`, an.tag, `${sgn(an.deltaPp)}pp`, `竞彩不单卖分队进球→🔶DC矩阵边际派生 vs 同强度档真实频次,偏离≥8pp=异动`, "🔶模型派生+✅真实频次"];
    };
    out.push(teamGoalRow("主队", "home"));
    out.push(teamGoalRow("客队", "away"));
    // 半场胜负平:✅500半全场de-vig边际优先,缺退🔶矩阵firstHalf;vs 同强度档历史真实HTR频次
    const htb = htResultBand(anchorDepth);
    const htLive = o.htResult ? { ...o.htResult, real: true } : (ext?.firstHalf ? { home: ext.firstHalf.home, draw: ext.firstHalf.draw, away: ext.firstHalf.away, real: false } : null);
    if (htLive && htb) {
      const lf = p1(favIsHome ? htLive.home : htLive.away), ldr = p1(htLive.draw), llo = p1(favIsHome ? htLive.away : htLive.home);
      const aF = anomalyVs(lf, htb.favWin), aDr = anomalyVs(ldr, htb.draw), aL = anomalyVs(llo, htb.favLoss);
      const worst2 = [aF, aDr, aL].reduce((b, x) => Math.abs(x.deltaPp ?? 0) > Math.abs(b.deltaPp ?? 0) ? x : b);
      out.push([`半场胜负平(${htLive.real ? "✅实测半全场" : "🔶模型矩阵"})`,
        `半场 热门胜${lf}%/平${ldr}%/热门负${llo}%`,
        `历史 热门胜${htb.favWin}%/平${htb.draw}%/负${htb.favLoss}%(${depthLabel(htb.bin)}·N=${htb.n})`,
        worst2.tag, `胜${sgn(aF.deltaPp)}/平${sgn(aDr.deltaPp)}/负${sgn(aL.deltaPp)}pp`,
        `半场平局占比天然高(常0-0);强度越高半场热门越易领先;${htLive.real ? "✅500半全场盘de-vig边际" : "🔶DC矩阵半场λ派生(竞彩无独立半场胜负平盘)"}`,
        htLive.real ? "✅实测500半全场+✅真实频次" : "🔶模型派生+✅真实频次"]);
    } else {
      out.push([`半场胜负平`, "⚠️半全场盘+模型矩阵均缺", "—", "—", "—", "缺·不编", "⚠️缺"]);
    }
    // 半场进球数(半场大小球·🔶矩阵firstHalf over0.5/1.5 vs 历史真实HT进球频次)
    const hgb = htGoalsBand(anchorDepth);
    if (ext?.firstHalf && hgb && ext.firstHalf.over05 != null) {
      const lo05 = p1(ext.firstHalf.over05), lo15 = p1(ext.firstHalf.over15);
      const a05 = anomalyVs(lo05, hgb.over05), a15 = anomalyVs(lo15, hgb.over15);
      const worst3 = Math.abs(a05.deltaPp ?? 0) >= Math.abs(a15.deltaPp ?? 0) ? a05 : a15;
      out.push([`半场进球数(🔶模型)`, `半场≥1球${lo05}%/≥2球${lo15}%`, `历史≥1球${hgb.over05}%/≥2球${hgb.over15}%(${depthLabel(hgb.bin)}·N=${hgb.n})`,
        worst3.tag, `≥1球${sgn(a05.deltaPp)}/≥2球${sgn(a15.deltaPp)}pp`,
        `竞彩不单卖半场大小球→🔶DC矩阵(半场λ≈0.46×全场)派生 vs 历史真实半场进球频次`, "🔶模型派生+✅真实频次"]);
    } else {
      out.push([`半场进球数`, "⚠️模型矩阵缺", "—", "—", "—", "缺·不编", "⚠️缺"]);
    }

    // ⑤ 亚盘水位(失衡/被重注)——水位近乎与让球线无关(中位≈1.92),深=被重注·失衡=钱压一侧过盘
    const ws = waterSanity(o.ahHomeWater, o.ahAwayWater);
    if (ws && (ws.homeDec != null || ws.awayDec != null)) {
      const b = ws.band;
      out.push([`亚盘水位(主/客)`, `主${ws.homeDec ?? "—"}/客${ws.awayDec ?? "—"}(decimal)`, `正常${b.p5}–${b.p95}(中${b.mid}·N=${b.n})`,
        ws.lean === "均衡" ? "🟢均衡" : "🟠" + ws.lean, ws.gap != null ? `主客水差${ws.gap > 0 ? "+" : ""}${ws.gap}` : "—",
        `水位深(<${b.p5})=该侧被重注赔付低;失衡=资金压低水一侧过盘(亚盘玩家更信);水位本身近乎与让球线无关`, "✅实测亚盘"]);
    } else {
      out.push([`亚盘水位(主/客)`, "⚠️水位未抓到", "—", "—", "—", "缺·不编", "⚠️缺"]);
    }

    // ⑥ 盘口移动(初盘→即时):欧赔热门隐含漂移 + 亚盘线移动 + 经验命中率(被加注56.4%胜/退烧45.5%·5年实证)
    const movParts = [];
    if (o.euro && o.euroInit) {
      const im = (oo) => { const h = num(oo.home), d = num(oo.draw), a = num(oo.away); if (!(h > 1 && d > 1 && a > 1)) return null; const s2 = 1 / h + 1 / d + 1 / a; return { home: (1 / h) / s2, draw: (1 / d) / s2, away: (1 / a) / s2 }; };
      const ii = im(o.euroInit), cc = im(o.euro);
      if (ii && cc) {
        const fk = favHome ? "home" : "away";
        const drift = cc[fk] - ii[fk];
        const tag = drift > 0.02 ? `热门被加注(+${(drift * 100).toFixed(0)}pp)→5年实证该类热门56.4%胜(更可靠)` : drift < -0.02 ? `热门退烧(${(drift * 100).toFixed(0)}pp)→5年实证仅45.5%胜(更危险)` : `欧赔平稳(${(drift * 100).toFixed(0)}pp)`;
        movParts.push(tag);
      }
    }
    if (o.ahLine != null && o.ahLineInit != null && Number(o.ahLine) !== Number(o.ahLineInit)) {
      movParts.push(`亚盘线移动 ${o.ahLineInit}→${o.ahLine}(${Math.abs(o.ahLine) > Math.abs(o.ahLineInit) ? "加深·更笃定" : "收浅·走软"})`);
    }
    const movTag = movParts.length ? "🔶有移动" : "🟢平稳/无初盘";
    out.push([`盘口移动(初盘→即时)`, movParts.length ? movParts.join(" · ") : "无明显移动或无初盘", "经验:被加注热门56.4%胜 vs 退烧45.5%(33278场·弱信号)", movTag, "—",
      "⚠️回测证1X2初→收走势对命中=弱信号/噪声,仅作市场修正方向参考,非下注edge", o.euroInit ? "✅实测初/即时" : "⚠️无初盘"]);

    // ⑦ 跨源交叉验证(竞彩500 vs 国际外盘DraftKings亚盘 + The Odds API大小球)——外盘更接近收盘sharp,分歧=值得多看
    const xParts = [];
    let xDiverge = false;
    if (o.dkAsianLine != null && (o.ahLine != null || o.jcLine != null)) {
      const jcRef = o.ahLine ?? o.jcLine;
      const gap = Math.abs(o.dkAsianLine) - Math.abs(jcRef);
      const dir = Math.abs(gap) < 0.13 ? "一致" : Math.abs(o.dkAsianLine) > Math.abs(jcRef) ? "外盘更深(外盘更看好热门→竞彩受让方或有值)" : "外盘更浅(外盘更看淡热门)";
      if (Math.abs(gap) >= 0.13) xDiverge = true;
      xParts.push(`亚盘线:竞彩${jcRef} vs ${o.dkAsianSrc}${o.dkAsianLine}→${dir}`);
    }
    if (o.intlOverProb != null && o.over25 != null) {
      const gap = o.intlOverProb - o.over25;
      const dir = Math.abs(gap) < 0.04 ? "一致" : gap > 0 ? `外盘更看大球(+${(gap * 100).toFixed(0)}pp)` : `外盘更看小球(${(gap * 100).toFixed(0)}pp)`;
      if (Math.abs(gap) >= 0.04) xDiverge = true;
      xParts.push(`大小球:竞彩大${pc(o.over25)} vs 国际${o.intlOverBooks ?? ""}家大${pc(o.intlOverProb)}→${dir}`);
    }
    if (xParts.length) {
      out.push([`跨源交叉验证(竞彩vs国际外盘)`, xParts.join(" · "), "外盘(DraftKings/The Odds API)更接近收盘sharp;与竞彩分歧=竞彩线或滞后/有值", xDiverge ? "🟠有分歧" : "🟢一致",
        "—", "国际盘与竞彩分歧→受让/大小球方向值得多看一眼(非保证,公开盘仍打不过收盘线)", "✅实测外盘"]);
    }

    // ⑧ 综合盘口裁决(汇总本场各深浅旗标·一眼定性)
    const flags = [];
    if (s?.exceeded) flags.push(`热门隐含${s.verdict}(${s.gapPp}pp)`);
    if (ws && ws.lean !== "均衡") flags.push(ws.lean);
    if (movParts.length) flags.push("盘口有移动");
    if (xDiverge) flags.push("跨源分歧");
    if (o.over25 != null && (o.over25 >= 0.58 || o.over25 <= 0.44)) flags.push(o.over25 >= 0.58 ? "大球档" : "小球档");
    if (svm && svm.severity !== "ok" && svm.severity !== "na") flags.push(svm.verdict.replace(/^[🔴🟠🟢]/, ""));
    const overall = flags.length ? `🟠注意:${flags.join(" · ")}` : "🟢盘口各维度均在历史常态区间内";
    // 综合盘口解读(2026-06-20 用户:说简单通俗·不玄乎·全用数据·最后明确"怎么买+防什么")——短句,一行一个数据结论
    const favSide = favHome == null ? null : (favHome ? "主队" : "客队");
    const favDir = favHome == null ? null : (favHome ? "主胜" : "客胜");
    let drawImp = null;
    if (o.euro && num(o.euro.draw) && num(o.euro.home) && num(o.euro.away)) {
      const ih = 1 / num(o.euro.home), id = 1 / num(o.euro.draw), ia = 1 / num(o.euro.away);
      drawImp = id / (ih + id + ia);
    }
    const cooling = movParts.some((m) => /退烧/.test(m)), heating = movParts.some((m) => /加注/.test(m));
    const read = [];
    if (favSide && s) read.push(`①谁热门:${favSide}热门,盘口给它赢球${pc(s.favProb)}${isModel ? "(🔶模型)" : "(✅盘口)"}。`);
    else if (favSide) read.push(`①谁热门:${favSide}热门(1X2未开售,只卖让球)。`);
    else read.push(`①本场1X2未开售,只卖让球。`);
    if (svm) {
      const sv = svm.severity === "ok" ? "盘口定价对得起实力,合理" : svm.severity === "high" ? "盘口热门跟纸面强队相反→信盘口别信纸面" : svm.verdict.replace(/^[🔴🟠🟢⚠️]/, "");
      read.push(`②实力对得上吗:${sv}(Elo差${sgn(svm.eloDiff ?? 0)})。`);
    }
    if (s && s.band) {
      if (s.verdict === "过浅") read.push(`③让球深浅:偏浅(比同档历史低${s.gapPp}pp)→热门让得少,受让方容易过盘,让球别当胆。`);
      else if (s.verdict === "过深") read.push(`③让球深浅:偏深(比历史高${s.gapPp}pp)→热门要赢得多才过盘,深让别当胆。`);
      else read.push(`③让球深浅:正常(热门隐含${pc(s.favProb)}落在${pc(s.band.p5)}–${pc(s.band.p95)}内)。`);
    }
    if (heating) read.push(`④资金/异动:钱在进热门(被加注)→这类盘5年实证56%胜,偏可靠。`);
    else if (cooling) read.push(`④资金/异动:钱在撤热门(退烧)→这类盘5年实证仅45%胜,偏危险。`);
    else if (ws && ws.lean && ws.lean !== "均衡") read.push(`④资金:亚盘${ws.lean}(钱压低水一侧)。`);
    if (o.over25 != null && o.over25 >= 0.58) read.push(`⑤进球数:偏大球(大球${pc(o.over25)})。`);
    else if (o.over25 != null && o.over25 <= 0.44) read.push(`⑤进球数:偏小球(易闷平,大球仅${pc(o.over25)})。`);
    // 怎么买 + 防什么(明确动作)
    let buy, guard = [];
    if (favDir == null) {
      buy = `本场只卖让球→只能按让球盘热门方向小注,1X2没得直接买。`;
    } else {
      const needDouble = (drawImp != null && drawImp >= 0.27) || (svm && (svm.severity === "high" || svm.severity === "mid")) || xDiverge;
      const handicapWord = s?.verdict === "过浅" ? "让球容易过不了,优先买直胜、别拿让球当胆" : s?.verdict === "过深" ? "深让别单押,想稳就买直胜" : "直胜或让球都可以跟";
      buy = needDouble
        ? `先双选「${favDir}/平」兜一手;敢搏再单押${favDir}直胜。${handicapWord}。`
        : `主推${favDir}直胜,${handicapWord}。`;
    }
    if (drawImp != null && drawImp >= 0.27) guard.push(`防平局(隐含${pc(drawImp)}偏高)`);
    if (s?.verdict === "过浅") guard.push(`防"赢球输盘"(让球过不了)`);
    if (s?.verdict === "过深") guard.push(`防受让方咬住/爆冷`);
    if (cooling) guard.push(`防热门走软(钱在撤)`);
    if (svm?.severity === "high") guard.push(`防盘口背离(纸面强队不一定赢)`);
    if (o.over25 != null && o.over25 >= 0.58) guard.push(`大球场,押小球/闷平要小心`);
    if (xDiverge) guard.push(`竞彩线与外盘有分歧,可能滞后`);
    const verdictText = read.join("\n")
      + `\n✅怎么买:${buy}`
      + `\n⚠️防什么:${guard.length ? guard.join(";") : "无明显需防项,按信心档正常买即可"}`;
    out.push([`综合盘口裁决·本场解读`, overall, "汇总上方各玩法深浅/失衡/移动/跨源旗标", flags.length ? "有异常项" : "常态", "—", verdictText, "—"]);

    // ⑨ 实时核查·异动冷门(2026-06-18 用户:抓异动冷门当参考·必须真实有实质·有异动要给防什么+最大可能指向哪)
    //   数据=本次 web 核查(伤停/H2H克星/Opta超算等,✅可追溯·来源见「情报详情」);缺=如实标缺不编。
    const lc = r.liveCheck;
    if (lc) {
      // 三方对账:系统Elo先验(🔶模型) vs 500市场de-vig(✅) vs Opta超算(✅web,缺则不写)——一眼看"偏离是模型问题还是盘口问题"
      const recon = [
        svm ? `系统Elo ${p1(svm.eloFavProb)}%(🔶)` : null,
        s?.favProb != null ? `市场 ${pc(s.favProb)}(✅)` : null,
        lc.opta != null ? `Opta超算 ${lc.opta}%(✅)` : null,
      ].filter(Boolean).join(" / ") || "—";
      // defend 字段本身是名词(如"平局"),渲染时智能加"防"前缀;"无…"类不加(避免"防无需…"病句)
      const noPrefix = !lc.defend || /^(无|不|没)/.test(lc.defend);
      const defendCol = !lc.defend ? "—" : (noPrefix ? lc.defend : `防${lc.defend}`);
      const defendLine = !lc.defend ? "" : (noPrefix ? `\n🛡️防什么:${lc.defend}。` : `\n🛡️防什么:重点防【${lc.defend}】。`);
      const note = [
        lc.note ?? "",
        defendLine,
        lc.direction ? `\n🎯最大可能指向:${lc.direction}` : "",
      ].filter(Boolean).join("");
      out.push([`🔍实时核查·异动冷门(本次web核查·参考)`, recon, "实力先验 vs 市场 vs Opta超算 三方对账", lc.verdict ?? "—",
        defendCol, note,
        "✅本次web核查(伤停/H2H/Opta·来源见「情报详情」)"]);
    } else {
      out.push([`🔍实时核查·异动冷门(本次web核查·参考)`, "⚠️本场未做web核查或无显著异动", "—", "—", "—",
        "本场无实时核查到的异动/冷门信号(标缺不编;以上方盘口深浅/实力匹配为准)", "⚠️缺/无"]);
    }
  }

  // 全量历史标准区间参照(用户:全写出来·什么区间合理)——每条让球线 胜率+胜/平/客赔 + 大小球区间。
  const refHead = [[""], ["━━ 历史标准区间总表(12458场7季·所有让球线·本场赔率落区外=过深/过浅)━━"]];
  const ref = handicapReferenceRows();
  const ouHead = [[""], ["━━ 大小球(总进球2.5)标准区间 ━━"]];
  const ou = ouReferenceRows();
  // 扩展玩法历史频次参照(2026-06-18:让球胜负平按线 + 半场胜负平/半场进球/分队进球按强度档·全✅真实赛果)
  const hrHead = [[""], ["━━ 让球胜负平 历史频次区间(12458场·按竞彩让球线·真实赛果·本场让球隐含偏离≥8pp=异动)━━"]];
  const hr = handicapResultReferenceRows();
  const exHead = [[""], ["━━ 半场胜负平/半场进球/分队进球 历史频次区间(12458场·按强度档·真实赛果)━━"]];
  const ex = extendedDepthReferenceRows();
  return { name: "盘口合理性", rows: [...out, ...refHead, ...ref, ...ouHead, ...ou, ...hrHead, ...hr, ...exHead, ...ex] };
}

// ── 返还率与盘口动向工作表(2026-06-18:买球者绝对有用·平台从不告诉散户的三件事)──
//   ① 各玩法真实返还率/抽水(Σ(1/赔率)算·亚盘 vs 1X2 抽水差一倍)→ 同样看好押抽水低的长期更划算;
//   ② de-vig(shin)公平价 vs 竞彩开价的价差;③ 初→即时→终盘 热门隐含漂移(33278场实证·弱信号)。
//   全部真实赔率算·缺市场标缺不编(遵 feedback_no_fabrication_live_only)。非下注 edge(公开盘打不过收盘线)。
export function buildOddsValueSheet({ date, rows }) {
  const banner = `💰 返还率与盘口动向 · ${date} · 平台从不告诉散户、却直接决定长期盈亏的三件事:【①返还率/抽水】每玩法 Σ(1/赔率)算真实抽水——同一场押亚盘(抽水~5%)比押1X2(抽水~11%)成本差一倍,同样看好优先押抽水低的玩法;【②公平价】de-vig(Shin)还原真概率→公平赔率,看竞彩开价被"加价"多少;【③初→即时→终盘】热门隐含漂移(33278场实证:被加注热门56.4%胜 vs 退烧45.5%·弱信号仅方向参考)。【④CLV风险】模型方向vs市场共识(同向🟢低/逆市🔴高);【⑤庄家意图研判】竞彩 vs 国际sharp盘(DraftKings/The Odds API)偏离+1X2移动→庄家/公众定价倾向与相对价值方向(sharp最接近真实概率,竞彩偏离方向暴露意图)。✅全部本次真实数据算,缺标缺不编;非下注edge(公开盘打不过收盘线),帮你看清成本/动向/庄家倾向、自行决策。`;
  const pcVig = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const pcPay = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const colHeader = ["对阵/项目", "玩法", "真实返还率", "抽水(成本)", "本场真实赔率", "判读", "数据标签"];
  const SEP = (txt) => [txt, "", "", "", "", "", ""];
  const out = [[banner], colHeader];

  let withData = 0;
  for (const r of rows) {
    const vo = r.valueOdds;
    const a = vo ? assessMatchOdds(vo) : null;
    out.push(SEP(""));
    if (!a || !a.hasData) {
      out.push(SEP(`━━ ${r.match} ━━`));
      out.push(["返还率", "—", "—", "—", "⚠️本场赔率未抓全", "缺·不编(遵不编造铁律)", "⚠️缺"]);
      continue;
    }
    withData++;
    const cheap = a.cheapest, dear = a.dearest;
    const head = `━━ ${r.match} ━━　最划算=${cheap ? cheap.zh + "(抽水" + pcVig(cheap.vig) + ")" : "—"}　｜最贵=${dear ? dear.zh + "(抽水" + pcVig(dear.vig) + ")" : "—"}`;
    out.push(SEP(head));
    // ① 各市场返还率/抽水
    for (const m of a.markets) {
      const v = payoutVerdict(m.payout);
      const cheapMark = cheap && m.key === cheap.key ? "⭐最划算" : (dear && m.key === dear.key && a.markets.length > 1 ? "🔻最贵" : "");
      out.push([m === a.markets[0] ? "返还率·逐玩法" : "", m.zh, pcPay(m.payout), pcVig(m.vig) + (cheapMark ? " " + cheapMark : ""), m.detail ?? "—", `${v.tag}·${v.note}`, "✅实测500/亚盘"]);
    }
    // 抽水价差洞察(同看好换玩法省多少)
    if (cheap && dear && cheap.key !== dear.key) {
      const save = (dear.vig - cheap.vig);
      out.push(["", "💡省成本", "—", `押「${cheap.zh}」比「${dear.zh}」抽水低${pcVig(save)}`, "—", "同样看好同一方向时,选返还率高的玩法长期少交成本", "—"]);
    }
    // ② 公平价 vs 竞彩开价(1X2)
    if (a.fair) {
      const parts = a.fair.map((f) => `${f.zh} 开${f.offered.toFixed(2)}/公平${f.fair.toFixed(2)}`);
      out.push(["公平价对照(de-vig)", "胜平负", "—", "—", parts.join(" · "), "公平价=去抽水后真概率对应赔率;开价普遍低于公平价=被抽水(常态)", "✅Shin de-vig"]);
    }
    // ③ 初→即时→终盘动向
    const mv = a.movement;
    if (mv) {
      out.push(["盘口动向", "初→即时→终盘", "—", "—", `热门隐含 ${mv.openPp.toFixed(1)}% → ${mv.closePp.toFixed(1)}%(${mv.driftPp >= 0 ? "+" : ""}${mv.driftPp.toFixed(1)}pp)`,
        `${mv.dir}·${mv.label}`, mv.stageNote.includes("终盘") ? "✅实测初+终盘" : "✅实测初+即时"]);
    } else {
      out.push(["盘口动向", "初→即时→终盘", "—", "—", "⚠️无初盘/即时对比数据", "缺·不编", "⚠️缺"]);
    }
    // ④ CLV 风险(市场一致性·赛前 CLV 唯一可落地形态):模型方向 vs 市场共识
    const clv = a.clv;
    if (clv) {
      const divCell = Number.isFinite(clv.divergencePp) ? `模型比市场${clv.divergencePp >= 0 ? "高" : "低"}${Math.abs(clv.divergencePp).toFixed(1)}pp` : "模型概率缺";
      out.push(["CLV风险(市场一致性)", clv.aligned ? "同向" : clv.fightLevel, "—", clv.level, divCell, clv.label, "✅模型方向vs市场de-vig(赛前代理)"]);
    } else {
      out.push(["CLV风险(市场一致性)", "—", "—", "—", "缺模型方向或1X2赔率", "缺·不编", "⚠️缺"]);
    }
    // ⑤ 庄家意图研判(竞彩 vs 国际 sharp 盘偏离 + 1X2 移动 → 庄家/公众定价倾向·相对价值方向)
    const so = r.sanityOdds ?? {};
    const intent = bookmakerIntent({
      euroInit: so.euroInit, euroCur: so.euro,
      jcAhLine: so.ahLine ?? so.jcLine, dkAsianLine: so.dkAsianLine, dkSrc: so.dkAsianSrc,
      jcOver: so.over25, intlOver: so.intlOverProb, intlBooks: so.intlOverBooks,
    });
    if (intent) {
      out.push(["庄家意图研判(综合)", intent.dataStrength, "—", "—", intent.intent, intent.caveat, "✅跨源sharp+500移动"]);
      for (const sg of intent.signals) {
        out.push(["", `· ${sg.type}`, "—", "—", sg.dir, sg.read, ""]);
      }
      if (intent.publicSide) out.push(["", "· 公众side", "—", "—", intent.publicSide, "资金倾向方(赔率被压·价值通常更差)", ""]);
      if (intent.valueHint) out.push(["", "· 相对价值方向", "—", "—", intent.valueHint, "sharp暗示竞彩此侧定价偏离(非保证·公开盘打不过收盘线)", ""]);
    }
  }
  // 返还率常识参照(全局·帮判读合理区间)
  out.push([""], ["━━ 返还率合理区间参照(越高对你越有利·全为真实盘口常见水平)━━"]);
  out.push(["项目", "玩法", "典型返还率", "典型抽水", "说明", "", ""]);
  out.push(["参照", "亚盘让球/大小球", "94–98%", "2–6%", "抽水最低·两路盘竞争充分→最接近公平价(国际sharp盘可达98%)", "", ""]);
  out.push(["参照", "欧赔胜平负(1X2)", "88–95%", "5–12%", "三路盘抽水中等;国际大公司(Pinnacle/Bet365)更高,小公司更低", "", ""]);
  out.push(["参照", "竞彩官方(让球/胜平负)", "≈88–90%(本表实测)", "≈10–12%", "竞彩单玩法盘口抽水偏重;比分/半全场等多路玩法实际返还更低", "", ""]);
  out.push(["铁律", "—", "—", "—", "返还率/抽水是结构性成本,长期决定盈亏;同看好优先押抽水低的玩法。但任何公开盘口都打不过收盘线→不保证盈利。", "", ""]);
  // CLV(收盘价值)监控说明——真 KPI、但受收盘线采集限制,诚实交代现状(遵 feedback_no_fabrication_live_only)。
  out.push([""], ["━━ CLV(收盘价值)说明:衡量下注质量的黄金标准·真KPI ━━"]);
  out.push(["概念", "—", "—", "—", "CLV=你的下注价 vs 收盘价的差(收盘线=有效市场最准概率)。长期正CLV≈你比市场快/准,比单场命中率更能预测长期盈亏。", "", ""]);
  out.push(["现状", "—", "—", "—", "真CLV需采集收盘线(临场封盘价);本系统赔率快照 final(收盘)目前未采集→真CLV暂只能事后算,赛前用上方「CLV风险(市场一致性)」作代理。", "", ""]);
  out.push(["实证基线", "—", "—", "—", "backtest:clv(45788场)实证:纯模型 pick 平均 CLV −0.063%(无独立 edge)·逆市真分歧场 −0.796%(高风险)→ 坐实模型本质市场跟随器,跟随盘口漂移亦是反指(命中41.7%<跟开盘热门52.4%),不作下注 edge。", "", ""]);
  return { name: "返还率与盘口动向", rows: out, _withData: withData };
}

// ── 组合触发工作表(2026-06-22 用户:把所有验证过的交叉组合规律合成引擎,每场自动标触发条)──
//   引擎=src/combo-triggers.js(12458场全7赛季walk-forward挖的高命中组合 + 庄家意图 + 用户让球分线手感,
//   353真竞彩截图独立验证可迁移)。诚实:高命中≠盈利(打不过收盘线),价值=选择性出手把命中率拉到65-78%+标危险盘。
//   全覆盖分档:每场都给;落在高命中组合→高/中信心+主推该市场;无组合→如实"普通·按主表研判"。让球过盘无高命中点(庄家做平)。
export function buildComboTriggerSheet({ date, rows }) {
  const banner = `🎯 交叉组合触发器 · ${date} · 把五大联赛全7赛季12458场回测出的高命中交叉组合 + 庄家意图(退烧热门=坑/加注=可靠) + 用户让球分线手感合成一个引擎。每场明确标:触发了什么数据条件→倾向买方向/比分/半全场。【触发依据只用回测过真有效的4类:①欧赔(热门赔/平赔)②盘口·亚盘让球线③资金动向(初→收盘漂移=加注/退烧)。⚠️亚盘水位单独看是噪声(回测映射1X2命中仅43.8%最差)→不作触发,只在主表信号面板供判读。】【诚实】高命中≠盈利(公开盘打不过收盘线),价值=高把握选择性出手+危险盘避坑;让球过盘被庄家做成≈掷硬币,无高命中组合如实不出。`;
  const tierIcon = { 高: "🟢高", 中: "🟡中", 提醒: "⚠️避坑", 倾向: "·倾向" };
  const pc = (x) => `${Math.round(x * 100)}%`;
  const out = [[banner]];

  // ── 规律速查(2026-06-22 用户:明确"看什么数据触发→倾向买什么")——从引擎 RULES 动态生成,保持同步 ──
  out.push(["📋 规律速查 · 看哪类数据触发 → 倾向买什么(全7赛季12458场回测·TRAIN/TEST双稳)"]);
  out.push(["把握", "触发依据(看哪类数据)", "看到这种盘(具体条件)", "→ 倾向买", "历史命中", "样本N"]);
  const order = { 高: 0, 中: 1, 提醒: 2 };
  const cheatRules = COMBO_RULES.filter((r) => r.tier === "高" || r.tier === "中" || r.tier === "提醒")
    .sort((a, b) => (order[a.tier] - order[b.tier]) || (b.hit.te - a.hit.te));
  for (const r of cheatRules) {
    const buy = r.market === "胜平负" || r.market === "大小球" ? `${r.market}·买【${r.predict}】`
      : r.market === "可靠度" ? "该热门可作胆"
        : r.market === "风险" ? "⚠️这热门别当胆·防爆" : `${r.market}·${r.predict}`;
    out.push([tierIcon[r.tier], r.by ?? "—", r.why, buy, pc(r.hit.te), r.hit.n]);
  }
  out.push(["·提醒", "盘口·亚盘让球过盘", "亚盘让球(让胜/让平/让负)", "庄家做到≈掷硬币·无高命中点→不出(如实)", "≈50%", "—"]);
  out.push([""]);

  // ── 今日逐场落点(2026-06-22 用户:明确触发条件→倾向买方向/比分/半全场·排版要清爽)──
  //   排版纪律:每格尽量 1 行;触发条件压成一行四类值;同方向多条规律合并(命中取区间·依据合集),不堆 4 行。
  out.push(["📍 今日逐场落点 · 明确触发条件 → 倾向买:方向/比分/半全场(每格力求一行·清爽)"]);
  const header = ["对阵", "本场触发条件(实际值·✅实测)", "触发规律→倾向买方向(依据·命中)", "倾向买·比分", "倾向买·半全场", "避坑提醒"];
  out.push(header);
  const dec = (x) => (x == null || !Number.isFinite(Number(x)) ? "—" : Number(x).toFixed(2));
  const byShort = (by) => !by ? "" : by.replace(/\(.*?\)/g, "").replace(/盘口·亚盘让球线|盘口让球线/g, "让球线").replace(/欧赔平赔|欧赔三门/g, "欧赔").replace(/资金动向/g, "资金").replace(/\+/g, "+").trim();
  // 顺方向比分/半全场(✅500盘 de-vig 真实·不同向取 sameDir·同向取 top[0]),一行
  const buyScoreOf = (msv) => {
    if (!msv || !msv.fromMarket) return "🔶看主表(此盘未单卖)";
    const e = msv.sameAsWld === false ? msv.sameDir : msv.top?.[0];
    return e ? `${e.score}(${pc(e.probability)})✅` : "—";
  };
  const buyHfOf = (mhv) => {
    if (!mhv || !mhv.fromMarket) return "🔶看主表(模型半场)";
    const e = mhv.sameAsWld === false ? mhv.sameDir : mhv.top?.[0];
    return e ? `${e.halfFull}(${pc(e.probability)})✅` : "—";
  };
  let firedN = 0;
  for (const r of rows) {
    const so = r.sanityOdds ?? {};
    const valid = (e) => e && [e.home, e.draw, e.away].every((x) => Number(x) > 1);
    // 悬殊盘 500 的 1X2 常未开售→so.euro 缺;按"缺口能补就补"铁律回退 ESPN/DK moneyline 真盘(非编造)。ESPN ml 无开盘价→drift规律诚实不触发。
    const useEspn = !valid(so.euro) && valid(so.euroEspn);
    const euClose = valid(so.euro) ? so.euro : (useEspn ? so.euroEspn : null);
    const euOpen = valid(so.euro) ? so.euroInit : null;
    const t = euClose ? comboTriggers({ euClose, euOpen, ahLineClose: so.ahLine ?? so.jcLine, ahLineOpen: so.ahLineInit ?? null,
      ouClose: so.over25, ouOpen: so.over25Init,
      waterHomeClose: so.ahHomeWater, waterHomeOpen: so.ahHomeWaterInit, waterAwayClose: so.ahAwayWater, waterAwayOpen: so.ahAwayWaterInit }) : null;
    if (!t) { out.push([r.match, "⚠️欧赔+ESPN盘均未抓到(缺不编)", "引擎不触发→看主表方向", buyScoreOf(r.msv), buyHfOf(r.mhv), "—"]); continue; }
    const f = t.features;
    const strong = t.triggers.filter((x) => x.tier === "高" || x.tier === "中");
    const warn = t.triggers.filter((x) => x.tier === "提醒" || x.tier === "倾向");
    if (strong.length) firedN++;
    // ① 触发条件=本场四类数据实际值,压成一行
    const condCell = `热门${f.favHome ? "主" : "客"}${dec(f.favOdds)}·平赔${dec(f.drawOdds)}·亚盘让${f.ahAbs ?? "—"}·资金${f.drift ?? "—"}${useEspn ? "(欧赔ESPN补)" : ""}`;
    // ② 触发规律→买方向:同 predict 多条合并(命中取区间·依据合集),买玩法/可靠分别成行
    const favName = r.msv?.wld != null ? DIR_LABEL[r.msv.wld] : null;
    const byPredict = new Map();
    for (const x of strong.filter((y) => y.market === "胜平负" || y.market === "大小球")) {
      const g = byPredict.get(x.predict) ?? { tier: x.tier, hits: [], bys: new Set() };
      g.hits.push(Math.round(x.hitRate.te * 100)); g.bys.add(byShort(x.by)); byPredict.set(x.predict, g);
    }
    const buyLines = [...byPredict.entries()].map(([predict, g]) => {
      const lo = Math.min(...g.hits), hi = Math.max(...g.hits);
      const hitStr = lo === hi ? `${lo}%` : `${lo}-${hi}%`;
      return `${tierIcon[g.tier]}买【${predict}】${hitStr}(${[...g.bys].join("+")})`;
    });
    if (!byPredict.size && strong.some((x) => x.market === "可靠度") && favName) buyLines.push(`🟡跟主表${favName}·偏可靠可作胆56%(资金加注)`);
    // 历史背书(2026-06-22 用户:触发后89k真赛果最爱出的半全场/大球):取最强触发规律的 hist,热/冷翻成主/客方向
    const topHist = strong.find((x) => x.hist && x.hist.n > 0)?.hist;
    if (topHist && favName) {
      const oppName = favName === "主胜" ? "客胜" : favName === "客胜" ? "主胜" : "平局";
      const trans = (s) => String(s ?? "").split("-").map((p) => p === "热" ? favName : p === "冷" ? oppName : "平局").join("-");
      buyLines.push(`📊89k史(这种盘):半全场爱${trans(topHist.hf)}${topHist.hfPct}%·大球${topHist.over}%·热门命中${topHist.favHit}%`);
    }
    const ruleCell = buyLines.length ? buyLines.join("\n") : (favName ? `无高把握组合→跟主表${favName}(不硬凑)` : "无高把握组合→看主表");
    const warnCell = warn.length ? warn.map((x) => `${tierIcon[x.tier]}${x.market === "风险" ? "别当胆·防爆" : x.predict}(${pc(x.hitRate.te)})`).join("\n") : "—";
    out.push([r.match, condCell, ruleCell, buyScoreOf(r.msv), buyHfOf(r.mhv), warnCell]);
  }
  out.push([""], [`━━ 共${rows.length}场,其中${firedN}场触发高/中命中组合。读法:条件列=本场欧赔/平赔/亚盘让球线/资金动向实际值(✅实测);规律列=触发了哪条→倾向买什么方向(括号=触发依据类别+命中区间);比分/半全场=✅500盘顺方向真实热门。诚实:高命中≠盈利(打不过收盘线),只供选择性出手+避坑;无组合的场如实"看主表"。`]);

  // ── 🎯 无死角·每场三问(2026-06-23 用户:每场都要能回答 看胜负平/看大小球/看让球,优先用五大全7赛季过测高命中口袋)──
  out.push([""], ["🎯 无死角·每场三问 · 看胜负平 / 看大小球 / 看让球(五大联赛12458场过测·只在高命中口袋出手,其余诚实沉默)"]);
  out.push(["对阵", "①看胜负平(方向·命中)", "②看大小球(方向·命中)", "③看让球(过盘)", "防平/看胜负研判"]);
  let fireWld = 0, fireOu = 0;
  for (const r of rows) {
    const so = r.sanityOdds ?? {};
    const valid = (e) => e && [e.home, e.draw, e.away].every((x) => Number(x) > 1);
    const useEspn = !valid(so.euro) && valid(so.euroEspn);
    const euClose = valid(so.euro) ? so.euro : (useEspn ? so.euroEspn : null);
    if (!euClose) { out.push([r.match, "⚠️欧赔未抓到", "⚠️欧赔未抓到", "—", "缺赔率"]); continue; }
    const s = synthesize({ euClose, euOpen: valid(so.euro) ? so.euroInit : null, ahLineClose: so.ahLine ?? so.jcLine, ahLineOpen: so.ahLineInit ?? null,
      ouClose: so.over25, ouOpen: so.over25Init, waterHomeClose: so.ahHomeWater, waterHomeOpen: so.ahHomeWaterInit, waterAwayClose: so.ahAwayWater, waterAwayOpen: so.ahAwayWaterInit });
    if (!s) { out.push([r.match, "—", "—", "—", "—"]); continue; }
    const mk = s.markets;
    const wldCell = mk.胜负平.出手 ? `🎯${mk.胜负平.方向}·${mk.胜负平.命中}${mk.胜负平.条件 ? `(${mk.胜负平.条件})` : ""}` : `沉默·${mk.胜负平.方向}`;
    const ouCell = mk.大小球.出手 ? `🎯${mk.大小球.方向}·${mk.大小球.命中}${mk.大小球.条件 ? `(${mk.大小球.条件})` : ""}` : "沉默·看主表";
    const hCell = mk.让球.结论;
    const drCell = s.drawRisk ? `${s.drawRisk.tier}(估平${Math.round(s.drawRisk.drawRateEst * 100)}%)·${s.drawRisk.direction === "draw-guard" ? "🔴防平" : s.drawRisk.direction === "decisive" ? "🟢看胜负" : "中性"}` : "—";
    if (mk.胜负平.出手) fireWld++;
    if (mk.大小球.出手) fireOu++;
    out.push([r.match, wldCell, ouCell, hCell, drCell]);
  }
  out.push([`━━ 三问出手:胜负平${fireWld}场 / 大小球${fireOu}场 / 让球过盘0场(庄家做平·无高命中口袋·诚实不出手)。深让球盘想玩让球→玩"让球后胜平负的胜"(=热门赢)。命中=五大全7赛季TEST真实双稳值;命中高≠盈利。`]);
  return { name: "组合触发", rows: out };
}

// ── 爆冷研判工作表(2026-06-16 用户:细胞级展开·只接引擎已算的 OOS 验证信号,零臆造)──
//   结构:① 排行榜(一眼看哪场最可能冷·按热门不胜%降序)→ ② 逐场细胞级因子分解(每个爆冷因子=一行:
//   本场读数 + 历史/OOS依据 + 信号方向 + 对玩法的提示)。信号源=diagnoseUpsetRisk/analyzeUpsetTrap/
//   analyzeTotalsMovement/经验库,全部回测/OOS 验证过(见各模块注),诚实 caveat 保留,不替用户弃赛。
export function buildUpsetAnalysisSheet({ date, rows }) {
  const banner = `🎲 爆冷研判 · ${date} · ①排行榜按热门不胜%降序(越高越易冷)②逐场细胞级因子分解。爆冷锚=热门1X2不胜的市场共识概率(最诚实);辅以实力差Elo/让球线深浅(vs同实力档中位)/大小球进球预期/平局隐含(OOS最干净·≥30%→实际31.5%)/大小球走势(唯一z>4真edge:加注→大球63%·退烧→小球44%)/历史同档爆冷率(12458场真赛果)。盘口1X2走势对爆冷=噪声(回测证)仅描述不升档。盘口只上调风险非必爆(瑞典5-1反例),证伪只标注风险。`;
  const pc = (x) => (x == null || !Number.isFinite(Number(x)) ? "—" : Math.round(Number(x) * 100) + "%");
  const isModelOf = (r) => /模型/.test(String(r.favProbSource ?? ""));
  const eloCellOf = (r) => Number.isFinite(r.eloDiff) ? `${r.eloDiff > 0 ? "+" : ""}${r.eloDiff}${r.eloDiff > 0 ? "(主强)" : r.eloDiff < 0 ? "(客强)" : "(均势)"}` : "—";
  // 统一防守建议(与分型同源·消除"强热可胆 vs 别当胆"矛盾·逐场差异化):势均→别当胆;中等→别重注;强热→可胆控注;再叠加过浅/防平
  const guardOf = (r, nw, depth) => {
    const ut = r.upsetDiag?.upsetType ?? "";
    const parts = [];
    if (nw >= 42 || /势均|双向/.test(ut)) parts.push("别当胆·双选含平·串关排除");
    else if (nw >= 28) parts.push("中等热门·别重注当胆·可双选护一手");
    else if (/可胆|低风险|强热/.test(ut)) parts.push("强热·可作胆但控注勿满仓");
    else parts.push("按盘口控注");
    if (depth && depth.includes("过浅")) parts.push("盘口过浅→受让方过盘易·别买深让当胆");
    if (r.drawImpliedPct >= 0.30) parts.push("🔴防平");
    return parts.join("·");
  };
  const ranked = rows
    .map((r) => ({ r, nw: Number.isFinite(r.notWinPct) ? r.notWinPct : -1 }))
    .sort((a, b) => b.nw - a.nw);

  // ── ① 排行榜(9 列;最宽行→writer 以此为列头行,避免整块被当标题合并)──
  const sumHeader = ["排名", "对阵", "热门不胜%", "分型", "实力差Elo", "平局隐含", "历史同档爆冷率", "盘口深浅", "一句话防守"];
  const sumRows = ranked.map(({ r, nw }, i) => {
    const s = r.sanity, d = r.upsetDiag;
    const depth = !s || !s.band ? "—" : sanityVerdictLabel(s).tag;
    const nwCell = nw >= 0 ? `${nw}%${isModelOf(r) ? "·🔶模型" : "·✅盘口"}` : "—";
    const di = r.drawImpliedPct;
    const drawCell = di != null ? `${Math.round(di * 100)}%${di >= 0.30 ? "·🔴防平" : ""}` : "—";
    const hu = r.histLineUpset;
    const huCell = hu != null ? `${Math.round(hu * 100)}%${hu >= 0.45 ? "·🟠高基线" : ""}` : "—";
    const typeCell = d?.upsetType ?? (nw >= 42 ? "🔴双向爆冷(势均)" : nw >= 0 && nw < 22 ? "🟢低风险(强热)" : "中性");
    const guard = guardOf(r, nw, depth);
    const rankTag = i === 0 ? "1·最可能" : i === ranked.length - 1 ? `${i + 1}·最稳` : String(i + 1);
    return [rankTag, r.match, nwCell, typeCell, eloCellOf(r), drawCell, huCell, depth, guard];
  });

  // ── ② 逐场细胞级因子分解 ──
  const SEP = (t) => [t, "", "", "", ""];
  const blkHeader = ["爆冷因子", "本场读数", "历史/OOS依据", "信号方向", "对玩法的提示"];
  const blocks = [];
  ranked.forEach(({ r, nw }, i) => {
    const d = r.upsetDiag, tr = r.upsetTrap, tm = r.totalsMove, s = r.sanity, us = r.upsetData;
    const isModel = isModelOf(r);
    blocks.push(SEP(""));
    blocks.push(SEP(`■ 排名${i + 1} ${i === 0 ? "(最可能爆冷)" : i === ranked.length - 1 ? "(最稳)" : ""}　${r.match}　分型:${d?.upsetType ?? "—"}`));
    blocks.push(blkHeader);

    // 1) 市场共识锚:热门1X2不胜%
    blocks.push(["①热门1X2不胜%(市场共识锚)", nw >= 0 ? `${nw}%${isModel ? "·🔶模型(1X2未开售)" : "·✅盘口de-vig"}` : "⚠️缺",
      "市场对热门不胜的共识概率=最诚实爆冷基准(打不过收盘线)", d?.band ? `档位:${d.band}` : (nw >= 42 ? "高" : nw >= 25 ? "中" : "低"),
      nw >= 42 ? "势均·双选含平·勿当胆" : nw >= 25 ? "中等热门·别重注当胆" : "强热·可作胆但仍控注"]);

    // 2) 实力差 Elo
    blocks.push(["②实力差Elo(WC national-elo真先验)", eloCellOf(r),
      "世界杯模型国家队Elo真实先验·非DC拟合(可追溯)", Number.isFinite(r.eloDiff) ? (Math.abs(r.eloDiff) >= 150 ? "实力悬殊" : Math.abs(r.eloDiff) >= 60 ? "明显差距" : "接近") : "非WC/缺",
      Number.isFinite(r.eloDiff) && Math.abs(r.eloDiff) < 60 ? "实力接近→爆冷/平局温床" : "实力差大→热门更稳"]);

    // 3) 让球线深浅(vs 同实力档中位基准)
    if (d?.lineDepth || d?.marginExpect) {
      blocks.push(["③让球线深浅(vs同实力档中位)", `${d.marginExpect ?? "—"}${d.lineDepth ? `·${d.lineDepth}` : ""}`,
        "基准=同1X2实力档亚盘中位(mine-upset-drivers 8906场);深浅看残差非绝对值",
        d.lineDepth === "深于同类(市场敢加码)" ? "市场敢深让=更笃定" : d.lineDepth === "浅于同类" ? "线浅(边缘平局信号z=2.2)" : "同类正常",
        d.lineDepth === "浅于同类" ? "深热+线浅→边缘防平·别买深让当胆" : "按盘口控注"]);
    }

    // 4) 大小球进球预期
    if (d?.goalsExpect && d.goalsExpect !== "未知") {
      blocks.push(["④大小球进球预期", `${d.goalsExpect}${r.sanityOdds?.over25 != null ? `·大球${pc(r.sanityOdds.over25)}` : ""}`,
        "低线=闷战(净胜薄+平局多);德4.5血洗 vs 西3.5闷局的真区分点", /低球|偏小/.test(d.goalsExpect) ? "闷战倾向" : /高球|偏大/.test(d.goalsExpect) ? "对攻倾向" : "中性",
        /低球|偏小/.test(d.goalsExpect) ? "闷战→热门易被逼平·防平" : "进球多→爆冷以被翻盘为主"]);
    }

    // 5) 平局隐含(OOS 最干净信号)
    const di = r.drawImpliedPct;
    blocks.push(["⑤平局隐含%(OOS最干净·防平)", di != null ? `${pc(di)}${di >= 0.30 ? "·🔴" : ""}` : "⚠️1X2未开售缺",
      "OOS校准:平局隐含≥30%→历史实际平局31.5%(最干净的隐藏平局信号)", di != null ? (di >= 0.30 ? "🔴防平(高发档)" : di >= 0.25 ? "中性偏防" : "平局低") : "缺",
      di != null && di >= 0.30 ? "胜负平双选含平·半全场加平-平" : "平局风险一般"]);

    // 6) 大小球走势(唯一 z>4 真 edge)
    if (tm && tm.lean) {
      blocks.push(["⑥大小球走势(唯一z>4真edge)", `${tm.lean}${tm.move != null ? `(移动${(tm.move * 100).toFixed(0)}pp)` : ""}${tm.empiricalOverRate != null ? `·历史大球${pc(tm.empiricalOverRate)}` : ""}`,
        "8906场实证:加注→大球63%·退烧→小球44%(z=4.4/-4.7,唯一过统计强度的真edge)", tm.band ?? "—",
        tm.lean === "大球" ? "大小球玩法倾向大球(有据)" : tm.lean === "小球" ? "倾向小球(有据)·小球常伴闷平" : "无走势信号"]);
    } else {
      blocks.push(["⑥大小球走势(唯一z>4真edge)", "⚠️无初盘大小球·无法判走势", "需初→收双盘;本场仅收盘(不编造走势)", "—", "大小球走势信号本场不可用"]);
    }

    // 7) 盘口移动/诱盘(1X2走势=噪声,仅描述)
    if (tr && tr.movement) {
      const MVZH = { "flat": "盘口平稳", "stable": "盘口平稳", "mild": "轻微移动", "drift": "缓慢移动", "strong-steam": "剧烈异动(steam)" };
      const mv = MVZH[tr.movement.classification] ?? tr.movement.classification;
      blocks.push(["⑦1X2盘口移动/诱盘判读", `${mv}${tr.movement.favoriteDrift != null ? `·热门漂移${(tr.movement.favoriteDrift * 100).toFixed(0)}pp` : ""}·${tr.trapVerdict ?? "—"}`,
        "⚠️回测证1X2初→收走势对爆冷=噪声(分歧时市场更准);仅作诊断", tr.upsetLevel ? `诱盘判读置信${pc(tr.trapConfidence)}` : "—",
        "仅诊断·非弃注/弃热门依据(回测背书)"]);
    }

    // 8) 历史同档爆冷率(12458场真赛果)
    const hu = r.histLineUpset;
    blocks.push(["⑧历史同档爆冷率(12458场真赛果)", hu != null ? `${pc(hu)}${hu >= 0.45 ? "·🟠高基线" : ""}` : "—",
      "该让球线上给球热门历史真实'不胜'频次(跨场可比爆冷基线)", hu != null ? (hu >= 0.45 ? "高基线" : hu >= 0.30 ? "中" : "低") : "缺",
      hu != null && hu >= 0.45 ? "该档历史本就易冷·让得越少越易冷" : "该档历史较稳"]);

    // 9) 经验库平局基线(WC场落全局~26%,非窄情境匹配——如实标注不过度声称)
    if (r.drawRateExp != null) {
      const wide = r.drawRateExpN && r.drawRateExpN > 5000;  // 大N=全局基线非窄匹配
      blocks.push(["⑨经验库平局基线", `${pc(r.drawRateExp)}${r.drawRateExpN ? `(N=${r.drawRateExpN}${wide ? "·全局基线" : "·同情境"})` : ""}`,
        wide ? "经验库整体平局频次(WC场无窄情境匹配·落全局基线·仅背景参照)" : "历史同联赛/同档真实平局频次", r.drawRateExp >= 0.30 ? "偏高" : "一般",
        wide ? "背景参照·以本场平局隐含(⑤)为准" : (r.drawRateExp >= 0.30 ? "兼顾平局" : "—")]);
    }

    // 10) 若爆冷最可能结果(真盘优先,模型矩阵兜底)
    let shape = "—";
    if (us) {
      const parts = [];
      const md = r.upsetMarketDraw;
      if (md?.score) parts.push(`被逼平 ${md.score}(${pc(md.prob)}·✅500真盘)`);
      else if (us.drawScore && us.drawScoreProb != null) parts.push(`被逼平 ${us.drawScore}(${pc(us.drawScoreProb)}·🔶模型)`);
      if (us.drawHalfFull != null) parts.push(`半全场平-平 ${pc(us.drawHalfFull)}`);
      if (us.reverseScore && us.reverseScoreProb != null) parts.push(`或被翻盘 ${us.reverseScore}(${pc(us.reverseScoreProb)}·🔶模型)`);
      shape = parts.join(" · ") || "—";
    }
    blocks.push(["⑩若爆冷最可能结果", shape, "比分=不可约方差·仅参考;被逼平格优先500真盘", "—", "若防爆冷:按上方比分加平局格/半全场平-平"]);

    // 11) 综合裁决——人话讲清:会不会冷 / 冷主要怎么冷 / 最该防什么 / 玩法怎么落(2026-06-18 用户:结论要详细解释)
    const drawGrid = r.upsetMarketDraw?.score ?? us?.drawScore;
    const depthTag = !s || !s.band ? "" : sanityVerdictLabel(s).tag;
    const guard = guardOf(r, nw, depthTag) + (nw >= 28 && drawGrid ? `·比分加平局格${drawGrid}·半全场加平-平` : "");
    const typeFinal = d?.upsetType ?? (nw >= 42 ? "🔴双向爆冷(势均)" : nw >= 0 && nw < 22 ? "🟢低风险(强热)" : "中性");
    const cc = [];
    cc.push(`【是否易冷】${typeFinal}——市场对热门"不胜"的共识${nw >= 0 ? `约${nw}%` : "缺(1X2未开售)"}${nw >= 42 ? ",势均场胜/平/负三分天下,绝不能把热门当胆" : nw >= 28 ? ",中等热门有相当不胜概率,别重注当胆" : nw >= 0 ? ",强热门相对稳,仍按盘口控注勿满仓" : ""}。`);
    const how = [];
    if (Number.isFinite(r.eloDiff) && Math.abs(r.eloDiff) < 60) how.push("双方实力接近(Elo差<60)=平局/爆冷温床");
    if (r.drawImpliedPct != null && r.drawImpliedPct >= 0.30) how.push(`平局隐含${Math.round(r.drawImpliedPct * 100)}%(OOS实证这档实际平31.5%)→冷多以"被逼平"出现,防平最关键`);
    if (r.totalsMove?.lean === "小球") how.push("大小球走势偏小球(z>4真信号)→闷局易逼平");
    else if (r.totalsMove?.lean === "大球") how.push("大小球走势偏大球→若冷多为对攻被翻盘");
    if (us?.reverseScore) how.push(`也存在被翻盘可能(模型估比分${us.reverseScore})`);
    if (r.histLineUpset != null && r.histLineUpset >= 0.45) how.push(`该让球档历史本就高发不胜(${Math.round(r.histLineUpset * 100)}%)·让得越少越易冷`);
    cc.push(`【冷会怎么冷】${how.length ? how.join(";") + "。" : "无突出的单一爆冷路径,按市场共识对待即可。"}`);
    cc.push(`【怎么防】${guard}。`);
    blocks.push(["⑪综合裁决·本场结论", typeFinal, d?.reason ?? "—", "—", cc.join("\n")]);
    if (d?.caveat) blocks.push(["⚠️诚实边界", d.caveat, "", "", ""]);
  });

  return { name: "爆冷研判", rows: [[banner], sumHeader, ...sumRows, SEP(""), SEP("━━━━ 以下为逐场细胞级因子分解 ━━━━"), ...blocks] };
}

// ── 14场/任选9 闸裁决工作表(buildFourteenPlan 闸如实判定;不能出写明依据,绝不硬凑) ──
export function buildFourteenSheetRows({ date, fourteen, periodFacts = [] }) {
  const head = [`🎯 14场/任选9 · ${date} · 闸裁决`];
  if (!fourteen) return [head, ["闸裁决", "⚠️ 14场计划未构建(store 无本期胜负彩腿映射)"], ...periodFacts.map((x) => (Array.isArray(x) ? x : [x]))];
  if (!fourteen.available) {
    return [head,
      ["闸裁决", "⛔ 今日不发14场段(任选9 同闸不发)"],
      ["依据(buildFourteenPlan 闸原话)", fourteen.note ?? "—"],
      ...periodFacts.map((x) => (Array.isArray(x) ? x : [x])),
    ];
  }
  // ── 防冷裁决(2026-06-11 用户裁决:删掉"爆冷后果"废话,只答四件事——哪场最可能爆、冷向是主/平/客、
  //    重点防哪些、防不住就全包或弃[弃=不当胆/不进任选9;14场票内腿必须填则全包])。
  // 🔶推断:由引擎逐腿真实概率派生;冷向=主选之外概率最高方向(平局算冷,爆冷不只输赢)。
  const sels = (fourteen.selections ?? []).filter((s) => s.rawProbabilities && Number.isFinite(s.rawProbabilities.home));
  const CODE_LABEL = { "3": "主胜", "1": "平局", "0": "客胜" };
  const probOfCode = (s, c) => (c === "3" ? s.rawProbabilities.home : c === "1" ? s.rawProbabilities.draw : s.rawProbabilities.away);
  for (const s of sels) {
    const others = ["3", "1", "0"].filter((c) => c !== s.singleCode)
      .map((c) => ({ code: c, p: probOfCode(s, c) })).sort((a, b) => b.p - a.p);
    const [t1, t2] = others;
    // 冷向显示:第二威胁≥20%时并显(回答"冷是胜还是负还是平"——可能不止一个方向有戏)
    s._cold = {
      label: CODE_LABEL[t1.code], p: t1.p,
      text: t2.p >= 0.20 ? `${CODE_LABEL[t1.code]}${Math.round(t1.p * 100)}%+${CODE_LABEL[t2.code]}${Math.round(t2.p * 100)}%` : `${CODE_LABEL[t1.code]}${Math.round(t1.p * 100)}%`,
    };
    if (t1.p >= 0.27 && t2.p >= 0.22) s._guard = `🚨防不住→全包(任选9弃此腿,不当胆):双威胁 ${CODE_LABEL[t1.code]}${Math.round(t1.p * 100)}%+${CODE_LABEL[t2.code]}${Math.round(t2.p * 100)}%`;
    else if (t1.p >= 0.27) s._guard = `🛡重点防:双选 ${s.single}/${CODE_LABEL[t1.code]}`;
    else if (t1.p >= 0.24) s._guard = `⚠️建议防:双选 ${s.single}/${CODE_LABEL[t1.code]}`;
    else s._guard = `可单选(冷向${CODE_LABEL[t1.code]}仅${Math.round(t1.p * 100)}%)`;
  }
  const header = ["腿", "对阵", "单选", "复选", "类型", "主/平/客%", "冷向", "防冷裁决", "信心", "理由"];
  const legs = (fourteen.selections ?? []).map((s) => [String(s.index), s.match, s.single, s.compound, s.type,
    `${s.probabilities?.home ?? ""}/${s.probabilities?.draw ?? ""}/${s.probabilities?.away ?? ""}`,
    s._cold ? s._cold.text : (s.upsetRisk ?? ""),
    s._guard ?? "—", String(s.confidence ?? ""), s.reason ?? ""]);
  const r9 = fourteen.renxuan9;

  // ── 胆/双选/全包 分组推荐(2026-06-16 用户裁决:14场与任选9 各自分别给出 胆/双选/全包 三类推荐)──
  //    纯展示分组:选腿与每腿覆盖一律取自引擎逐腿真实裁决(selection.type / renxuan9.pick.type),不重算、不兜底。
  const fourteenItems = (fourteen.selections ?? []).map((s) => ({
    leg: s.index, match: s.match, single: s.single, compound: s.compound, type: s.type,
    cover: Array.isArray(s.compoundCodes) ? s.compoundCodes.length : String(s.compound ?? "").split("/").length,
  }));
  const r9Items = (r9?.ok ? (r9.picks ?? []) : []).map((p) => ({
    leg: p.rank, match: p.match, single: p.pick ?? p.single, compound: p.compound ?? p.pick ?? p.single, type: p.type,
    cover: String(p.compound ?? p.pick ?? p.single ?? "").split("/").length,
  }));
  const ticketGroupRows = (title, items) => {
    if (!items.length) return [];
    const dan = items.filter((it) => it.type === "胆");
    const dbl = items.filter((it) => it.type === "双选");
    const full = items.filter((it) => it.type !== "胆" && it.type !== "双选"); // 全选/全包(三选全)
    const fmt = (arr, useCompound) => arr.length
      ? arr.map((it) => `第${it.leg}腿 ${it.match}(${useCompound ? it.compound : it.single})`).join(" ║ ")
      : "无";
    const notes = items.reduce((n, it) => n * Math.max(1, it.cover || 1), 1);
    const fnum = (x) => x.toLocaleString("en-US");
    return [
      [""],
      [`🎟 ${title} · 胆/双选/全包 分别推荐`, "🔶选腿与覆盖均由引擎逐腿真实概率裁决,纯展示分组,不重算不兜底"],
      [`【胆·单选锁定】${dan.length}腿`, fmt(dan, false)],
      [`【双选·防一手】${dbl.length}腿`, fmt(dbl, true)],
      [`【全包·三选全】${full.length}腿`, fmt(full, true)],
      ["推荐混合票(胆×双选×全包)", `胆${dan.length}+双选${dbl.length}+全包${full.length} → 共 ${fnum(notes)} 注(×2元=${fnum(notes * 2)}元),全腿命中即中`],
    ];
  };

  // 任选9 严选腿表(此前仅一行串关字符串,补齐逐腿明细+分组,口径同14场)
  const r9TableRows = r9Items.length ? (() => {
    const r9Header = ["任选9腿", "对阵", "单选", "复选", "类型", "主/平/客%", "信心"];
    const body = (r9.picks ?? []).map((p) => [String(p.rank), p.match, p.pick ?? p.single ?? "",
      p.compound ?? p.pick ?? "", p.type ?? "",
      `${p.probabilities?.home ?? ""}/${p.probabilities?.draw ?? ""}/${p.probabilities?.away ?? ""}`,
      String(p.confidence ?? "")]);
    return [[""], ["🎯 任选9 · 严选9场(从14腿挑市场最有把握的9场,9场全对即中)"], r9Header, ...body];
  })() : [];
  const r9ParlayRow = r9?.ok && r9.parlay
    ? [["任选9·9串联合命中", `独立估计${parlayPct(r9.parlay.jointProbabilityIndependent ?? 0)} / 相关性修正${parlayPct(r9.parlay.jointProbabilityCorrelated ?? 0)}`]]
    : [];

  const scenarioRows = [];
  if (sels.length >= 2) {
    const ranked = [...sels].sort((a, b) => b._cold.p - a._cold.p);
    const giveUp = ranked.filter((s) => s._guard.startsWith("🚨"));
    const mustGuard = ranked.filter((s) => s._guard.startsWith("🛡"));
    scenarioRows.push(
      [""],
      ["💣 防冷裁决汇总", "🔶由引擎逐腿真实概率派生;冷向=主选外概率最高方向(平局算冷,双威胁并显)"],
      ["最可能爆冷", ranked.slice(0, 3).map((s) => `第${s.index}腿 ${s.match}:冷=${s._cold.text}`).join(" ║ ")],
      ["重点防", mustGuard.length ? mustGuard.map((s) => `第${s.index}腿双选${s.single}/${s._cold.label}`).join(" ║ ") : "无(达重点防线的都已升级全包,见下行)"],
      ["防不住→全包/弃", giveUp.length ? giveUp.map((s) => `第${s.index}腿 ${s.match}(${s._guard.split(":")[1] ?? "双威胁"}→票内全包;任选9弃之,不当胆)`).join(" ║ ") : "无双威胁腿"],
    );
    if (r9?.ok && Array.isArray(r9.picks)) {
      const nineMatches = new Set(r9.picks.map((p) => p.match));
      const nineBad = ranked.filter((s) => nineMatches.has(s.match) && (s._guard.startsWith("🚨") || s._guard.startsWith("🛡")));
      if (nineBad.length) scenarioRows.push(["⚠️任选9换腿建议", nineBad.map((s) => `第${s.index}腿 ${s.match} 冷=${s._cold.text}——任选9无双选可防,建议换更稳腿`).join(" ║ ")]);
    }
  } else if (fourteen.selections?.length) {
    scenarioRows.push([""], ["💣 防冷裁决", "⚠️本期产物缺逐腿原始概率字段(旧版引擎生成),如实跳过——重跑生成即有"]);
  }
  const tail = [[""],
    ["闸裁决", "✅ 本期可发(恰14腿·比赛日含今日·停售未过)"],
    ...periodFacts.map((x) => (Array.isArray(x) ? x : [x])),
    ["单式串(14场)", fourteen.singleLine ?? ""],
    ["复式串(14场)", fourteen.compoundLine ?? ""],
    ["胆串(相关性修正)", fourteen.bankerParlay ? `独立估计${parlayPct(fourteen.bankerParlay.jointProbabilityIndependent ?? 0)} / 修正${parlayPct(fourteen.bankerParlay.jointProbabilityCorrelated ?? 0)}` : "—"],
    ...ticketGroupRows("14场", fourteenItems),
    ...r9TableRows,
    ...ticketGroupRows("任选9", r9Items),
    ...r9ParlayRow,
    ["任选9", r9?.ok ? `单式串:${r9.singleLine ?? (r9.picks ?? []).map((p) => p.pick ?? p.single ?? "").join(" ")}` : `不出(${r9?.reason ?? "—"})`],
    ...scenarioRows,
  ];
  return [head, header, ...legs, ...tail];
}

// ── 串关推荐工作表(2026-06-12 用户需求:最稳/均衡/高赔/爆冷分档,胜负平/让球/比分/总进球/半全场混合过关) ──
// plan = parlay-builder.buildParlayPlan 产物;赔率✅实测乘积、概率/EV 🔶推断(de-vig+独立性),规则与风险写进表头,绝不吹正EV。
const parlayPct = (x) => `${(x * 100).toFixed(x >= 0.095 ? 0 : 1)}%`;
export function buildParlaySheet({ date, plan, jqsFetchedAt, advBanner }) {
  const legsN = plan?.ok ? (plan.tiers[0]?.combos[0]?.legs.length ?? 2) : 2;
  const head = [`🔗 串关推荐(混合过关·全${legsN}串1·每注100元口径) · ${date}`];
  const rules = [
    ["规则", `竞彩混合过关:同一场只能选一个玩法的一个选项入同一注;今日在售场为${legsN}场→本表全部${legsN}串1。`],
    ["数据", `腿赔率=✅500真盘实测(胜负平/让球/比分/半全场=当日快照;总进球=本次实抓 trade.500.com pl_jqs${jqsFetchedAt ? `,抓取${jqsFetchedAt}` : ""});串赔率=各腿实测赔率乘积。`],
    ["阶梯", "从最稳到高配完整阶梯,每档=该风险层的最优解:①🛡️最稳=联合概率最高(保中率优先)→②💎性价比=价值效率最高(抽水最小=结构最优)→③⚖️均衡(4~9倍)→④🚀进取(9~40倍)→⑤🏆高配(≥40倍博大彩)→⑥💣爆冷(全冷腿)。②~⑥按价值效率(=1/∏抽水)选注=同区间内最不亏。每注末附🔬研判(最弱腿/抽水最大腿/模型认同腿数)。"],
    ["口径", "金额列按每注100元假设:可中=串赔×100(含本金);净赚=可中-100,回报率=净赚/100;期望回收🔶=联合概率×可中(恒<100元,两重抽水叠乘)——串关数学期望必然劣于单注,本表只按要求给搭法标注,不构成下注建议。联合概率=🔶推断(各玩法全集比例法de-vig × 跨场独立性假设)。"],
    ...(advBanner ? [["风险", advBanner]] : []),
  ];
  if (!plan?.ok) return { name: "串关推荐", rows: [head, ...rules, [`⚠️ ${plan?.note ?? "串关计划未构建"}(如实不出,不硬凑)`]] };
  // 排版(2026-06-12 用户反馈"有点乱"):腿合并成一列"怎么买",一格照着抄;概率/模型概率合一列。
  const CIRCLED = "①②③④⑤⑥⑦⑧⑨";
  const howToBuy = (c) => c.legs.map((l, i) => `${CIRCLED[i] ?? `${i + 1}.`}【${l.match}】${l.market}→买「${l.sel}」@${l.odds}`).join("\n");
  const header = ["档位", `怎么买(一注${legsN}腿,全中才中)✅`, "串赔率✅", "100元:可中/净赚✅", "中的概率🔶", "100元期望回收🔶", "说明"];
  const body = [];
  for (const t of plan.tiers) {
    for (const c of t.combos) {
      // exp 用 floor:期望回收数学上恒<100(∏(1/抽水)<1),四舍五入会把0.998×100=99.8顶成100假装不亏→违诚实铁律;floor把损失向上取整=保守。
      const win = Math.round(c.odds * 100), net = win - 100, exp = Math.floor(c.probMkt * win);
      const valueCell = c.valueScore != null ? `·价值${c.valueScore}` : "";
      const corrCell = c.probMktCorr != null && Math.abs(c.corrAdjPct ?? 0) >= 0.005 ? `·相关修正${parlayPct(c.probMktCorr)}` : "";
      const research = c.quality ? `\n🔬研判:最弱腿${c.quality.weakest}·${c.quality.maxVig}${c.quality.modelAgree ? `·模型认同${c.quality.modelAgree}` : "·无模型腿"}` : "";
      body.push([t.tier, howToBuy(c), `${c.odds}`,
        `可中${win}元(净赚+${net}元·回报率+${net}%)`,
        `${parlayPct(c.probMkt)}${c.probModel != null ? `(模型${parlayPct(c.probModel)})` : ""}${valueCell}${corrCell}`,
        `${exp}元(亏${100 - exp})`, c.why + research]);
    }
  }
  const tail = [[""]];
  tail.push(["价值口径(🔶)", "价值=概率×串赔=1/∏各玩法抽水(越接近1越不亏);💎性价比档=全空间抽水最小的真串(多为低抽水胜负平/让球),是混合串关结构最优解。比分/半全场抽水大→同赔率下价值更低,高赔档慎追。"]);
  if (plan.correlationNote) tail.push(["相关性(🔶)", plan.correlationNote]);
  if (plan.modelBest) {
    tail.push(["模型分歧参考(🔶)", `模型口径EV最高搭法:${plan.modelBest.legs.map((l) => `${l.match} ${l.label}`).join(" × ")} 串赔${plan.modelBest.odds}·模型联合概率${parlayPct(plan.modelBest.probModel)}·模型EV=${plan.modelBest.evModel}${plan.modelBest.evModel < 0 ? "(仍为负:模型本质市场跟随器,无独立edge,与当日对抗证伪结论一致)" : "(⚠️正EV仅为模型自评,当日三视角证伪未背书,勿当真edge)"}`]);
  }
  return { name: "串关推荐", rows: [head, ...rules, header, ...body, ...tail] };
}

// 手机页/英文页串关区(三处同源同口径;plan 缺/不可串 → 如实一句话,不留空白假象)
export function renderParlayHtmlSection(plan, { compact = false } = {}) {
  const esc2 = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  if (!plan) return "";
  if (!plan.ok) return `<div class="note">🔗 串关推荐:⚠️ ${esc2(plan.note ?? "未构建")}(如实不出)</div>`;
  const legsN = plan.tiers[0]?.combos[0]?.legs.length ?? 2;
  const CIRC = "①②③④⑤⑥⑦⑧⑨";
  const rows = plan.tiers.flatMap((t) => t.combos.map((c) =>
    `<tr><td>${esc2(t.tier)}</td><td>${c.legs.map((l, i) => `${CIRC[i] ?? i + 1}${esc2(l.match)}<br>买「<b>${esc2(l.sel)}</b>」@${l.odds}<span style="color:#9aa6b4">【${esc2(l.market)}·${Math.round(l.probMkt * 100)}%】</span>`).join("<hr style='border:none;border-top:1px dashed #ddd;margin:3px 0'>")}</td><td><b>${c.odds}</b></td><td><b>${Math.round(c.odds * 100)}元</b><br><span style="color:#9aa6b4">净+${Math.round(c.odds * 100) - 100}</span></td><td>${esc2(parlayPct(c.probMkt))}${c.probModel != null ? `<br><span style="color:#9aa6b4">模型${esc2(parlayPct(c.probModel))}</span>` : ""}</td></tr>`)).join("");
  return `<h2 style="font-size:15px;margin:16px 4px 6px;color:#4A148C">🔗 串关推荐(混合过关·全${legsN}串1·每注100元)</h2>
<div class="note" style="font-size:11.5px">同场只能选一个玩法入串(竞彩规则)。串赔=✅500实测乘积;可中=串赔×100元含本金;概率=🔶de-vig×独立假设;串关EV恒负(双重抽水),数学期望劣于单注——只给搭法参考。${compact ? "" : "完整期望回收/说明列见 xlsx「串关推荐」表。"}</div>
<table${compact ? ` class="core" style="font-size:12px"` : ""}><tr><th>档位</th><th>搭法(${legsN}串1)</th><th>串赔✅</th><th>100元可中✅</th><th>联合概率🔶</th></tr>${rows}</table>`;
}

// ── 手机页头条覆盖副标题(2026-06-10 审计确认缺陷:头条硬编码"5赔种全覆盖"假全覆盖声明,与 xlsx 真计数 banner 口径不一) ──
// counts 必须来自 buildOddsFillCounts 真计数;缺/非法直接 throw(fail-loud,绝不默认自吹全覆盖)。
// 任一赔种(欧赔/让球/比分/半全场/大小球)有缺口 → 禁出"全覆盖"字样,改逐赔种实数(与 xlsx banner 缺陷#8 同口径)。
export function buildCoverageSubtitle(counts) {
  if (!counts || !Number.isFinite(counts.total) || counts.total <= 0) {
    throw new Error("buildCoverageSubtitle:counts 缺失/非法(必须传 buildOddsFillCounts 真计数),拒绝输出覆盖声明。");
  }
  const n = counts.total;
  const kinds = [["欧赔", counts.euro], ["让球", counts.handicap], ["比分", counts.score], ["半全场", counts.halffull], ["大小球", counts.ou]];
  if (kinds.every(([, c]) => c === n)) return `5赔种全覆盖(${n}/${n}真计数核验)`;
  return kinds.map(([k, c]) => `${k}${c}/${n}`).join("·");
}

// ── 审计背书(缺陷#17:绝不硬编码历史日期的审计声明;adversarial/<date>.json 缺 → 不写背书句) ──
// advData = adversarial/<date>.json 的 verdicts(或 null);rows 用于派生真实让球线清单。
export function buildAuditFoot({ rows, advData }) {
  const parts = [];
  const lines = rows
    .map((r) => {
      const line = r.hcP?.line;
      if (!line) return null;
      const home = String(r.match ?? "").split(" vs ")[0];
      return `${home}${String(line).replace(/^让/, "")}`;
    })
    .filter(Boolean);
  if (lines.length) parts.push(`让球线=500实时核实(${lines.join("/")})`);
  if (advData && Object.keys(advData).length) {
    const audited = rows.filter((r) => r.adv).length;
    parts.push(`三视角对抗证伪已审计${audited}/${rows.length}场(🔴=证伪·只标注不弃赛,展开看致命点)`);
  } else {
    // 缺当日审计文件:不写任何"已审计"背书(绝不凭空捏造审计声明),只如实标未跑。
    parts.push("⚠️对抗证伪未跑(football-signal-verify 当日未出,证伪列标缺)");
  }
  return parts.join("。") + "。";
}

// ── 对抗证伪单元格(无当日审计文件 → 如实标⚠️未跑,绝不编造结论) ──
//   2026-06-18 用户:实时核查到的异动/冷门(防什么·指向哪)也写进竞彩完整 → 追加在本列末(不增列·守27列契约;详见「盘口合理性」⑨行)。
export function advCellText(r, advDataPresent) {
  const lc = r.liveCheck;
  const lcDefend = !lc?.defend ? "" : (/^(无|不|没)/.test(lc.defend) ? `｜🛡️${lc.defend}` : `｜🛡️防${lc.defend}`);
  const lcLine = lc
    ? `\n🔍实时核查·异动冷门:${lc.verdict ?? ""}${lcDefend}${lc.direction ? `｜🎯最大可能→${lc.direction}` : ""}（✅本次web核查·依据见「情报详情」来源;详细对账见「盘口合理性」）`
    : "";
  let base;
  if (r.adv) base = `${r.adv.label}${r.adv.ev != null ? ` EV=${r.adv.ev}` : ""} ｜ ${r.adv.kill}`;
  else base = advDataPresent ? "—(该场未审计)" : "⚠️未跑(football-signal-verify 当日未出审计文件)";
  return base + lcLine;
}

// ── xlsx 25列(2026-06-11 升级:20列专业版 + 世界杯模型先验列组3列 + 让球真实裁决列 + 串关安全度列;
//    列头注明模型归属——"足球大模型"模型列 vs "市场锚"赔率列 vs "世界杯模型"先验列,两模型贡献一眼分清) ──
export const XLSX_HEADERS = ["#", "开赛", "对阵(赛事)",
  "胜负平(盘口✅主推·模型🔶次选)", "胜平负赔率✅(市场锚)",
  "🌍世界杯模型·Elo先验三概率(洲际校正)", "🌍世界杯模型·场馆λ乘子", "🏆世界杯模型·出线/夺冠%",
  "让球方向🔶(模型真实裁决·可与胜平负不同向)",
  "竞彩让球(模型让/受让后胜平负vs市场)", "竞彩让球赔率✅", "博彩亚盘✅(DK+titan007双源)",
  "信号面板✅(欧赔异动·亚盘水位·让球盘资金·共振/背离·阵容)",
  "比分(盘口✅真实热门主推+模型🔶次行)", "比分赔率✅", "半全场(盘口✅真实热门主推+模型🔶次行)", "半全场赔率✅", "大小球✅", "进球分布✅",
  "主队近5✅", "客队近5✅", "H2H(本地49k历史库)", "攻防画像", "信心档", "💰建议注金🔶(基础100元分层)", "串关安全度", "🔴对抗证伪(三视角·只标注不弃赛)",
  "🎯综合研判·最终建议(盘口+情报+异动·大白话)",
  "🌍世界杯小组形势(当前积分+面临问题·末轮胜平负出线推演)"];

// ── 综合研判·最终建议(2026-06-18 用户:把情报详情+盘口合理性的实时分析揉进竞彩完整·重新给推荐) ──
//   纯组合现成字段(盘口主推/信心/盘口合理性深浅/实时核查关键情报+异动+最终建议),不新增推断、不编造。
// 2026-06-19 重写(用户:别千篇一律糊弄·要风险点/为什么/爆冷结果/怎么买):
//   始终从行内已算好的真实字段合成【每场独立】研判——盘口主推✅(市场为主) + 真实盘口异动(信号面板初→现)
//   + 爆冷研判(upsetTrap·含机理) + 盘口深浅 + 对抗证伪;不再依赖缺失的 web-intel 而吐"无异动"套话。
//   方向恒=盘口主推(模型/分析只作风险注·绝不改方向);风险高→双选/轻仓/不当胆。零编造:字段缺则标缺。
// 怎么买(方向恒=盘口主推;按本场主导风险差异化·不千篇一律) — 抽成独立 helper 供研判格/雷达/详情 sheet 共用
export function buyAdvice(r) {
  const pick = (r.primary?.text ? String(r.primary.text).split("\n")[0] : (r.wld || "—")).replace(/^盘口主推[:：]\s*/, "");
  const sane = r.sanity?.band ? sanityVerdictLabel(r.sanity).tag : "—";
  const scen = r.scen || "";
  const deepHandicap = /悬殊|一边倒/.test(scen) && /未开售|让/.test(pick);
  const drawHigh = /平局\s*[中高]/.test(scen) || r.drawImpliedPct >= 0.30;
  const weakTier = /偏弱|硬币/.test(r.tier || "");
  const upsetHigh = r.upset?.level === "高";
  const sanityThin = /临界|过深|过浅|背离/.test(sane);
  const modelDiverge = r.primary?.agree === false;
  const refuted = r.adv?.label && /🔴|证伪/.test(r.adv.label);
  if (deepHandicap) return "赢球方向跟盘口,但悬殊盘让球偏深→只买胜/浅让、不贪深让当胆";
  if (weakTier) return "盘口主推但档位偏弱+方差大→小注试水、不当胆、别进串关核心";
  if (upsetHigh) return "跟盘口主推方向,但爆冷风险高→轻仓、不当独胆";
  if (sanityThin) return "跟盘口主推方向,但盘口临界/有异动→谨慎轻仓、不满仓当胆";
  if (drawHigh && (modelDiverge || refuted)) return "跟盘口主推方向,但平局维度偏高+模型看淡热门→建议双选对冲平局、轻仓不当独胆";
  if (modelDiverge) return "跟盘口主推方向,但模型与盘口分歧(看淡热门)→轻仓、不当独胆";
  if (refuted) return "跟盘口主推方向,但对抗证伪未过→轻仓、不当独胆";
  return `按盘口主推与信心档(${r.tier || "—"})正常对待`;
}

// 直接研判(2026-06-20 用户:不要虚的·先严密读盘口/庄家意图/异动,再一句话直接给"看好X方向·比分Y")。
//   比分只用真值:盘口主推比分(r.score)/真盘平局格(r.upsetMarketDraw·✅500 de-vig),无则只给方向不编比分。
export function directCall(r) {
  const dirM = String(r.wld || r.primary?.text || "").match(/(主胜|平局|客胜)/);
  const dir = dirM ? dirM[1] : "—";
  const mainScore = (String(r.score || "").match(/\d+-\d+/) || [])[0] || null;          // 盘口主推比分(真盘众数)
  const drawScore = r.upsetMarketDraw?.score || null;                                    // ✅500真盘最可能平局格(1-1等)
  const sig = String(r.signals || "");
  const moneyIn = /资金进|水位压入/.test(sig);     // 资金加注热门=sharp更看好·更可靠
  const moneyOut = /资金出|水位走高|退烧/.test(sig); // 退烧=公众追捧但盘口看淡·历史−12.6%坑
  const reson = /三盘共振/.test(sig);
  const diverge = /盘口信号分歧/.test(sig);
  const drawPct = r.drawImpliedPct != null ? Math.round(r.drawImpliedPct * 100) : null;
  const drawHigh = r.drawImpliedPct >= 0.30;
  const upsetHigh = r.upset?.level === "高";
  const refuted = r.adv?.label && /🔴|证伪/.test(r.adv.label);
  // 悬殊盘只卖让球=1X2真未开售(不是光scen含"悬殊"就算·否则有1X2的强热门被误判)
  const noWld = dir === "—" || /未开售/.test(String(r.wld || ""));
  // 1X2未开售时定真热门:① WC模型Elo先验(主X%/客Y%·最权威)② 竞彩让球赔率(主/客胜odds低者=热门)。
  //   绝不用亚盘水位lean——深盘水位反映"谁覆盖让球"非"谁赢"(深热门水位常偏客=误判)。
  const elo = String(r.wcElo || "").match(/主(\d+)%[^客]*客(\d+)%/);
  const hcOdds = String(r.hc || "").match(/(\d+\.\d+)\/\d+(?:\.\d+)?\/(\d+\.\d+)/);
  const favSide = elo ? (Number(elo[1]) >= Number(elo[2]) ? "主队" : "客队")
    : hcOdds ? (Number(hcOdds[1]) <= Number(hcOdds[2]) ? "主队" : "客队") : "热门";
  // 严密分析后 → 一句直接判断(按主导信号差异化,不千篇一律)
  if (noWld) return `看好${favSide}赢球(1X2未开售·悬殊盘)→只买${favSide}胜、不买深让(净胜要够·易赢球输盘)`;
  if (moneyOut && (drawHigh || refuted)) return `庄家退烧(资金流出)${drawPct != null ? `·平局隐含${drawPct}%` : ""}→防爆平,看好${drawScore || "平局1-1"};别拿${dir}当胆`;
  if (upsetHigh) return `爆冷风险高→${dir}别当胆,可博平${drawScore ? `(${drawScore})` : ""}或冷门`;
  if (drawHigh) return `平局隐含${drawPct}%偏高→防爆平,看好${drawScore || "平局"};${dir}走双选保平`;
  if (moneyIn && reson) return `资金加注+三盘共振→看好${dir}${mainScore ? ` ${mainScore}` : ""}(今日方向最硬)`;
  if (moneyIn) return `资金加注热门(钱在涌入)→看好${dir}${mainScore ? ` ${mainScore}` : ""}`;
  if (refuted) return `证伪未过·无独立edge→${dir}方向跟盘口但轻仓,别当胆`;
  if (diverge) return `盘口信号分歧(赢球难赢盘)→${dir}方向可,让球/比分谨慎`;
  if (reson) return `三盘共振${dir}→看好${dir}${mainScore ? ` ${mainScore}` : ""}`;
  return `盘口稳·看好${dir}${mainScore ? ` ${mainScore}` : ""}`;
}

// ── 异动雷达(2026-06-19 用户:把数据/阵容/赔率异动/大小球/情报/战意/伤病/红牌/重要性大融合给综合判断) ──
//   纯透明分析层:只从行内已算好的真实字段提取「排序后的因子」,绝不改 1X2 概率方向(方向恒=盘口主推)。
//   每个因子带:严重度(🔴高/🟡中/🟢观察) + 类别 + 三标签溯源(✅实测/🔶推断/⚠️待) + 大白话。零编造:字段缺=不出。
//   依据回测:庄家意图(欧赔资金流向)+大小球盘走势是仅有的真信号;软信息(阵容/伤病/红牌/战意)只观察不进概率。
export function buildAnomalyRadar(r) {
  const factors = [];
  const add = (sev, cat, tag, text) => factors.push({ sev, cat, tag, text });
  const dir = (r.primary?.text ? String(r.primary.text).split("\n")[0] : (r.wld || "—")).replace(/^盘口主推[:：]\s*/, "");
  const tier = r.tier || "—";
  const conf = Number.isFinite(r.conf) ? Math.round(r.conf) : null;
  const sig = String(r.signals || "");
  const segs = sig.split("‖").map((s) => s.trim());

  // ① 庄家意图(✅实测·欧赔初→现资金流·6-18回测背书:加注热门+5.2%/退烧热门−12.6%)
  const euroSeg = segs.find((s) => /^欧赔/.test(s)) || "";
  if (/资金进|水位压入/.test(euroSeg)) add("🟡", "庄家意图", "✅实测", "欧赔热门水位压入(资金进/加注)→sharp侧加注;历史此类跟投命中偏高(+5.2%区),可靠但需赶收盘前下注(速度/CLV)");
  else if (/资金出|水位走高|退烧/.test(euroSeg)) add("🟡", "庄家意图", "✅实测", "欧赔热门水位走高(资金出/退烧)→疑公众追捧但盘口看淡;历史此类是−12.6%坑,避开当独胆");
  else if (euroSeg && !/未开售|初现持平/.test(euroSeg)) add("🟢", "异动完整性", "⚠️缺", "欧赔初盘未捕获→无法判定资金异动/庄家意图(标缺不编;开盘续鲜后可判)");

  // ② 亚盘异动(✅实测·亚盘最贴近真实概率的sharp盘)
  const asianSeg = segs.find((s) => /^亚盘/.test(s)) || "";
  if (/盘口异动/.test(asianSeg)) { const m = asianSeg.match(/开[^·)]*→现[^·)]*/); add("🟡", "盘口异动", "✅实测", `亚盘移动${m ? `(${m[0]})` : ""}·亚盘是最贴近真实概率的sharp盘,移动方向值得参考`); }

  // ③ 三盘共振/背离(✅实测)
  const reson = segs.find((s) => /共振/.test(s));
  const diverge = segs.find((s) => /盘口信号分歧/.test(s));
  if (reson) add("🟢", "盘口共振", "✅实测", reson.slice(0, 90));
  else if (diverge) add("🟡", "盘口背离", "✅实测", diverge.slice(0, 110));

  // ④ 大小球盘走势(记忆:盘口里唯一显著统计edge·z>4·优先级高)
  if (r.totalsMove?.lean && r.totalsMove.lean !== "无明显走势") add("🟢", "大小球走势★唯一统计edge", "✅实测", `大小球盘走势倾向「${r.totalsMove.lean}」——盘口走势是本模型实证里唯一显著(z>4)的统计edge,可作大小球玩法主据`);

  // ⑤ 盘口深浅(🔶推断·同强度历史区间)
  const sane = r.sanity?.band ? sanityVerdictLabel(r.sanity).tag : null;
  if (sane && /临界|过浅|过深|背离|高估|低估/.test(sane)) add("🟡", "盘口体检", "🔶推断", `热门隐含${r.sanity?.favProb != null ? Math.round(r.sanity.favProb * 100) + "%" : "?"}·${sane}(对比同强度历史正常区间)`);

  // ⑥ 平局风险(头号历史失败模式)
  if (r.drawImpliedPct >= 0.30) add("🟡", "平局风险", "🔶推断", `市场隐含平局${Math.round(r.drawImpliedPct * 100)}%偏高·平局盲区是复盘头号失败模式,建议双选保平`);

  // ⑦ 爆冷机理(真实推理·每场不同)
  if (r.upset?.level === "高" && r.upset?.reason) add("🔴", "爆冷高", "🔶推断", r.upset.reason);
  else if (r.upset?.reason) add("🟡", "爆冷", "🔶推断", r.upset.reason);
  else if (r.upsetDiag?.upsetType) add("🟢", "爆冷分型", "🔶推断", `${r.upsetDiag.upsetType}·热门不胜${r.upsetDiag.baseUpsetProb != null ? Math.round(r.upsetDiag.baseUpsetProb * 100) + "%" : "?"}`);

  // ⑧ 模型vs盘口分歧(逆市场=高风险·CLV回测坐实击败收盘仅45%)
  if (r.primary?.agree === false) add("🟡", "模型分歧", "🔶分析", "模型与盘口分歧(看淡热门)·逆市场分歧=高风险(CLV回测此类击败收盘仅45%),以盘口为准、轻仓不当独胆");

  // ⑨ 对抗证伪
  if (r.adv?.label && /🔴|证伪/.test(r.adv.label)) add("🟡", "对抗证伪", "🔶分析", "三视角对抗证伪未过·模型无独立edge,以盘口为准");

  // ⑩ 阵容/伤病/红牌/战意(软信息·展示不进概率·诚实标缺)
  if (/阵容[:：]\s*✅已出/.test(sig)) add("🟢", "阵容", "✅实测", "首发已出·已按真实首发重算");
  else if (/阵容[:：]\s*⚠️未公布/.test(sig)) add("🟡", "阵容/伤病/红牌", "⚠️待", "首发未公布·开赛前~1h按真实首发重分析推送(伤病/红牌/轮换届时为准;当前不进概率,标缺不编)");

  const ord = { "🔴": 0, "🟡": 1, "🟢": 2 };
  factors.sort((a, b) => ord[a.sev] - ord[b.sev]);
  const how = buyAdvice(r);
  const topFlags = factors.filter((f) => f.sev !== "🟢").slice(0, 3).map((f) => `${f.sev}${f.cat}`).join(" ");
  const call = directCall(r);
  const upset = upsetOutcome(r);
  // 综合研判格(2026-06-21 用户:别孤立解读·要把爆冷研判+盘口合理性+异动汇总进来再给推荐):
  //   ①直接研判(看好X·比分Y) ②关键依据=排序后真实因子(庄家意图/盘口深浅/爆冷/平局,最多2条) ③若爆冷会怎样 ④怎么打。
  const keyDrivers = factors.filter((f) => f.sev !== "🟢").slice(0, 2).map((f) => `${f.sev}${f.cat}:${f.text}`).join("\n");
  const short = `🎯${call}`
    + (keyDrivers ? `\n📊关键依据:\n${keyDrivers}` : `\n📊盘口平稳·无显著异动`)
    + (upset ? `\n🎲若爆冷:${upset}` : "")
    + `\n👉怎么打:信心${tier}${conf != null ? `(${conf})` : ""}·${how}`;
  return { dir, tier, conf, factors, how, call, short, upset };
}

// 若爆冷会出现什么结果(2026-06-21 用户:研判要说"出现爆冷可能会出现什么结果"这种实际内容)。
//   全用真值:真盘最可能平局格(✅500 de-vig)+ 冷门方向 + 爆冷机理;无则只给方向不编比分。
export function upsetOutcome(r) {
  const dirM = String(r.wld || r.primary?.text || "").match(/(主胜|平局|客胜)/);
  const fav = dirM ? dirM[1] : null;
  const cold = fav === "主胜" ? "客队偷分(平或客胜)" : fav === "客胜" ? "主队偷分(平或主胜)" : null;
  const drawScore = r.upsetMarketDraw?.score || null;
  const drawPct = r.drawImpliedPct != null ? Math.round(r.drawImpliedPct * 100) : null;
  const lvl = r.upset?.level;
  if (!cold && !drawScore && lvl == null) return null;
  const bits = [];
  if (drawScore) bits.push(`最可能踢成平局 ${drawScore}`);
  else if (drawPct != null && drawPct >= 28) bits.push(`平局概率 ${drawPct}%`);
  if (cold) bits.push(cold);
  if (lvl === "高") bits.push("爆冷风险高");
  return bits.length ? bits.join("、") : null;
}

export function synthesisCell(r) { return buildAnomalyRadar(r).short; }

// ── 研判详情 sheet(异动雷达全文下沉处:主表保持精简,这里给排序后的完整因子分栏) ──
export function buildRadarDetailSheet({ date, rows }) {
  const MOVE = new Set(["庄家意图", "盘口异动", "盘口共振", "盘口背离", "大小球走势★唯一统计edge"]);
  const UPSET = new Set(["爆冷高", "爆冷", "爆冷分型", "平局风险"]);
  const RISK = new Set(["盘口体检", "模型分歧", "对抗证伪", "阵容/伤病/红牌", "阵容"]);
  const fmt = (fs) => fs.length ? fs.map((f) => `${f.sev}${f.tag}〔${f.cat}〕${f.text}`).join("\n") : "—";
  const headers = ["#", "对阵(赛事)", "🎯我的判断(看好X方向·比分Y)", "🔴🟡风险点(按严重度排序)", "📊盘口异动·庄家意图·大小球走势", "🎲爆冷机理·平局风险", "🎲若爆冷会怎样(具体结果)", "🔎web核查情报"];
  const body = rows.map((r) => {
    const rad = buildAnomalyRadar(r);
    return [String(r.idx), `${r.match}(${r.comp})`, `🎯${rad.call}\n〔盘口主推${rad.dir}·信心${rad.tier}(${rad.conf ?? "—"})〕`,
      fmt(rad.factors.filter((f) => RISK.has(f.cat))),
      fmt(rad.factors.filter((f) => MOVE.has(f.cat))),
      fmt(rad.factors.filter((f) => UPSET.has(f.cat))),
      rad.upset || "盘口稳·爆冷信号不强", r.liveCheck?.keyIntel || "—"];
  });
  const title = `🎯 研判详情 · 把盘口异动+庄家意图+大小球走势+爆冷机理+盘口合理性 全汇总到一处 · ${date}`;
  const honest = "⚠️怎么看:方向跟盘口主推(市场最准·公开盘打不过收盘线、模型只是跟随器);这张表把每场的资金异动、盘口深浅、爆冷机理、平局风险全列出来,让你一眼看清这场稳不稳、哪里有雷。阵容/伤病/红牌只摆出来看,不进概率(灌进去反而更差·回测证)。";
  return { name: "研判详情", rows: [[title], [honest], headers, ...body] };
}

export function buildXlsxSheets({ date, rows, banner, advDataPresent, recordLine = null, stakeNote = null }) {
  // 对阵列附加行:每场情景研判(🏆赛会 出线/夺冠% 已移到专属"世界杯模型"列,不再塞对阵格)
  const matchCell = (r) => `${r.match}(${r.comp})${r.scen ? `\n情景:${r.scen}` : ""}`; // 爆冷研判移出→独立sheet(主表干净)
  const xrows = rows.map((r) => [String(r.idx), r.ko, matchCell(r),
    r.wld, r.euro,
    r.wcElo ?? "—", r.wcLambda ?? "—", r.wcTourney ?? (r.wcLine || "—"),
    r.hv?.text ?? "⚠️让球真实裁决缺",
    r.hcView, r.hc, r.asian, r.signals ?? "⚠️未拼装", `${r.score}〔${r.scoreSrc}〕`, r.scoreMkt, `${r.halffull}〔${r.hfSrc}〕`, r.hfMkt, r.ouReal, r.dist,
    `${r.homeRec} ${r.homeLast5}`, `${r.awayRec} ${r.awayLast5}`, r.h2h, r.profile, `${r.tier}(${Math.round(r.conf)})`,
    r.stake?.text ?? "—(档位缺不给金额)",
    r.parlay?.text ?? "⚠️未评", advCellText(r, advDataPresent), synthesisCell(r), r.wcGroupCell ?? "—"]);
  // 战绩行/注金口径行紧跟 banner(2026-06-12 用户裁决:战绩透明化进表头;缺=不出该行,不留空假象)
  const headRows = [[`⚡ 神选 · 竞彩完整覆盖 · ${date}`], [banner],
    ...(recordLine ? [[recordLine]] : []), ...(stakeNote ? [[stakeNote]] : [])];
  return [{ name: "竞彩完整", rows: [...headRows, XLSX_HEADERS, ...xrows] }];
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tierColor = (t) => /一档|二档/.test(t) ? "#2e7d32" : /三档/.test(t) ? "#f9a825" : /硬币/.test(t) ? "#6b7280" : "#ea580c";
const wldS = (s) => { if (/未开售/.test(s)) return "未开售"; const m = String(s).match(/(主胜|平局|客胜)\((\d+)%\)/); return m ? `${m[1][0]}${m[2]}%` : "—"; };
const scoreS = (s) => { const m = String(s).match(/(\d+)-(\d+)/); return m ? m[0] : "—"; };
const hfS = (s) => { const m = String(s).match(/(主胜|平局|客胜)-(主胜|平局|客胜)/); return m ? `${m[1][0]}-${m[2][0]}` : "—"; };
const ouS = (s) => { const m = String(s).match(/大(\d+)%/); return m ? `大${m[1]}` : "—"; };

// ── 异动雷达块(手机页·把排序因子+买法渲染成可读卡;纯展示·不改概率) ──
function radarBlockHtml(r) {
  const rad = buildAnomalyRadar(r);
  if (!rad.factors.length) return `<div class="drow radar"><b>🎯异动雷达</b>盘口各维度落常态区间·无突出异动<div class="rbuy">买法:${esc(rad.how)}</div></div>`;
  // 不截断:因子本就少且都是短句;尤其大小球走势(唯一z>4真edge)severity为🟢若截断会丢失,必须全显
  const fs = rad.factors.map((f) => `<div class="rf">${f.sev} <b>${esc(f.cat)}</b> <span class="rtag">${esc(f.tag)}</span> ${esc(f.text)}</div>`).join("");
  const upsetLine = rad.upset ? `<div class="rbuy">🎲若爆冷:${esc(rad.upset)}</div>` : "";
  return `<div class="drow radar"><b>🎯异动雷达·综合研判(方向跟盘口主推·只标风险不改概率)</b>${fs}${upsetLine}<div class="rbuy">🎯怎么打:${esc(rad.how)}</div></div>`;
}

// ── 🎯无死角三问卡(手机页·看胜负平/看大小球/看让球·五大过测高命中口袋·只在口袋出手) ──
function threeQBlockHtml(r) {
  const so = r.sanityOdds ?? {};
  const valid = (e) => e && [e.home, e.draw, e.away].every((x) => Number(x) > 1);
  const useEspn = !valid(so.euro) && valid(so.euroEspn);
  const euClose = valid(so.euro) ? so.euro : (useEspn ? so.euroEspn : null);
  if (!euClose) return "";
  const s = synthesize({ euClose, euOpen: valid(so.euro) ? so.euroInit : null, ahLineClose: so.ahLine ?? so.jcLine, ahLineOpen: so.ahLineInit ?? null,
    ouClose: so.over25, ouOpen: so.over25Init, waterHomeClose: so.ahHomeWater, waterHomeOpen: so.ahHomeWaterInit, waterAwayClose: so.ahAwayWater, waterAwayOpen: so.ahAwayWaterInit });
  if (!s) return "";
  const mk = s.markets;
  const wld = mk.胜负平.出手 ? `🎯${esc(mk.胜负平.方向)} <b>${esc(mk.胜负平.命中)}</b>${mk.胜负平.条件 ? ` <span class="g">(${esc(mk.胜负平.条件)})</span>` : ""}` : `<span class="g">沉默·${esc(mk.胜负平.方向)}</span>`;
  const ou = mk.大小球.出手 ? `🎯${esc(mk.大小球.方向)} <b>${esc(mk.大小球.命中)}</b>${mk.大小球.条件 ? ` <span class="g">(${esc(mk.大小球.条件)})</span>` : ""}` : `<span class="g">沉默·看主表</span>`;
  const dr = s.drawRisk ? `${esc(s.drawRisk.tier)}(估平${Math.round(s.drawRisk.drawRateEst * 100)}%)·${s.drawRisk.direction === "draw-guard" ? '<span class="w2">🔴防平</span>' : s.drawRisk.direction === "decisive" ? "🟢看胜负" : "中性"}` : "—";
  return `<div class="drow radar"><b>🎯无死角三问(五大过测高命中口袋·只在口袋出手)</b>` +
    `<div class="rf">①看胜负平: ${wld}</div>` +
    `<div class="rf">②看大小球: ${ou}</div>` +
    `<div class="rf">③看让球: <span class="g">${esc(mk.让球.结论)}</span></div>` +
    `<div class="rf">防平研判: ${dr}</div>` +
    `<div class="rbuy g">命中=五大全7赛季TEST真实双稳值;高命中≠盈利(收盘已定价)。让球过盘无高命中口袋。</div></div>`;
}

// ── 手机页(核心7列 + 点行展开全部;2026-06-09 用户选定专业版,绝不简化) ──
export function renderMobileHtml({ date, rows, riskNote, intlN, wcN, auditFoot, counts, degradeNote, parlayPlan = null, recordLine = null, stakeSum = null }) {
  // 头条副标题=逐赔种真计数(buildCoverageSubtitle 内部 fail-loud:counts 缺/非法直接 throw,绝不默认自吹"全覆盖")。
  const coverageSub = buildCoverageSubtitle(counts);
  // 降级句(buildDegradeNote 产物)进手机页头条 risk 块——与 xlsx banner 同口径,头条不再只有平局/硬币档提示。
  const riskBody = [degradeNote, riskNote || "只给信心+风险提示,方向以盘口为准。"].filter(Boolean).map((s) => esc(s)).join("<br>");
  const br = (s) => esc(s).replace(/\n/g, "<br>");
  const detail = (r) => radarBlockHtml(r) + threeQBlockHtml(r) + (r.primary ? `<div class="drow"><b>🎯盘口主推</b>${esc(r.primary.text)}<br><span class="g">${esc(r.primary.ref)}</span></div>` : "") +
    (r.wcLine ? `<div class="drow"><b>🏆赛会</b>${esc(r.wcLine)}</div>` : "") +
    (r.wcElo && r.wcElo !== "—" ? `<div class="drow"><b>🌍世界杯模型</b>Elo先验 ${esc(r.wcElo)}<br><span class="ind">场馆λ ${esc(r.wcLambda ?? "—")}</span></div>` : "") +
    (r.scen ? `<div class="drow"><b>情景</b>${esc(r.scen)}</div>` : "") +
    `<div class="drow"><b>胜负平(模型🔶参考)</b>${esc(r.wld)}<span class="g"> · 欧赔 ${esc(r.euro)}</span></div>` +
    (r.hv ? `<div class="drow"><b>让球真实裁决</b>${br(r.hv.text)}</div>` : "") +
    `<div class="drow"><b>让球${esc(r.hcP.line)}</b>模型 ${esc(r.hcP.model)}<br><span class="ind">市场 ${esc(r.hcP.market)}${r.hcP.diverge ? ` <span class="w2">⚠️以市场为准</span>` : ""}</span></div>` +
    `<div class="drow"><b>让球赔率</b>${esc(r.hc)}<br><b>博彩亚盘</b>${esc(r.asian)}</div>` +
    (r.signals ? `<div class="drow"><b>信号面板</b>${br(r.signals)}</div>` : "") +
    `<div class="drow"><b>比分</b>${br(r.score)}<span class="g"> · 赔率 ${esc(r.scoreMkt)}</span></div>` +
    `<div class="drow"><b>半全场</b>${br(r.halffull)}<span class="g"> · 赔率 ${esc(r.hfMkt)}</span></div>` +
    `<div class="drow"><b>大小球</b>${esc(r.ouReal)}<span class="g"> · 进球分布 ${esc(r.dist)}</span></div>` +
    // 📐盘口体检(细胞级精华·详见 xlsx「盘口合理性」):热门隐含 vs 同强度历史区间→深浅
    (r.sanity?.band ? `<div class="drow"><b>📐盘口体检</b>热门隐含${Math.round(r.sanity.favProb * 100)}% ${sanityVerdictLabel(r.sanity).tag}<span class="g"> · 同强度历史正常${Math.round(r.sanity.band.p5 * 100)}–${Math.round(r.sanity.band.p95 * 100)}%(详见xlsx盘口合理性表)</span></div>` : "") +
    // 🎲爆冷因子(细胞级精华·详见 xlsx「爆冷研判」):分型+热门不胜%+防平
    (r.upsetDiag ? `<div class="drow"><b>🎲爆冷因子</b>${esc(r.upsetDiag.upsetType ?? "—")} · 热门不胜${Math.round(r.upsetDiag.baseUpsetProb * 100)}%${r.drawImpliedPct >= 0.30 ? ' · <span class="w2">🔴防平</span>' : ""}${r.totalsMove?.lean && r.totalsMove.lean !== "无明显走势" ? ` · 大小球走势倾向${esc(r.totalsMove.lean)}` : ""}<span class="g">(详见xlsx爆冷研判表)</span></div>` : "") +
    `<div class="drow"><b>近5</b>${esc(r.homeRec)} <span class="g">${esc(r.homeLast5)}</span><br><span class="ind">${esc(r.awayRec)} <span class="g">${esc(r.awayLast5)}</span></span></div>` +
    `<div class="drow"><b>H2H</b>${esc(r.h2h)}</div>` +
    `<div class="drow"><b>攻防</b>${esc(r.profile)}</div>` +
    (r.stake ? `<div class="drow"><b>💰建议注金🔶</b>${esc(r.stake.text)}<span class="g">(分层建议)</span></div>` : "") +
    (r.parlay ? `<div class="drow"><b>串关</b>${esc(r.parlay.text)}</div>` : "") +
    (r.adv ? `<div class="adv"><b>${esc(r.adv.label)}${r.adv.ev != null ? ` · EV=${r.adv.ev}` : ""}</b><br>${esc(r.adv.kill)}<br><span class="g">三视角对抗证伪·只标注风险</span></div>` : "");
  const trs = rows.map((r) => `<tr class="r" onclick="tg(this)"><td class="m">${esc(r.match)}${r.adv && /证伪/.test(r.adv.label) ? ' <span class="kx">🔴</span>' : ""} <span class="ar">▾</span><i>${esc(r.ko)} · ${esc(r.comp)}</i></td><td><span class="b" style="background:${tierColor(r.tier)}">${Math.round(r.conf)}</span>${r.stake ? `<span class="stk">💰${r.stake.stake}</span>` : ""}</td><td>${esc(wldS(r.wld))}</td><td>${esc(r.hcP.line)}</td><td>${esc(scoreS(r.score))}</td><td>${esc(hfS(r.halffull))}</td><td>${esc(ouS(r.ouReal))}</td></tr><tr class="d"><td colspan="7">${detail(r)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>神选·竞彩·${date}</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,"Microsoft YaHei",system-ui,sans-serif;margin:0;background:#eef1f5;color:#1c2530;-webkit-text-size-adjust:100%}.wrap{max-width:720px;margin:0 auto;padding:14px 10px 40px}
.top{background:linear-gradient(135deg,#4A148C,#7b1fa2);color:#fff;border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 6px 18px rgba(74,20,140,.28)}.top h1{font-size:18px;margin:0 0 3px;font-weight:700}.top .sub{font-size:12px;opacity:.88}.legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.legend span{font-size:11px;background:rgba(255,255,255,.18);padding:3px 9px;border-radius:20px}
.risk{background:#fff;border-left:4px solid #d32f2f;border-radius:10px;padding:10px 13px;margin-bottom:12px;font-size:12.5px;line-height:1.55;box-shadow:0 1px 5px rgba(0,0,0,.06)}
.rec{background:#fff;border-left:4px solid #2e7d32;border-radius:10px;padding:9px 13px;margin-bottom:12px;font-size:12px;line-height:1.55;box-shadow:0 1px 5px rgba(0,0,0,.06);color:#2a3340}
.stk{display:block;margin-top:3px;font-size:10.5px;color:#7b1fa2;font-weight:700}
.hint{font-size:11.5px;color:#8a93a0;margin:0 4px 8px}
table.core{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(20,30,50,.08);font-size:13px}
table.core th{background:#4A148C;color:#fff;padding:10px 4px;font-weight:600;font-size:11.5px;text-align:center}table.core th:first-child{text-align:left;padding-left:12px}
.core .r{cursor:pointer;border-top:1px solid #eef0f3}.core .r td{padding:11px 4px;text-align:center;color:#1c2530;font-weight:600}
.core .r td.m{text-align:left;padding-left:12px;color:#2a1a4a}.core .r td.m i{display:block;font-style:normal;font-weight:400;color:#9097a3;font-size:10.5px;margin-top:2px}.core .r td.m .ar{color:#9333ea;font-size:11px}
.b{display:inline-block;min-width:26px;color:#fff;font-weight:700;font-size:12px;padding:3px 8px;border-radius:12px}
.core .d{display:none}.core .d.open{display:table-row}.core .d>td{padding:8px 13px 12px;background:#faf9fc}
.drow{padding:6px 0;font-size:12px;line-height:1.6;border-top:1px solid #efeaf6;color:#37404d}.drow:first-child{border-top:none}.drow b{color:#7e22ce;font-weight:700;margin-right:6px}.drow .g{color:#9aa6b4}.drow .ind{display:inline-block;margin-top:2px}.drow .w2{color:#d97706;font-weight:600}
.adv{margin-top:8px;background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #d32f2f;border-radius:8px;padding:8px 11px;font-size:11.5px;line-height:1.55;color:#7f1d1d}.adv b{color:#b91c1c;font-weight:700}.adv .g{color:#b08}.kx{display:inline-block;font-size:10px;background:#fde8e8;color:#b91c1c;border:1px solid #f5b5b5;border-radius:8px;padding:1px 6px;font-weight:700;vertical-align:middle}
.dl{display:block;text-align:center;margin:18px 2px 6px;padding:14px;background:#4A148C;color:#fff;border-radius:13px;text-decoration:none;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(74,20,140,.28)}
.drow.radar{background:linear-gradient(180deg,#faf5ff,#fff);border:1px solid #e9d5ff;border-radius:10px;padding:9px 11px;margin:6px 0}.drow.radar>b{display:block;color:#6b21a8;margin-bottom:5px;font-size:11.5px}
.rf{font-size:11.5px;line-height:1.5;padding:3px 0;border-top:1px dashed #f0e6fb;color:#3a3550}.rf:first-of-type{border-top:none}.rf b{color:#7e22ce;margin:0 4px 0 2px}.rtag{font-size:10px;color:#8b5cf6;background:#f3e8ff;border-radius:6px;padding:0 5px;margin-right:3px}
.rbuy{margin-top:6px;padding-top:5px;border-top:1px solid #ede0fb;font-size:11.5px;color:#9333ea;font-weight:600}
.foot{color:#9aa3af;font-size:11px;margin:12px 6px 0;line-height:1.55}</style></head><body><div class="wrap">
<div class="top"><h1>⚡ 神选 · 竞彩推荐</h1><div class="sub">${date} · ${rows.length}场${intlN ? ` 国际赛${intlN}` : ""}${wcN ? ` 世界杯${wcN}` : ""} · ${esc(coverageSub)}</div><div class="legend"><span>✅ 实测真盘</span><span>🔶 模型推断</span><span>⚠️ 缺口标缺不编</span></div></div>
${recordLine ? `<div class="rec">${esc(recordLine)}</div>` : ""}
<div class="risk">${riskBody}</div>
${stakeSum ? `<div class="rec" style="border-left-color:#7b1fa2">${esc(stakeSum)}</div>` : ""}
<div class="hint">👇 点任意一行 = 展开该场全部赔率/近5/H2H/攻防/建议注金</div>
<table class="core"><thead><tr><th>对阵 ▾</th><th>信心/注金</th><th>胜负平</th><th>让球</th><th>比分</th><th>半全</th><th>大小</th></tr></thead><tbody>${trs}</tbody></table>
${renderParlayHtmlSection(parlayPlan, { compact: true })}
<a class="dl" href="jingcai-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx(20列全字段·含对抗证伪)</a>
<div class="foot">真实端到端(${date})。5赔种=500竞彩XML(欧赔/让球/比分/半全场/总进球de-vig),亚盘+未开售场欧赔=ESPN/DraftKings,近5/H2H=ESPN。让球(让/受让后胜平负)=模型与市场两套数·分歧大以市场为准。缺口(国家队真xG/老H2H)诚实标。${esc(auditFoot)}</div>
<script>function tg(r){r.nextElementSibling.classList.toggle('open');var a=r.querySelector('.ar');if(a)a.textContent=r.nextElementSibling.classList.contains('open')?'▴':'▾';}</script>
</div></body></html>`;
}

// ── 手机页/英文页固定文件名防回退守护(2026-06-10 并行交付保护):──
//   webshare 固定文件名(今日足球推荐.html / football.html)若已被更新日期的交付占用(如并行会话已出明日表),
//   重出旧日期绝不顶掉新页 —— 改写日期命名副本(足球推荐-<date>.html / football-<date>.html)。
//   纯函数:只比对现页日期与本次交付日期,返回应写路径;现页缺/无日期/同日期/更旧 → 照常写固定文件名。
export function resolveHtmlWriteTarget({ existingHtml, date, canonicalPath, datedPath, dateRe }) {
  const cur = String(existingHtml ?? "").match(dateRe)?.[1] ?? null;
  if (cur && /^\d{4}-\d{2}-\d{2}$/.test(cur) && cur > date) {
    return { path: datedPath, preservedNewer: cur };
  }
  return { path: canonicalPath, preservedNewer: null };
}

// ── 英文固定URL页 football.html(手机收藏夹固定地址;缺陷#16:跟随当日,与 xlsx/手机页同源同日期) ──
export function renderEnglishHtml({ date, rows, riskNote, intlN, wcN, banner, auditFoot, parlayPlan = null, recordLine = null, stakeSum = null }) {
  const br = (s) => esc(s).replace(/\n/g, "<br>");
  const trs = rows.map((r) => `<tr><td>${esc(r.ko)}</td><td><b>${esc(r.match)}</b><br><span style="color:#7e57c2;font-size:11px">${esc(r.comp)}</span>${r.wcLine ? `<br><span style="font-size:11px">🏆 ${esc(r.wcLine)}</span>` : ""}${r.wcElo && r.wcElo !== "—" ? `<br><span style="color:#6a1b9a;font-size:11px">🌍世界杯模型 ${esc(r.wcElo)}·λ${esc(r.wcLambda ?? "—")}</span>` : ""}${r.scen ? `<br><span style="color:#888;font-size:11px">情景:${esc(r.scen)}</span>` : ""}${r.sanity?.band ? `<br><span style="color:#888;font-size:11px">📐热门隐含${Math.round(r.sanity.favProb * 100)}%${sanityVerdictLabel(r.sanity).tag}(正常${Math.round(r.sanity.band.p5 * 100)}–${Math.round(r.sanity.band.p95 * 100)}%)</span>` : ""}${r.upsetDiag ? `<br><span style="color:#888;font-size:11px">🎲${esc(r.upsetDiag.upsetType ?? "")}·热门不胜${Math.round(r.upsetDiag.baseUpsetProb * 100)}%${r.drawImpliedPct >= 0.30 ? "·🔴防平" : ""}</span>` : ""}</td><td>${esc(r.wld)}</td><td>${r.hv ? br(r.hv.text) : "—"}</td><td>${esc(r.hcView)}</td><td>${esc(r.score)}〔${esc(r.scoreSrc)}〕</td><td>${esc(r.halffull)}〔${esc(r.hfSrc)}〕</td><td>${esc(r.ouReal)}</td><td>${esc(r.tier)}<br>${Math.round(r.conf)}</td><td>${esc(r.stake?.text ?? "—")}</td><td>${esc(r.parlay?.text ?? "—")}</td></tr>`).join("");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡神选·足球·${date}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1a1a1a}
.wrap{max-width:960px;margin:0 auto;padding:12px}
h1{font-size:19px;margin:14px 4px}h2{font-size:16px;margin:18px 4px 8px;color:#4A148C}
.note{background:#fff8e1;border-left:4px solid #ffb300;padding:8px 10px;margin:8px 4px;font-size:13px;border-radius:4px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;font-size:12.5px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
th{background:#4A148C;color:#fff;padding:8px 6px;text-align:left;font-weight:600}
td{padding:7px 6px;border-top:1px solid #eee;vertical-align:top}
tr:nth-child(even) td{background:#faf8fd}
.dl{display:inline-block;margin:14px 4px;padding:10px 18px;background:#4A148C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}
.foot{color:#888;font-size:11px;margin:16px 4px 30px}
</style></head><body><div class="wrap">
<h1>⚡ 神选 · 足球推荐 · ${date}</h1>
<div class="note" style="border-color:#d32f2f;background:#ffebee">${esc(banner)}</div>
${recordLine ? `<div class="note" style="border-color:#2e7d32;background:#f1f8e9">${esc(recordLine)}</div>` : ""}
${riskNote ? `<div class="note">${esc(riskNote)}</div>` : ""}
${stakeSum ? `<div class="note" style="border-color:#7b1fa2;background:#f3e5f5">${esc(stakeSum)}</div>` : ""}
<h2>竞彩 · ${rows.length} 场(${intlN}国际赛 + ${wcN}世界杯单场)</h2>
<table><tr><th>开赛</th><th>对阵</th><th>胜负平</th><th>让球真实裁决</th><th>让球(模型vs市场)</th><th>比分</th><th>半全场</th><th>大小球</th><th>信心</th><th>💰注金🔶</th><th>串关</th></tr>${trs}</table>
${renderParlayHtmlSection(parlayPlan)}
<a class="dl" href="jingcai-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx(20列·含对抗证伪)</a>
<div class="foot">本页与 手机页/桌面 xlsx 同一渲染出口(today-full-coverage)生成 · 真实端到端(${date})。${esc(auditFoot)}</div>
</div></body></html>`;
}
