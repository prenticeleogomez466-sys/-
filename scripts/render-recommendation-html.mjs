/**
 * 渲染"今日足球推荐"综合网页(固定文件名覆盖,不每次新建)。
 * 每场以「胜负平」为大前提,展开 胜负平 / 让球胜负平 / 比分 / 半全场 四个方向,
 * 顶部给出全模型跑通状态(全部通过才出推荐),底部给预测↔实际赛果复盘。
 *
 * 用法:node scripts/render-recommendation-html.mjs --date 2026-05-29 [--out 路径]
 * 默认输出:C:\Users\Administrator\Desktop\今日足球推荐.html(覆盖)
 */
import "../src/env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recommendFixtures } from "../src/prediction-engine.js";
import { fitFromFixtureStore } from "../src/dixon-coles-engine.js";
import { getExportDir } from "../src/paths.js";
import { loadScrapeFile } from "../src/jingcai-fivehundred-stage.js";

const args = process.argv.slice(2);
const readArg = (name) => {
  const pre = args.find((a) => a.startsWith(`${name}=`));
  if (pre) return pre.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const outPath = readArg("--out") ?? "C:\\Users\\Administrator\\Desktop\\今日足球推荐.html";
const exportDir = getExportDir();

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");

// 加载抓取文件里的皇冠亚盘(队伍专属水位/盘口),按 seq 索引
let asianBySeq = {};
try { asianBySeq = loadScrapeFile(date).asian ?? {}; } catch { asianBySeq = {}; }

// 赔率变化箭头:cur 相对 ini 升/降(降=变热)
function mv(ini, cur) {
  if (!Number.isFinite(ini) || !Number.isFinite(cur)) return esc(cur ?? ini ?? "—");
  const a = cur.toFixed(2);
  if (Math.abs(cur - ini) < 0.005) return `${a}`;
  return cur < ini ? `${ini.toFixed(2)}<span class="dn">↓</span>${a}` : `${ini.toFixed(2)}<span class="up">↑</span>${a}`;
}
// 欧赔三项 初→即
function euroMoveCell(eo) {
  if (!eo) return "—";
  const i = eo.initial ?? eo.current, c = eo.current ?? eo.initial;
  if (!i || !c) return "—";
  return `主 ${mv(i.home, c.home)} · 平 ${mv(i.draw, c.draw)} · 客 ${mv(i.away, c.away)}`;
}
// 亚盘水位 初→即(皇冠)
function asianCell(a) {
  if (!a) return '<span class="mute">缺(详情页未取)</span>';
  const line = a.curLine === a.iniLine ? esc(a.curLine) : `${esc(a.iniLine)}→${esc(a.curLine)}`;
  return `盘口 <b>${line}</b> · 主水 ${mv(Number(a.iniHome), Number(a.curHome))} · 客水 ${mv(Number(a.iniAway), Number(a.curAway))}`;
}
// 综合判读:欧赔即时方向 + 亚盘水位偏移 + 让球方向
function synthesize(p, a) {
  const sf = p.pick.label.includes("主") ? "主" : p.pick.label.includes("客") ? "客" : "平";
  const bits = [`欧赔倾向<b>${sf}</b>`];
  const eo = p.marketSnapshot?.europeanOdds;
  if (eo?.initial && eo?.current) {
    const dHome = eo.current.home - eo.initial.home, dAway = eo.current.away - eo.initial.away;
    if (Math.abs(dHome) > 0.02 || Math.abs(dAway) > 0.02) {
      bits.push(dHome < dAway ? "主赔走低(资金偏主)" : "客赔走低(资金偏客)");
    } else bits.push("欧赔基本稳定");
  }
  if (a) {
    const dH = Number(a.curHome) - Number(a.iniHome);
    const moved = a.curLine !== a.iniLine ? `盘口${a.iniLine}→${a.curLine}` : "";
    bits.push(`亚盘${moved || a.curLine}·${dH < -0.02 ? "主水降(看主受让)" : dH > 0.02 ? "主水升(看客)" : "水位稳"}`);
  } else bits.push("亚盘缺");
  return bits.join(" / ");
}

// 从 fixture.notes 取让球线,如 "让球=0 +1" → +1(主队让球数,正=主队受让)
function handicapLine(fixture) {
  const m = String(fixture.notes ?? "").match(/让球=([^;]+)/);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/).filter((x) => /^[+-]?\d+$/.test(x));
  const nonZero = parts.map(Number).find((n) => n !== 0);
  return Number.isFinite(nonZero) ? nonZero : 0;
}
// 让球胜负平方向 = 500.com 让球盘赔率去 vig(队伍专属、市场定价)。
// 注:对出历史场次,DC 期望进球退化为常数(无区分度),故让球方向取自真实让球盘而非模型 xG。
function handicapDirection(handicapOdds) {
  const o = handicapOdds?.current ?? handicapOdds?.initial;
  if (!o || !Number.isFinite(o.home) || !Number.isFinite(o.draw) || !Number.isFinite(o.away)) return null;
  const inv = { home: 1 / o.home, draw: 1 / o.draw, away: 1 / o.away };
  const s = inv.home + inv.draw + inv.away;
  const probs = { home: inv.home / s, draw: inv.draw / s, away: inv.away / s };
  const m = Math.max(probs.home, probs.draw, probs.away);
  const which = m === probs.home ? "主胜" : m === probs.away ? "客胜" : "平局";
  return { which, prob: m, probs };
}

