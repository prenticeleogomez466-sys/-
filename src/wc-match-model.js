// 世界杯【逐场】预测模型(2026-06-11 建)——铁律:世界杯比赛只用世界杯模型,绝不用每日俱乐部市场跟随路径。
// ════════════════════════════════════════════════════════════════════════════════════════
// 口径(2026-06-11 用户裁决):**模型自主观点优先**——1X2 直接取 WC 模型(国家队 Elo+洲际校正+东道主+海拔气温)
//   的 argmax 单选方向,即便与市场分歧也照给(不掺市场混合、不加防平双选兜底)。市场只做"分歧对照/风险旗标"。
// 把所有影响比赛走向的因素都纳入(用户 2026-06-11):
//   - 进概率(OOS 已验证有增益):国家队 Elo、洲际 Elo 偏置校正、东道主主场、场馆海拔/气温/室内、赛事阶段 → λ。
//   - 仅作透明"决定因素观察"(有真实数据但回测未证增益,不偷偷改概率):真实市场赔率(去抽水隐含)、模型vs市场分歧、教练、FIFA 排名/积分。
//   - ⚠️缺标注不编(铁律 no-fallback):首发/伤停(6/12 才出)、国家队近5/H2H(未接入则标待补)。
// 所有派生(比分/让球/大小球/半全场)从 WC-λ 真实泊松/负二项矩阵出,锚定 1X2 方向(wld-anchor)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { worldCupMatchPrior, teamPrior, confederationOf, worldCupLambdaContext } from "./world-cup-priors.js";
import { eloToLambdas } from "./national-elo-source.js";
import { buildDerivedScoreModel, bestScoreFromMatrix, handicapLadder, totalGoalsBands, scoreProbFromMatrix } from "./derived-score-model.js";
import { halfFullJoint } from "./halftime-fulltime-model.js";
import { devig } from "./market-devig.js";
import { recentForm, headToHead, loadIntlHistory } from "./wc-national-form.js";
import { matchPathScenario } from "./wc-qualification-scenario.js";
import { getDataSubdir } from "./paths.js";

// 小组赛【名次→淘汰赛路径】透明观察:懒加载 bracket/groups(中文队名→组字母),解析本场两队所属组的第1/第2名半区与R32对手位次。
let _wcBracket = null, _zhToGroup = null;
function wcGroupOf(homeZh, awayZh) {
  try {
    if (_wcBracket === null) {
      const dir = join(getDataSubdir("world-cup"), "2026");
      _wcBracket = JSON.parse(readFileSync(join(dir, "bracket.json"), "utf8"));
      const gdoc = JSON.parse(readFileSync(join(dir, "groups.json"), "utf8"));
      const zh = gdoc.team_name_zh || {};
      _zhToGroup = {};
      for (const [g, ens] of Object.entries(gdoc.groups)) for (const en of ens) _zhToGroup[zh[en] || en] = g;
    }
  } catch { _wcBracket = false; return null; }
  if (!_wcBracket) return null;
  const gh = _zhToGroup[homeZh], ga = _zhToGroup[awayZh];
  return gh && gh === ga ? { groupLetter: gh, bracketR32: _wcBracket.r32 } : null;
}

const CODE_CN = { "3": "主胜", "1": "平局", "0": "客胜" };
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const pc = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");

function argmaxCode(p) {
  const e = [["3", p.home], ["1", p.draw], ["0", p.away]].sort((a, b) => b[1] - a[1]);
  return { code: e[0][0], prob: e[0][1], second: e[1][0], secondProb: e[1][1] };
}

// 选最贴近 0.5 主队覆盖的整数让球线 = 模型公平让球线。
function fairHandicap(ladder) {
  let best = null;
  for (const r of ladder) {
    if (!Number.isInteger(r.line)) continue;
    const d = Math.abs(r.home - 0.5);
    if (!best || d < best.d) best = { line: r.line, home: r.home, push: r.push, away: r.away, d };
  }
  return best;
}

