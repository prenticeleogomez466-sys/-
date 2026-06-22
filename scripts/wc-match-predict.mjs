#!/usr/bin/env node
/**
 * 世界杯【逐场】预测交付(2026-06-11)——铁律:世界杯比赛只用世界杯模型(src/wc-match-model.js),
 * 绝不用每日俱乐部市场跟随路径。口径:模型自主观点优先(argmax 单选,不防平),所有影响走向的因素全纳入/全展示。
 * 产出:神选深紫 xlsx(逐场推荐 + 决定因素全景 + 说明)落桌面稳定子文件夹 + JSON 基线(供复盘 wc:recap-match 用)。
 * 用法: node scripts/wc-match-predict.mjs [--json]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { canonicalTeamName } from "../src/team-aliases.js";
import { teamPrior } from "../src/world-cup-priors.js";
import { getExportDir } from "../src/paths.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { predictWcMatch } from "../src/wc-match-model.js";
import { loadNationalResults } from "../src/wc-national-form.js";
import { groupTable, remainingPairs } from "../src/wc-group-standings.js";
import { loadWcGroupContext, teamStandingLine, teamProblemLine } from "../src/wc-group-context.js";
import { getDataSubdir } from "../src/paths.js";
import { preflightOrDie } from "../src/preflight-selfcheck.js";

// 启动自检(2026-06-11 用户裁决:所有生成入口启动必检,红=拒跑;--skip-preflight 仅诊断)
await preflightOrDie("wc:predict 世界杯逐场表");

const WC_START = "2026-06-11", WC_END = "2026-07-19";
const ODDS_PATH = join(getExportDir(), "..", "football-model-data", "world-cup", "2026", "match-odds.json");
const STAGE_CN = { group: "小组赛", "round-of-32": "32强", "round-of-16": "16强", "quarter": "1/4", "semi": "半决赛", "final": "决赛" };
const pcf = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
const cn = (c) => ({ "3": "主胜", "1": "平局", "0": "客胜" }[c] || c);

/** 收集 store 内全部 2026 世界杯唯一对阵(按对阵+比赛日去重,优先带 result)。 */
function collectMatches() {
  const seen = new Map();
  for (const d of listFixtureDates()) {
    if (d < "2026-06-06" || d > WC_END) continue;
    for (const f of loadFixtures(d).fixtures) {
      const isWC = (f.tags || []).includes("worldcup") || /世界杯|World Cup/i.test(f.competition || "");
      if (!isWC) continue;
      const mk = String(f.kickoff || "").slice(0, 10) || f.localDate || d;
      if (mk < WC_START || mk > WC_END) continue;
      const key = [canonicalTeamName(f.homeTeam), canonicalTeamName(f.awayTeam)].sort().join("|") + "@" + mk;
      if (!seen.has(key)) seen.set(key, f);
    }
  }
  return [...seen.values()];
}

/** 真实赔率索引:英文主队名 → odds。 */
function loadOddsIndex() {
  if (!existsSync(ODDS_PATH)) return { idx: new Map(), collectedAt: null, source: null };
  const o = JSON.parse(readFileSync(ODDS_PATH, "utf8"));
  const idx = new Map();
  let collectedAt = null, source = null;
  for (const f of o.fixtures || []) {
    if (f.odds) idx.set(f.home, f.odds);
    if (f.collectedAt && (!collectedAt || f.collectedAt > collectedAt)) { collectedAt = f.collectedAt; source = f.source; }
  }
  return { idx, collectedAt, source };
}