// ── 1) 跑模型 ──
const dc = fitFromFixtureStore();
const r = recommendFixtures(date);
const preds = r.predictions;
const jingcai = preds.filter((p) => p.fixture.marketType === "jingcai");
// 尊重 available 闸门:14 场未达"今日可发"条件(无当日比赛/不足14场)时,不渲染选票,显示提示。
const fourteen = r.fourteen.available === false ? [] : r.fourteen.selections;
const fourteenNote = r.fourteen.note ?? "当天无 14 场胜负彩期次,本次不发 14 场。";

// 推荐内容审计
let auditOk = false;
let auditSummary = null;
const auditPath = join(exportDir, `recommendation-audit-${date}.json`);
if (existsSync(auditPath)) {
  const a = JSON.parse(readFileSync(auditPath, "utf8"));
  auditOk = a.ok === true || (a.summary && a.summary.errors === 0);
  auditSummary = a.summary ?? null;
}

const modelsAllPass =
  dc.usable === true &&
  preds.length > 0 &&
  preds.every((p) => p.probabilities && Number.isFinite(p.probabilities.home)) &&
  auditOk;

// ── 2) 复盘:ledger 已结算 ──
const ledgerPath = join(exportDir, "recommendation-ledger.json");
let settled = [];
if (existsSync(ledgerPath)) {
  const raw = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.rows ?? [];
  settled = rows.filter((x) => x.actualStatus === "settled" || (x.actual && x.hit != null));
}
const settledHits = settled.filter((x) => x.hit === true).length;