function topHalfFullFor(hfDist, code) {
  const want = CODE_CN[code];
  const ent = Object.entries(hfDist).filter(([k]) => k.endsWith("-" + want)).sort((a, b) => b[1] - a[1]);
  const all = Object.entries(hfDist).sort((a, b) => b[1] - a[1]);
  return { consistent: ent[0] ? { hf: ent[0][0], p: r4(ent[0][1]) } : null, mostLikely: all[0] ? { hf: all[0][0], p: r4(all[0][1]) } : null };
}

/**
 * 逐场世界杯预测。homeZh/awayZh=中文队名(生产口径);fixture=fixture-store 对象(供场馆/海拔/气温解析);
 * marketOdds={home,draw,away} 真实欧赔(可选);返回完整逐场分析对象或 { error }。
 */
export function predictWcMatch(homeZh, awayZh, fixture = {}, marketOdds = null, opts = {}) {
  const prior = worldCupMatchPrior(homeZh, awayZh, { hostHome: true });
  const hp = teamPrior(homeZh), ap = teamPrior(awayZh);
  // 近5战/H2H(真实 ESPN 国际赛赛果缓存;仅作透明决定因素观察,不改概率)。无缓存/无样本 → null(标缺)。
  const formCache = opts.formCache || null;
  const formHome = formCache && hp?.en ? recentForm(formCache, hp.en) : null;
  const formAway = formCache && ap?.en ? recentForm(formCache, ap.en) : null;
  const h2h = formCache && hp?.en && ap?.en ? headToHead(formCache, hp.en, ap.en, 6, loadIntlHistory().matches) : null;
  if (!prior || !hp?.elo || !ap?.elo) {
    return { error: `WC 模型无法解析(缺 Elo 先验):${homeZh}(${hp?.elo ?? "缺"}) / ${awayZh}(${ap?.elo ?? "缺"})` };
  }
  // ── 场馆/阶段 λ 乘子(海拔/气温/室内/赛制)——真实预报驱动 ──
  const matchDate = String(fixture.kickoff || fixture.matchDate || fixture.date || "").slice(0, 10) || null;
  const wcCtx = worldCupLambdaContext(fixture, matchDate);
  const lambdaMult = wcCtx.isWC ? wcCtx.lambdaMult : 1;
  // ── λ:Elo→supremacy,有效 Elo 差含东道主+洲际校正,与 1X2 同源;总进球受场馆乘子 ──
  const lam = eloToLambdas(hp.elo, ap.elo, { homeAdv: prior.homeAdv + prior.confedAdj, totalGoals: 2.5 * lambdaMult });
  const sm = buildDerivedScoreModel(lam.home, lam.away, { nbSize: 8, topN: 16 });
  if (!sm) return { error: `比分矩阵构造失败:${homeZh} vs ${awayZh}` };

  // ── 1X2 = WC 模型自主 argmax(单选方向,不防平) ──
  const pick = argmaxCode(prior.probabilities);
  const excluded = new Set();
  const scorePrimary = bestScoreFromMatrix(sm.matrix, pick.code, excluded);
  if (scorePrimary) excluded.add(scorePrimary);
  const scoreSecondary = bestScoreFromMatrix(sm.matrix, pick.code, excluded) ||
    bestScoreFromMatrix(sm.matrix, pick.second, new Set([scorePrimary]));
  const trueMostLikely = sm.topScores?.[0] || null;
  // ── 让球(整数线,竞彩口径) ──
  const ladderObj = handicapLadder(sm.matrix);
  const ladder = ladderObj.ladder || [];
  const fair = fairHandicap(ladder);
  // ── 大小球 ──
  const ou = totalGoalsBands(sm.matrix);
  // ── 半全场(联合分布,锚 wld) ──
  const hfDist = halfFullJoint(lam.home, lam.away, { nbSize: 8 });
  const hf = topHalfFullFor(hfDist, pick.code);

  // ── 真实市场赔率(去抽水隐含)+ 模型vs市场分歧(只作对照/风险旗标,不改概率) ──
  let market = null;
  if (marketOdds && marketOdds.home && marketOdds.draw && marketOdds.away) {
    const imp = devig({ home: marketOdds.home, draw: marketOdds.draw, away: marketOdds.away }, "shin");
    const mp = { home: r4(imp.home), draw: r4(imp.draw), away: r4(imp.away) };
    const mPick = argmaxCode(mp);
    const modelP = pick.code === "3" ? prior.probabilities.home : pick.code === "1" ? prior.probabilities.draw : prior.probabilities.away;
    const mktP = pick.code === "3" ? mp.home : pick.code === "1" ? mp.draw : mp.away;
    market = {
      odds: marketOdds, implied: mp, marketPickCode: mPick.code,
      agree: mPick.code === pick.code,
      edgeVsMarket: r4(modelP - mktP), // 模型给本方向的概率 − 市场隐含
      divergence: r4(Math.abs(prior.probabilities.home - mp.home) + Math.abs(prior.probabilities.away - mp.away))
    };
  }

  // ── 决定因素(排序:谁最能解释这场走向)──
  const factors = [];
  const eloGap = prior.eloDiff;
  factors.push({ key: "实力(Elo)", detail: `${hp.en} ${hp.elo} vs ${ap.en} ${ap.elo}(差 ${eloGap > 0 ? "+" : ""}${eloGap})`, weight: Math.abs(eloGap), tag: "✅实测" });
  if (prior.confedAdj) factors.push({ key: "洲际校正", detail: `${confederationOf(hp.en)} vs ${confederationOf(ap.en)} → Elo${prior.confedAdj > 0 ? "+" : ""}${prior.confedAdj}`, weight: Math.abs(prior.confedAdj), tag: "✅实测(OOS验证)" });
  if (prior.homeAdv) factors.push({ key: "东道主主场", detail: `${hp.en} 本土 +${prior.homeAdv} Elo`, weight: prior.homeAdv, tag: "✅实测" });
  if (wcCtx.isWC && wcCtx.venue) {
    const v = wcCtx.venue;
    const venueNote = [v.city, v.stadium, v.altitude_m ? `海拔${v.altitude_m}m` : null, v.temp ? `均温${v.temp}℃` : null, v.indoor ? "室内控温" : null].filter(Boolean).join("·");
    factors.push({ key: "场馆环境", detail: `${venueNote} → λ×${lambdaMult}`, weight: Math.abs(lambdaMult - 1) * 400, tag: "✅实测(真实预报)" });
  }
  if (market) factors.push({ key: "市场赔率", detail: `市场主推 ${CODE_CN[market.marketPickCode]}(${pc(market.implied[market.marketPickCode === "3" ? "home" : market.marketPickCode === "1" ? "draw" : "away"])})·${market.agree ? "与模型同向" : "⚠️与模型分歧"}`, weight: market.agree ? 50 : 150, tag: "✅实测(只作对照)" });
  if (formHome) factors.push({ key: "主队近况", detail: `${hp.en} 近${formHome.played}:${formHome.record}(${formHome.gf}:${formHome.ga})`, weight: 30, tag: "✅实测(只作观察)" });
  if (formAway) factors.push({ key: "客队近况", detail: `${ap.en} 近${formAway.played}:${formAway.record}(${formAway.gf}:${formAway.ga})`, weight: 30, tag: "✅实测(只作观察)" });
  if (h2h) factors.push({ key: "H2H", detail: `近${h2h.played}次交手 ${h2h.summary}`, weight: 25, tag: "✅实测(只作观察)" });
  factors.sort((a, b) => b.weight - a.weight);

  // ── 爆冷场景(2026-06-16 用户:检到爆冷必给"若爆冷会出什么"的具体比分/半全场/大小球·拿真盘说话)──
  //   热门不胜的两条路=①被逼平(头号·见复盘平局盲区)②被翻盘。全从真矩阵/真半全场联合分布派生,零编造。
  const upsetScenario = (() => {
    const revCode = pick.code === "3" ? "0" : pick.code === "0" ? "3" : null; // 反向(热门被翻盘)
    const drawScore = bestScoreFromMatrix(sm.matrix, "1");                    // 最可能平局比分(1-1/0-0)
    const revScore = revCode ? bestScoreFromMatrix(sm.matrix, revCode) : null;
    const over = r4((ou?.bands?.["3"] ?? 0) + (ou?.bands?.["4+"] ?? 0));      // 大于2.5
    const drawP = prior.probabilities.draw;
    const revP = revCode === "3" ? prior.probabilities.home : revCode === "0" ? prior.probabilities.away : null;
    return {
      drawProb: r4(drawP),
      drawScore, drawScoreProb: drawScore ? r4(scoreProbFromMatrix(sm.matrix, drawScore)) : null,
      drawHalfFull: hfDist?.["平局-平局"] != null ? r4(hfDist["平局-平局"]) : null,
      reverseProb: revP != null ? r4(revP) : null,
      reverseScore: revScore, reverseScoreProb: revScore ? r4(scoreProbFromMatrix(sm.matrix, revScore)) : null,
      overProb: over, goalsLean: over < 0.46 ? "小球(闷平低分)" : over > 0.56 ? "大球(对攻)" : "中性",
    };
  })();

  // ── 名次→淘汰赛路径(透明观察,不改概率;末轮情景由 caller 传 opts.groupTable/finalRound 时附带) ──
  const wcg = wcCtx.isWC && wcCtx.phase === "group" ? wcGroupOf(homeZh, awayZh) : null;
  const pathScenario = wcg ? matchPathScenario({
    bracketR32: wcg.bracketR32, groupLetter: wcg.groupLetter,
    table: opts.groupTable || null, home: homeZh, away: awayZh, finalRound: !!opts.finalRound,
  }) : null;
  if (pathScenario?.path) {
    const p1 = pathScenario.path.pos1, p2 = pathScenario.path.pos2;
    factors.push({
      key: "名次→淘汰赛路径",
      detail: `本组(${wcg.groupLetter})第1名落${p1.half}(对R32 ${p1.oppSlot}位)、第2名落${p2.half}(对R32 ${p2.oppSlot}位)——名次决定淘汰赛对手/半区,末轮算计动机源`,
      weight: 20, tag: "📐赛制结构(透明观察·不改概率)",
    });
    const sc = pathScenario.scenario;
    if (sc) {
      const TIER_CN = { "must-win": "必须取胜方能出线", "must-win-and-pray": "需取胜且看其他场配合", "draw-enough": "平局即可保前2", "win-to-secure": "需不败确保前2", "likely-through": "已基本锁定出线", "unknown": null };
      const tag = (s, who) => { const t = TIER_CN[s?.tier]; if (t) factors.push({ key: `末轮动机·${who}`, detail: `${t}(${s.note})`, weight: s.tier?.startsWith("must") ? 45 : 30, tag: "⚠️动机观察(不偷改概率)" }); };
      tag(sc.home, "主队"); tag(sc.away, "客队");
      if (sc.mutualDrawSuspect) factors.push({ key: "默契球嫌疑", detail: "双方均靠平局即可携手出线 → 平局概率上修嫌疑、进球偏低", weight: 50, tag: "⚠️动机观察(不偷改概率)" });
    }
  }
  factors.sort((a, b) => b.weight - a.weight);

  const gaps = [];
  if (!formHome || !formAway) gaps.push("部分队近2年国际赛样本缺(归一不到/未参赛)");
  if (!h2h) gaps.push("近2年内无交手记录(H2H 标缺)");
  gaps.push("首发/伤停未释放(6/12 才出,赛前自动重析推送)");

  return {
    home: homeZh, away: awayZh, matchDate, stage: wcCtx.isWC ? wcCtx.phase : null,
    elo: { home: hp.elo, away: ap.elo, diff: eloGap },
    fifa: { home: { rank: hp.fifa_rank, pts: hp.fifa_points }, away: { rank: ap.fifa_rank, pts: ap.fifa_points } },
    confed: { home: confederationOf(hp.en), away: confederationOf(ap.en), adj: prior.confedAdj },
    coach: { home: hp.coach || null, away: ap.coach || null },
    venue: wcCtx.isWC ? wcCtx.venue : null, lambdaMult, lambda: { home: r2(lam.home), away: r2(lam.away) },
    // 精确 λ(不四舍五入)——供每日大模型引擎路由用同一矩阵派生比分/半全场/让球,保证两处口径逐位一致。
    lambdas: { home: lam.home, away: lam.away, nbSize: 8 },
    wld: {
      probabilities: { home: r4(prior.probabilities.home), draw: r4(prior.probabilities.draw), away: r4(prior.probabilities.away) },
      pickCode: pick.code, pick: CODE_CN[pick.code], pickProb: r4(pick.prob),
      secondCode: pick.second, second: CODE_CN[pick.second], secondProb: r4(pick.secondProb),
      source: prior.source
    },
    score: { primary: scorePrimary, secondary: scoreSecondary, trueMostLikely, topScores: sm.topScores.slice(0, 6) },
    handicap: { fairLine: fair?.line ?? null, cover: fair ? { home: r4(fair.home), push: r4(fair.push), away: r4(fair.away) } : null, ladder: ladder.filter((x) => Number.isInteger(x.line)) },
    overUnder: ou,
    halfFull: hf,
    upsetScenario,
    pathScenario,
    market,
    recentForm: { home: formHome, away: formAway },
    h2h,
    decisiveFactors: factors,
    gaps
  };
}