/** 用真实已踢赛果(fixture-store,跨彩种去重)建 12 组当前积分榜 + 队→组索引 + 每队剩余场数。 */
function loadGroupTables() {
  const dir = join(getDataSubdir("world-cup"), "2026");
  const gdoc = JSON.parse(readFileSync(join(dir, "groups.json"), "utf8"));
  const zh = gdoc.team_name_zh || {};
  const ALIAS = { "刚果(金)": "刚果民主共和国", "刚果（金）": "刚果民主共和国" };
  const norm = (t) => ALIAS[t] || t;
  const groups = {};
  for (const [g, ens] of Object.entries(gdoc.groups)) groups[g] = ens.map((e) => zh[e] || e);
  // 收集真实已结算赛果并按对阵去重
  const seen = new Map();
  for (let d = 11; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    let fx; try { fx = loadFixtures(date); } catch { continue; }
    for (const f of (fx?.fixtures || [])) {
      if (!/世界杯|world/i.test(f.competition || "")) continue;
      if (f.result?.home == null || f.result?.away == null) continue;
      const h = norm(f.homeTeam), a = norm(f.awayTeam);
      seen.set([h, a].sort((x, y) => x.localeCompare(y, "zh")).join("|"), { home: h, away: a, ga: f.result.home, gb: f.result.away });
    }
  }
  const dedup = [...seen.values()];
  const playedPairs = new Set(seen.keys()); // 已踢对阵键(home|away 排序)
  const byGroup = {}, teamGroup = {}, remTeam = {};
  for (const [g, teams] of Object.entries(groups)) {
    for (const t of teams) teamGroup[t] = g;
    const gm = dedup.filter((m) => teams.includes(m.home) && teams.includes(m.away));
    const rem = remainingPairs(teams, gm);
    byGroup[g] = { teams, table: groupTable(teams, gm) };
    const rc = {}; for (const t of teams) rc[t] = 0;
    for (const [x, y] of rem) { rc[x]++; rc[y]++; }
    for (const t of teams) remTeam[t] = rc[t];
  }
  const pk = (a, b) => [a, b].sort((x, y) => x.localeCompare(y, "zh")).join("|");
  return { byGroup, teamGroup, remTeam, norm, playedPairs, pk };
}