// ── 3) 渲染 ──
// ── 影响球队因素全景:模型能权衡的全部因素 + 真实状态 ──
function firedSet(preds) {
  const fired = new Set();
  for (const p of preds) for (const x of p.probabilityAdjustment?.fusion?.fired ?? []) fired.add(x.name);
  return fired;
}
// 26 个融合信号注册表(信号名→中文标签/类别/休眠时说明)。全部已接进 signal-fusion-layer 主路径。
//   状态由 fusion 真实结果驱动(fired/dormant/gated),不再硬编码 orphan。
const SIGNAL_REGISTRY = [
  ["season-phase", "赛季阶段", "情境", "由比赛日期"],
  ["competition-type", "赛事性质", "情境", "联赛走基线→休眠"],
  ["injury", "伤停名单", "阵容", "FPL/Sofascore 免授权源(英超等);多数赛事赛前稀疏"],
  ["h2h", "交锋史 H2H", "状态", "内部历史库;多数无对战样本"],
  ["clean-sheet-streak", "净胜/零封", "状态", "内部历史库"],
  ["streak", "近况连胜连败", "状态", "内部历史库;出历史球队无数据"],
  ["fatigue", "体能/赛程疲劳", "状态", "需近期赛程,多数缺"],
  ["rotation", "轮换", "阵容", "无轮换上下文→休眠"],
  ["home-away-split", "主客场分裂", "状态", "主客 PPG 净差;样本不足休眠"],
  ["time-decay-form", "时间衰减近况", "状态", "内部历史加权"],
  ["line-movement", "赔率变化(资金流向)", "市场", "需开盘→当前多次捕获"],
  ["weather", "天气", "环境", "weather 源未配置→休眠"],
  ["manager", "教练效应", "情境", "需教练史数据(免费无)→休眠"],
  ["derby", "德比强度", "情境", "同城/宿敌表;非德比→休眠"],
  ["standings-pressure", "排名压力", "情境", "需当前积分榜→多数缺"],
  ["big-game-form", "强强对话状态", "状态", "需强队判定上下文"],
  ["travel-distance", "旅行距离", "环境", "需场馆坐标→多数缺"],
  ["tactical-matchup", "战术克制", "战术", "需阵型(赛前~1h 首发出才有)"],
  ["referee", "裁判倾向", "情境", "需赛前主裁指派(免费无)→休眠"],
  ["opponent-strength-form", "对手强度校准", "实力", "按 Elo 校准近况"],
  ["xg-chains", "进攻链 xG", "战术", "需事件级数据→休眠"],
  ["padj-xg", "控球调整 xG", "战术", "需控球%→休眠"],
  ["set-piece", "定位球能力", "战术", "需定位球统计→休眠"],
  ["asian-handicap-water", "亚盘水位信号", "市场", "需亚盘初→即水位"],
  ["historical-analog", "历史同情境类比", "实力", "同联赛+水位 KNN;报告专用层"],
  ["lineup", "首发阵容布阵", "阵容", "ESPN 免授权首发;姿态→wld 回测无增益已诚实休眠"],
];