// ════════════════════ 每日大模型融合接口(2026-06-11 用户最高指令:足球大模型=唯一大脑) ════════════════════
// 世界杯逐场模型作为大模型内部的"世界杯域模块":prediction-engine 对世界杯正赛场自动路由到这里,
// 0611 铁律(世界杯比赛必须用世界杯模型)由引擎结构本身保证,不再依赖人工选脚本。

/** ESPN 真实逐场赔率索引(match-odds.json,wc:odds-capture 续鲜)。缺档返回空索引(标缺不兜底)。 */
export function loadWcMatchOddsIndex() {
  const p = join(getDataSubdir("world-cup"), "2026", "match-odds.json");
  if (!existsSync(p)) return { idx: new Map(), collectedAt: null, source: null };
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    const idx = new Map();
    for (const f of o.fixtures ?? []) if (f.odds) idx.set(f.home, f.odds);
    return { idx, collectedAt: o.collectedAt ?? null, source: o.source ?? null };
  } catch {
    return { idx: new Map(), collectedAt: null, source: null };
  }
}

/**
 * 引擎路由入口:fixture 是 2026 世界杯正赛场且双方 48 强 Elo 齐 → 返回完整 WC 逐场预测;否则 null(走常规路径)。
 * marketOdds 优先级:竞彩真实欧赔(引擎快照)> ESPN match-odds 索引 > null(市场对照标缺)。
 */
export function wcEngineRoute(fixture, marketOdds = null, opts = {}) {
  const home = fixture?.homeTeam, away = fixture?.awayTeam;
  if (!home || !away) return null;
  const matchDate = String(fixture?.kickoff || fixture?.matchDate || fixture?.date || "").slice(0, 10) || null;
  const wcCtx = worldCupLambdaContext(fixture, matchDate);
  if (!wcCtx.isWC) return null;
  const hp = teamPrior(home), ap = teamPrior(away);
  if (!hp?.elo || !ap?.elo) return null;
  let odds = marketOdds;
  if (!odds && opts.oddsIndex && hp.en) {
    const o = opts.oddsIndex.get(hp.en);
    if (o && Number(o.home) > 1 && Number(o.draw) > 1 && Number(o.away) > 1) odds = o;
  }
  const res = predictWcMatch(home, away, fixture, odds || null, opts);
  return res?.error ? null : res;
}