function runMain() {
  const matches = collectMatches();
  const { idx: oddsIdx, collectedAt, source } = loadOddsIndex();
  const formCache = loadNationalResults();
  const today = new Date().toISOString().slice(0, 10);
  const grp = loadGroupTables();
  const wcGroupCtx = loadWcGroupContext(); // 真实ESPN正赛赛果→当前积分+面临问题(每场推荐都带,2026-06-22)

  const results = [];
  for (const f of matches) {
    const enHome = teamPrior(f.homeTeam)?.en;
    const odds = enHome ? oddsIdx.get(enHome) : null;
    // 名次路径/末轮动机:解析本场所属组 + 当前积分榜;末轮=两队各仅剩1场(即本场)。透明观察,不改概率。
    const hN = grp.norm(f.homeTeam), aN = grp.norm(f.awayTeam);
    const g = grp.teamGroup[hN];
    const gctx = g && grp.teamGroup[aN] === g ? grp.byGroup[g] : null;
    // 末轮收官战=本场对阵【本身未踢】且两队各仅剩1场(即互为 MD3 对手);已踢的 MD1/MD2 场不触发动机。
    const unplayed = !!gctx && !grp.playedPairs.has(grp.pk(hN, aN));
    const finalRound = unplayed && grp.remTeam[hN] === 1 && grp.remTeam[aN] === 1;
    const r = predictWcMatch(f.homeTeam, f.awayTeam, f, odds || null,
      { formCache, groupTable: gctx?.table || null, finalRound });
    if (r.error) { results.push({ home: f.homeTeam, away: f.awayTeam, matchDate: String(f.kickoff || "").slice(0, 10), error: r.error }); continue; }
    results.push(r);
  }
  results.sort((a, b) => (a.matchDate || "").localeCompare(b.matchDate || "") || a.home.localeCompare(b.home));

  const ok = results.filter((r) => !r.error);
  const diverge = ok.filter((r) => r.market && !r.market.agree);
  console.log(`\n=== 世界杯逐场预测(WC模型):${ok.length}/${results.length} 场出预测,${diverge.length} 场与市场分歧 ===`);
  for (const r of ok.slice(0, 30)) {
    console.log(`${(r.matchDate || "").slice(5)} ${r.home}vs${r.away}`.padEnd(26),
      `主推${r.wld.pick}${pcf(r.wld.pickProb)} 比分${r.score.primary} 让${r.handicap.fairLine}`,
      r.market ? (r.market.agree ? "·市同向" : "·⚠️市分歧") : "·无赔率");
  }

  // ── 神选深紫 xlsx ──
  const banner = `⚽ 2026世界杯 · 逐场预测(世界杯模型·模型自主观点) · ${today}`;
  const oddsNote = collectedAt ? `真实赔率源:${source || "ESPN core odds"}(抓取于 ${collectedAt.slice(0, 16).replace("T", " ")})` : "⚠️无真实赔率";

  // 表1:逐场推荐(核心)
  const mainHead = ["比赛日", "阶段", "对阵", "主推", "胜平负概率(主/平/客)", "次选", "比分首选", "比分次选", "真实众数",
    "让球线(模型)", "让球覆盖(主/走/客)", "大小球(2.5↑)", "半全场", "市场主推", "模型vs市场", "小组积分·面临问题(主/客)", "最强决定因素"];
  const mainRows = ok.map((r) => {
    const overUnder = r.overUnder ? (1 - (r.overUnder.bands["0"] + r.overUnder.bands["1"] + r.overUnder.bands["2"])) : null;
    return [r.matchDate || "—", STAGE_CN[r.stage] || r.stage || "—", `${r.home} vs ${r.away}`,
      r.wld.pick, `${pcf(r.wld.probabilities.home)}/${pcf(r.wld.probabilities.draw)}/${pcf(r.wld.probabilities.away)}`, r.wld.second,
      r.score.primary || "—", r.score.secondary || "—", r.score.trueMostLikely?.score || "—",
      r.handicap.fairLine ?? "—", r.handicap.cover ? `${pcf(r.handicap.cover.home)}/${pcf(r.handicap.cover.push)}/${pcf(r.handicap.cover.away)}` : "—",
      overUnder != null ? `大${pcf(overUnder)}` : "—",
      r.halfFull.consistent ? `${r.halfFull.consistent.hf}(${pcf(r.halfFull.consistent.p)})` : "—",
      r.market ? `${cn(r.market.marketPickCode)}` : "⚠️无",
      r.market ? (r.market.agree ? `同向 +${(r.market.edgeVsMarket * 100).toFixed(1)}pp` : `⚠️分歧 ${(r.market.edgeVsMarket * 100).toFixed(1)}pp`) : "—",
      ((t) => { const L = (nm) => { const s = teamStandingLine(wcGroupCtx, nm), p = teamProblemLine(wcGroupCtx, nm); return s ? `${nm}:${s}${p ? " · " + p : ""}` : `${nm}:⚠️无小组数据`; }; return `${L(r.home)}\n${L(r.away)}`; })(),
      r.decisiveFactors[0] ? `${r.decisiveFactors[0].key}:${r.decisiveFactors[0].detail}` : "—"];
  });

  // 表2:决定因素全景(所有影响走向的因素)
  const fmt = (f) => f ? `${f.record}(${f.gf}:${f.ga})` : "⚠️无样本";
  const facHead = ["对阵", "Elo(主/客/差)", "FIFA排名(主/客)", "洲际(主/客/校正)", "λ期望进球(主/客)",
    "场馆", "海拔m", "均温℃", "室内", "主队近5战", "客队近5战", "H2H(近2年)", "教练(主/客)",
    "真实赔率(主/平/客)", "市场去抽水隐含(主/平/客)", "数据缺口"];
  const facRows = ok.map((r) => [`${r.home} vs ${r.away}`,
    `${r.elo.home}/${r.elo.away}/${r.elo.diff > 0 ? "+" : ""}${r.elo.diff}`,
    `${r.fifa.home.rank ?? "?"}/${r.fifa.away.rank ?? "?"}`,
    `${r.confed.home}/${r.confed.away}/${r.confed.adj > 0 ? "+" : ""}${r.confed.adj}`,
    `${r.lambda.home}/${r.lambda.away}`,
    r.venue?.city ?? "⚠️缺", r.venue?.altitude_m ?? "—", r.venue?.temp ?? "—", r.venue?.indoor ? "是" : "否",
    fmt(r.recentForm?.home), fmt(r.recentForm?.away),
    r.h2h ? r.h2h.summary : "⚠️近2年无交手",
    `${r.coach.home || "?"} / ${r.coach.away || "?"}`,
    r.market ? `${r.market.odds.home}/${r.market.odds.draw}/${r.market.odds.away}` : "⚠️无",
    r.market ? `${pcf(r.market.implied.home)}/${pcf(r.market.implied.draw)}/${pcf(r.market.implied.away)}` : "—",
    (r.gaps && r.gaps.length ? r.gaps.join(";") : "—")]);

  const noteRows = [["说明 / 数据可追溯(铁律:不兜底,缺标缺)"],
    ["模型", "世界杯模型(src/wc-match-model.js):1X2=国家队Elo先验+洲际Elo偏置校正(OOS验证+1.31pp)+东道主主场;比分/让球/大小球/半全场=WC-λ负二项(nbSize=8)真实矩阵派生,锚定1X2方向。"],
    ["口径", "模型自主观点优先:主推=模型argmax单选方向,与市场分歧也照给(不防平/不掺市场混合)。市场赔率仅作分歧对照与风险旗标。"],
    ["✅实测", "Elo/FIFA/洲际/场馆海拔气温(真实预报)/真实赔率,均可追溯。"],
    ["🔶推断", "λ期望进球、比分/让球/大小球/半全场概率=由Elo+场馆派生(泊松/负二项矩阵)。"],
    ["✅新增", "国家队近5战/H2H 已接 ESPN 跨赛事真实赛果(fifa.friendly+欧国联+各洲世预赛,1526场缓存),仅作透明观察不改概率(回测未证form/H2H增益)。"],
    ["⚠️缺", "首发阵容/伤停(6/12才释放,首发一出自动重析推送);部分队近2年无国际赛样本/无近期交手 → 标缺不编。"],
    ["赔率", oddsNote + "。当前仅单一快照,『开盘→收盘』变化序列已起定时抓快照逐步建设。"],
    ["风险", "⚠️与市场分歧场=高风险(俱乐部回测:逆市场分歧命中更低);国家队市场是否同样有效待本届逐场回测坐实。命中率为辅,真KPI=CLV。下不下注由你定。"]];

  if (!existsSync(DESK_DIR())) mkdirSync(DESK_DIR(), { recursive: true });
  const xlsxPath = join(DESK_DIR(), `2026世界杯逐场预测_${today}.xlsx`);
  writeXlsxWorkbook(xlsxPath, [
    { name: "逐场推荐", rows: [[banner], [oddsNote], mainHead, ...mainRows] },
    { name: "决定因素全景", rows: [["⚽ 所有影响比赛走向的因素 · " + today], facHead, ...facRows] },
    { name: "说明", rows: noteRows }
  ]);
  console.log("\n📊 世界杯逐场预测表:", xlsxPath);

  const jsonPath = join(getExportDir(), "worldcup-match-predictions.json");
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), date: today, model: "wc-match-model", oddsCollectedAt: collectedAt, count: ok.length, divergeCount: diverge.length, results }, null, 1));
  console.log("🗂  JSON 基线:", jsonPath);

  if (process.argv.includes("--json")) console.log(JSON.stringify({ count: ok.length, diverge: diverge.map((r) => `${r.home}vs${r.away}`) }, null, 1));
}

function DESK_DIR() { return join(homedir(), "Desktop", "足球推荐", "世界杯"); }

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) runMain();