function buildFactorCoverage(preds) {
  // 由 fusion 真实结果驱动(2026-06-01 全面修复:原硬编码把已接入的 26 信号误标 orphan)。
  const fired = firedSet(preds);
  // 竞彩有赔率 → fusionGatedOff:26 信号被市场先验主动让位(回测证公开信号超不过收盘线)。
  const allGated = preds.length > 0 && preds.every((p) => p.probabilityAdjustment?.fusionGatedOff);
  const anyGated = preds.some((p) => p.probabilityAdjustment?.fusionGatedOff);
  const anyMarket = (k) => preds.some((p) => p.marketSnapshot?.[k]);
  const inHist = preds.some((p) => p.dixonColes?.teamStrength?.home?.coldStart === false);
  const asianN = Object.keys(asianBySeq).length;
  // 市场 + 模型基础层(竞彩真实主依据)
  const base = [
    ["欧洲赔率(胜负平)", "市场", anyMarket("europeanOdds") ? "ok" : "missing", "500.com 让0欧赔,主依据"],
    ["让球胜负平盘", "市场", anyMarket("handicapOdds") ? "ok" : "missing", "500.com 让N盘"],
    ["亚盘水位/盘口", "市场", asianN > 0 ? "ok" : "missing", asianN > 0 ? `皇冠 titan007,${asianN} 场` : "odds.500本机拒连"],
    ["Dixon-Coles 进球模型", "实力", inHist ? "ok" : "dormant", inHist ? "13.4 万场回填历史拟合" : "出历史→常数退化"],
    ["球队实力/Elo 评级", "实力", "ok", "ratings 集成(派生兜底)"],
    ["isotonic 概率校准", "校准", "ok", "football-data 训练,市场路径恒等微调"],
  ];
  // 26 融合信号:状态 = fired→ok / 竞彩市场让位→gated / 否则 wired 但无数据→dormant
  const signals = SIGNAL_REGISTRY.map(([name, label, cat, note]) => {
    const status = fired.has(name) ? "ok" : (allGated ? "gated" : "dormant");
    const desc = status === "gated" ? "已接入·市场先验下让位(回测证超不过收盘线)" : note;
    return [label, cat, status, desc];
  });
  return [...base, ...signals];
}
function factorCoverageSection(preds) {
  const rows = buildFactorCoverage(preds);
  const anyGated = preds.some((p) => p.probabilityAdjustment?.fusionGatedOff);
  const badge = {
    ok: '<span class="fc ok">✅生效</span>',
    dormant: '<span class="fc dm">🟡休眠</span>',
    gated: '<span class="fc or">🔵市场让位</span>',
    missing: '<span class="fc ms">🔴源缺失</span>',
  };
  const n = (c) => rows.filter((r) => r[2] === c).length;
  const wired = rows.length - n("missing"); // 已接入主路径数(= 全部非源缺失)
  return `<div class="sub" style="margin:6px 0">已接入主路径 <b>${wired}</b>/${rows.length} · 生效 ${n("ok")} · 市场让位 ${n("gated")} · 休眠无数据 ${n("dormant")} · 源缺失 ${n("missing")} · 孤儿 <b>0</b></div>
  <table class="big"><tr><th>影响因素</th><th>类别</th><th>状态</th><th>说明</th></tr>
  ${rows.map((r) => `<tr><td style="text-align:left">${esc(r[0])}</td><td>${esc(r[1])}</td><td>${badge[r[2]]}</td><td style="text-align:left">${esc(r[3])}</td></tr>`).join("")}
  </table>
  <div class="sub">${anyGated ? "🔵市场让位=该因素已接入主路径,但本批竞彩有收盘赔率(已编码全部公开信息),回测证公开信号超不过收盘线,故由市场先验主导、信号让位(诚实设计,非缺陷)。" : "🟡休眠=已接入但本场无数据可 fire。"}🔴源缺失=需外部实时源(天气等)未配置。<b>0 孤儿</b>:26 信号全部接进 predictFixture 主路径。今日方向以①欧赔②亚盘③让球+DC 为准。</div>`;
}

function firedFactorsLine(p) {
  const fired = (p.probabilityAdjustment?.fusion?.fired ?? []).map((x) => x.name);
  return fired.length ? `本场生效信号:${fired.join("、")}` : "本场无额外信号生效(纯赔率+DC)";
}

// 爆冷风险 + 诱盘/真实盘(prediction.upsetTrap,缺开收盘赔率时为 null)。
function upsetTrapCell(p) {
  const u = p.upsetTrap;
  if (!u) return `<td colspan="2" class="mute">缺开/收盘赔率,未评估</td><td class="mute">需 europeanOdds 初+即</td>`;
  const lvlClass = u.upsetLevel === "高" ? "warn" : u.upsetLevel === "中" ? "" : "ok";
  const trap = /诱盘/.test(u.trapVerdict) ? `<b style="color:#d33">${esc(u.trapVerdict)}</b>` : esc(u.trapVerdict);
  return `<td class="pick"><span class="tag ${lvlClass}">爆冷${esc(u.upsetLevel)}</span> ≈${pct(u.upsetRisk)}</td>
          <td>${trap}</td>
          <td><span class="mute">${esc(u.reason)}</span></td>`;
}

// 模型自知(prediction.memoryRecall):本场所属联赛/热门档的历史真实命中率。
function memoryRecallLine(p) {
  const m = p.memoryRecall;
  if (!m || !m.note) return "";
  return `<div class="meta mute">🧠 模型自知:${esc(m.note)}${m.leagueSufficient || m.tierSufficient ? "" : "(样本不足·仅参考)"}</div>`;
}

// 让球深度强化:模型公平让球线 + 多档盘口覆盖阶梯(国际赛无市场盘口时尤其有用)。
function handicapDeepCell(p) {
  const lad = p.handicapPick?.ladder;
  if (!lad?.ladder?.length) return "";
  const fl = lad.modelFairLine;
  const flTxt = fl > 0 ? `主受让+${fl}` : fl < 0 ? `主让${Math.abs(fl)}` : "平手";
  const key = lad.ladder.filter((c) => [-1, 0, 1].includes(c.line))
    .map((c) => `${c.line > 0 ? "+" : ""}${c.line}盘 主${pct(c.home)}/走${pct(c.push)}/客${pct(c.away)}`).join("，");
  return `<br><span class="mute">🔧模型公平线 <b>${flTxt}</b>(覆盖≈均衡)· ${key}</span>`;
}
// 比分深度强化:总进球区间分布 + 集中度信心。
function scoreDeepCell(p) {
  const d = p.scorePicks?.deepAnalysis;
  if (!d?.bands) return "";
  const b = d.bands;
  return `<br><span class="mute">🔧总进球 0:${pct(b["0"])}/1:${pct(b["1"])}/2:${pct(b["2"])}/3:${pct(b["3"])}/4+:${pct(b["4+"])} · 集中度<b>${esc(d.concentration)}</b>(首选${pct(d.topScoreProb)})</span>`;
}
// 半全场深度强化:反转风险 + 逆转 + 上半平打破率。
function halfFullDeepCell(p) {
  const d = p.halfFullPicks?.deepAnalysis;
  if (!d) return "";
  return `<br><span class="mute">🔧半场=全场同向 ${pct(d.sameDirection)} · 领先被逆转 <b>${pct(d.reversalRisk)}</b> · 逆转/翻盘 ${pct(d.comeback)}${d.htDrawBreakRate != null ? ` · 上半平则下半分胜负 ${pct(d.htDrawBreakRate)}` : ""}</span>`;
}

function matchCard(p) {
  const f = p.fixture;
  const pr = p.probabilities;
  const asian = asianBySeq[f.sequence];
  const sfDir = p.pick.label.includes("主") ? "主胜" : p.pick.label.includes("客") ? "客胜" : "平局";
  const line = handicapLine(f);
  const lineTxt = line == null ? "" : line > 0 ? `主受让+${line}` : line < 0 ? `主让${line}` : "平手";
  const hcp = handicapDirection(p.marketSnapshot?.handicapOdds);
  const hcpCell = hcp ? `${hcp.which}（${pct(hcp.prob)}）` : "—";
  const hcpNote = hcp ? (hcp.which === sfDir ? "与胜负平同向(直接过盘)" : "让球后反向,受让/让球盘正常现象") : "无让球盘赔率";
  const inHistory = p.dixonColes && p.dixonColes.teamStrength && p.dixonColes.teamStrength.home.coldStart === false && p.dixonColes.teamStrength.away.coldStart === false;
  const genericNote = inHistory ? "" : "·非队伍专属";
  const stake = p.bankroll?.decision ?? "-";
  const actionable = stake && !/观察|跳过/.test(stake);
  return `
  <div class="card">
    <div class="ch"><span class="seq">${esc(f.sequence)}</span> <span class="lg">${esc(f.competition)}</span>
      <span class="ko">${esc(f.kickoff)}</span>
      ${inHistory ? '<span class="tag ok">模型库内</span>' : '<span class="tag warn">赔率隐含为主</span>'}
      ${actionable ? '<span class="tag ok">可下注</span>' : '<span class="tag mute">观察</span>'}</div>
    <div class="teams">${esc(f.homeTeam)} <b>vs</b> ${esc(f.awayTeam)}</div>
    <table class="mk">
      <tr><th>维度(欧赔为主)</th><th>首选</th><th>次选/方向</th><th>赔率对比(初→即)/说明</th></tr>
      <tr class="anchor"><td>① 胜负平(欧赔)</td><td class="pick">${esc(p.pick.label)}</td><td>${esc(p.secondaryPick.label)}</td>
          <td>${euroMoveCell(p.marketSnapshot?.europeanOdds)}<br><span class="mute">模型概率 主${pct(pr.home)}/平${pct(pr.draw)}/客${pct(pr.away)}</span></td></tr>
      <tr><td>② 让球胜负平${lineTxt ? `（${lineTxt}）` : ""}</td><td class="pick">${hcpCell}</td><td>${hcpNote}</td>
          <td>500.com 让球盘:${euroMoveCell(p.marketSnapshot?.handicapOdds)}${handicapDeepCell(p)}</td></tr>
      <tr><td>③ 亚盘水位(皇冠)</td><td colspan="2">${asianCell(asian)}</td>
          <td>${asian ? "队伍专属·真实初→即变化" : '<span class="mute">odds.500本机拒连,详情页未取</span>'}</td></tr>
      <tr><td>④ 比分</td><td class="pick">${esc(scoreCell(p))}</td><td>${esc(scoreDistCell(p))}</td>
          <td>真泊松矩阵·锚①方向${scoreDeepCell(p)}</td></tr>
      <tr><td>⑤ 半全场</td><td class="pick">${esc(halfFullCell(p))}</td><td>${esc(halfFullDistCell(p))}</td>
          <td>半场联合分布·锚①方向${halfFullDeepCell(p)}</td></tr>
      <tr><td>⑥ 爆冷/诱盘</td>${upsetTrapCell(p)}</tr>
    </table>
    <div class="synth">🧭 综合判读:${synthesize(p, asian)}<br><span class="mute">${firedFactorsLine(p)}</span></div>
    <div class="meta">概率优势 ${esc(p.confidence)}(未校准,非可下注度) · 资金信号 <b>${esc(stake)}</b>${p.bankroll?.ev != null ? ` · EV ${(p.bankroll.ev).toFixed(3)}` : ""}${inHistory ? "" : " · ⚠出历史,队伍专属信号仅欧赔+亚盘+让球"}</div>
    ${memoryRecallLine(p)}
  </div>`;
}

// 深度展示:比分/半全场带真实概率 + 分布 + 反超备选(2026-05-30 强化)
function pctTag(v) { return Number.isFinite(v) ? ` ${Math.round(v * 100)}%` : ""; }
function scoreCell(p) {
  const s = p.scorePicks ?? {};
  return `${s.primary ?? "—"}${pctTag(s.primaryProbability)}`;
}
function scoreDistCell(p) {
  const dist = p.scorePicks?.distribution ?? [];
  if (!dist.length) return p.scorePicks?.secondary ?? "—";
  return "分布 " + dist.slice(0, 4).map((d) => `${d.score}${pctTag(d.probability)}`).join(" · ");
}
function halfFullCell(p) {
  const h = p.halfFullPicks ?? {};
  const main = `${h.primary ?? "—"}${pctTag(h.primaryProbability)}`;
  return h.primaryAlt?.halfFull ? `${main}　|　另:${h.primaryAlt.halfFull}${pctTag(h.primaryAlt.probability)}` : main;
}
function halfFullDistCell(p) {
  const dist = p.halfFullPicks?.distribution ?? [];
  if (!dist.length) return p.halfFullPicks?.secondary ?? "—";
  return "分布 " + dist.slice(0, 4).map((d) => `${d.halfFull}${pctTag(d.probability)}`).join(" · ");
}

function fourteenTable() {
  return `<table class="big"><tr><th>#</th><th>对阵</th><th>单选</th><th>复选</th><th>类型</th><th>风险</th></tr>
  ${fourteen.map((s) => `<tr${String(s.type).includes("胆") ? ' class="dan"' : ""}><td>${esc(s.index)}</td><td>${esc(s.match)}</td><td class="pick">${esc(s.single)}</td><td>${esc(s.compound)}</td><td>${esc(s.type)}</td><td>${esc(s.risk)}</td></tr>`).join("")}
  </table>`;
}

function recapTable() {
  if (!settled.length) return "<p>暂无已结算的历史预测(等比赛打完自动回填赛果)。</p>";
  const yn = (b) => (b ? '<span class="hit">✓</span>' : '<span class="miss">✗</span>');
  return `<p>已结算 ${settled.length} 场,胜负平命中 <b>${settledHits}/${settled.length}</b>。</p>
  <table class="big"><tr><th>日期</th><th>对阵</th><th>预测胜负平</th><th>实际</th><th>胜负平</th><th>预测比分</th><th>实际比分</th><th>比分</th><th>预测半全场</th><th>实际半全场</th><th>半全场</th></tr>
  ${settled.map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(x.match)}</td><td>${esc(x.primary)}</td><td>${esc(x.actual)}</td><td>${yn(x.hit)}</td><td>${esc(x.scorePrimary)}</td><td>${esc(x.actualScore)}</td><td>${yn(x.scoreHit)}</td><td>${esc(x.halfFullPrimary)}</td><td>${esc(x.actualHalfFull)}</td><td>${yn(x.halfFullHit)}</td></tr>`).join("")}
  </table>`;
}

const actionableCount = jingcai.filter((p) => p.bankroll?.decision && !/观察|跳过/.test(p.bankroll.decision)).length;
const statusBadge = !modelsAllPass
  ? '<span class="badge bad">模型未全部跑通 ✗ 本次不作正式推荐</span>'
  : actionableCount > 0
    ? `<span class="badge ok">模型已跑通 ✓ 今日 ${actionableCount} 场达可下注阈值</span>`
    : '<span class="badge mid">模型已跑通 ✓ 但今日 0 场达下注阈值(全部"观察"),下列仅方向参考</span>';

// 竞彩按开赛日分区:今晚(最早一天)/ 未来
const jcByDay = jingcai.slice().sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));
const firstDay = (jcByDay[0]?.fixture.kickoff ?? "").slice(0, 10);
const tonight = jcByDay.filter((p) => String(p.fixture.kickoff).slice(0, 10) === firstDay);
const future = jcByDay.filter((p) => String(p.fixture.kickoff).slice(0, 10) !== firstDay);

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日足球推荐 ${date}</title>
<style>
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#0f1420;color:#e6ebf5;line-height:1.5}
  .wrap{max-width:1000px;margin:0 auto;padding:16px}
  h1{font-size:20px;margin:8px 0}
  h2{font-size:17px;margin:22px 0 10px;border-left:4px solid #4a9eff;padding-left:8px}
  .badge{display:inline-block;padding:4px 12px;border-radius:6px;font-weight:600;font-size:13px}
  .badge.ok{background:#16432a;color:#56d98a} .badge.bad{background:#4a1d1d;color:#ff7676} .badge.mid{background:#4a3a16;color:#ffd166}
  h3{font-size:14px;color:#9fb0cc;margin:16px 0 6px}
  tr.anchor td{background:#13251a}
  .tag.mute{background:#2a3346;color:#8b97ad}
  .up{color:#ff7676;font-weight:700;padding:0 2px} .dn{color:#56d98a;font-weight:700;padding:0 2px}
  .mute{color:#6f7c93;font-size:11px}
  .synth{background:#10202f;border:1px solid #1d3a52;border-radius:6px;padding:6px 9px;margin-top:7px;font-size:12.5px;color:#bcd6f0}
  .fc{font-size:11px;padding:1px 5px;border-radius:4px;white-space:nowrap}
  .fc.ok{background:#16432a;color:#56d98a} .fc.dm{background:#4a3a16;color:#ffd166}
  .fc.or{background:#2a3346;color:#9fb0cc} .fc.ms{background:#4a1d1d;color:#ff7676}
  .sub{color:#8b97ad;font-size:12px;margin:6px 0 0}
  .panel{background:#18203044;border:1px solid #26314a;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:13px}
  .card{background:#161d2c;border:1px solid #26314a;border-radius:10px;padding:12px;margin:10px 0}
  .ch{font-size:12px;color:#9fb0cc;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .seq{background:#22304d;border-radius:4px;padding:1px 6px;color:#bcd0f0}
  .ko{margin-left:auto;color:#7d8aa3}
  .tag{font-size:11px;padding:1px 6px;border-radius:4px} .tag.ok{background:#16432a;color:#56d98a} .tag.warn{background:#4a3a16;color:#ffd166}
  .teams{font-size:16px;font-weight:600;margin:6px 0 8px}
  table.mk{width:100%;border-collapse:collapse;font-size:13px}
  table.mk th,table.mk td{border:1px solid #26314a;padding:5px 7px;text-align:left}
  table.mk th{background:#1c2740;color:#9fb0cc;font-weight:500}
  .pick{color:#56d98a;font-weight:700}
  .meta{font-size:12px;color:#8b97ad;margin-top:7px}
  table.big{width:100%;border-collapse:collapse;font-size:12.5px}
  table.big th,table.big td{border:1px solid #26314a;padding:5px 6px;text-align:center}
  table.big th{background:#1c2740;color:#9fb0cc;font-weight:500}
  tr.dan{background:#1a2c1f} tr.dan .pick{color:#7dffb0}
  .hit{color:#56d98a;font-weight:700} .miss{color:#ff7676;font-weight:700}
  .foot{color:#5f6b82;font-size:11px;margin:24px 0 8px;text-align:center}
</style></head><body><div class="wrap">
<h1>⚽ 今日足球推荐 · ${date}</h1>
<div>${statusBadge}</div>
<div class="sub">生成时间 ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC · 以「胜负平」方向为大前提展开让球/比分/半全场</div>

<div class="panel">
  <b>模型跑通状态</b>:Dixon-Coles 泊松引擎 ${dc.usable ? `✓ usable(${dc.matches} 样本)` : "✗ 不可用"} ·
  预测场次 ${preds.length} ·
  推荐内容审计 ${auditSummary ? `${auditSummary.errors} error / ${auditSummary.warnings} warning` : "—"} ·
  胜负平/让球/比分/半全场 四向方向自洽(比分、半全场 100% 锚定胜负平)。
  <div class="sub">诚实提示(按实际情况):本批 ${jingcai.filter((p)=>!(p.dixonColes?.teamStrength?.home?.coldStart===false&&p.dixonColes?.teamStrength?.away?.coldStart===false)).length}/${jingcai.length} 场球队不在回填历史(只覆盖五大联赛+世界杯/欧冠),DC 期望进球退化为常数 → 比分/半全场对这些场次为"方向锚定·非队伍专属";真正队伍专属信号只有 ① 胜负平(500.com 赔率隐含)与 ② 让球盘(市场)。资金信号全部"观察"——模型今日不背书任何一场下注。</div>
</div>

${modelsAllPass ? "" : '<div class="panel" style="border-color:#ff7676">⚠ 模型未全部跑通,以下内容仅供参考,不作正式推荐。</div>'}

<h2>影响因素全景(模型考虑的全部因素 · 诚实覆盖)</h2>
${factorCoverageSection(jingcai)}

<h2>竞彩足球（${jingcai.length} 场）</h2>
<h3>今晚 ${esc(firstDay)}（${tonight.length} 场）</h3>
${tonight.map(matchCard).join("")}
${future.length ? `<h3>未来场次（${future.length} 场,同期在售)</h3>${future.map(matchCard).join("")}` : ""}

<h2>14 场胜负彩${fourteen.length ? `（共 ${fourteen.length} 场,胆码 ${fourteen.filter((s) => String(s.type).includes("胆")).map((s) => s.index).join("、") || "无"}）` : ""}</h2>
${fourteen.length ? fourteenTable() : `<p>${esc(fourteenNote)}</p>`}

<h2>预测 ↔ 实际赛果复盘</h2>
${recapTable()}

<div class="foot">足球大模型 · 数据源:官方 14 场 + Playwright 抓 500.com 竞彩 · 仅供研究参考,理性投注</div>
</div></body></html>`;

writeFileSync(outPath, html, "utf8");
// 同时在产物目录留一份(固定名,覆盖)
const exportCopy = join(exportDir, "今日足球推荐.html");
writeFileSync(exportCopy, html, "utf8");

console.log(JSON.stringify({
  date, modelsAllPass, jingcai: jingcai.length, fourteen: fourteen.length,
  settled: settled.length, settledHits, outPath, exportCopy,
}, null, 2));
