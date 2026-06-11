#!/usr/bin/env node
/**
 * 世界杯实盘下注单(2026-06-11 用户四裁决落地):
 *   预算=不设固定上限但按场次质量给建议总额 | 玩法=单关SPF+让球+2-3小串+比分/半全场小注
 *   红场=全部保留只标注(买不买临场用户定) | 注金=平注分层(SPF/让球1U·串0.5U·比分/半全场0.25U)
 * 铁律:
 *   - 决策只来自世界杯模型 worldcup-match-predictions.json(0611铁律,不用每日大模型)
 *   - 赔率只用竞彩在售实价(market/<date>.json 500.com快照),买不到的价不上单
 *   - EV=模型概率×竞彩赔率-1 如实展示(多数为负=市场抽水+无edge的诚实现实)
 *   - 正EV若来自与市场分歧 → 标"回测证分歧越大市场越对",不伪装成捡漏
 * 用法: node scripts/build-wc-betting-slip.mjs [--date=YYYY-MM-DD] [--unit=20]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { preflightOrDie } from "../src/preflight-selfcheck.js";

// 启动自检(2026-06-11 用户裁决:所有生成入口启动必检,红=拒跑;--skip-preflight 仅诊断)
await preflightOrDie("wc:slip 实盘下注单");

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const DATE = arg("date", new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
const UNIT = Number(arg("unit", 20)); // 平注基础注(元/U),竞彩最低2元
const DATA = process.env.FOOTBALL_DATA_DIR || "D:\\football-model-data";
const EXP = process.env.FOOTBALL_EXPORT_DIR || "D:\\football-model-exports";

const pred = JSON.parse(readFileSync(path.join(EXP, "worldcup-match-predictions.json"), "utf8"));
if (pred.date !== DATE) { console.error(`预测JSON日期${pred.date}≠${DATE},先跑 npm run wc:predict`); process.exit(1); }
const market = JSON.parse(readFileSync(path.join(DATA, "market", `${DATE}.json`), "utf8"));
const snaps = (market.snapshots || []).filter((s) => s.competition === "世界杯" && s.marketType === "jingcai");
let adv = {};
try { adv = JSON.parse(readFileSync(path.join(DATA, "adversarial", `${DATE}.json`), "utf8")).verdicts || {}; } catch { /* 无对抗档如实缺标 */ }
const groups = JSON.parse(readFileSync(path.join(DATA, "world-cup", "2026", "groups.json"), "utf8"));
const md = JSON.parse(readFileSync(path.join(DATA, "world-cup", "2026", "match-dates.json"), "utf8")).matchDate;
const enOf = Object.fromEntries(Object.entries(groups.team_name_zh).map(([en, zh]) => [zh, en]));

const snapOf = new Map(snaps.map((s) => [`${s.homeTeam}|${s.awayTeam}`, s]));
const CODE = { 主胜: "home", 平局: "draw", 客胜: "away" };
const rows = [], skipped = [];
// 晨对抗审计裁决的是【旧每日模型】的推荐(0611已切世界杯模型),只作参考标注,
// 不再用它筛串关/定红场——本单红场判定以实时自评EV(模型概率×竞彩现价)为准,防张冠李戴。
const morningRef = (h, a) => { const v = adv[`${h}|${a}`]; return v && /🔴/.test(v.label) ? v : null; };
const kickoffOf = (h, a) => {
  const eh = enOf[h], ea = enOf[a];
  const m = Object.values(md).find((x) => (x.homeTeam === eh && x.awayTeam === ea) || (x.homeTeam === ea && x.awayTeam === eh));
  if (!m) return "";
  const t = new Date(Date.parse(m.dateUtc) + 8 * 3600e3);
  return `${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")} ${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
};
const evNote = (ev, agree) => {
  if (ev > 0 && agree === false) return "⚠️正EV源于与市场分歧·回测证分歧越大市场越对";
  if (ev <= -0.10) return "🔻模型自评亏" + (-ev * 100).toFixed(1) + "%";
  return "";
};

for (const r of pred.results) {
  const key = `${r.home}|${r.away}`;
  const s = snapOf.get(key);
  const red = morningRef(r.home, r.away);
  const kick = kickoffOf(r.home, r.away);
  const baseFlags = [];
  if (red) baseFlags.push(`🔶晨审计参考(对旧模型,EV${(red.ev * 100).toFixed(1)}%)`);
  if (r.market?.agree === false) baseFlags.push(`⚠️与市场分歧${(r.market.divergence * 100).toFixed(0)}pp`);
  if (!s) { skipped.push(`${key}: 竞彩快照缺(未开售/未抓到),整场不上单`); continue; }

  // A1 胜平负单关(竞彩SPF在售才上;未开售如实跳过该玩法)
  const spfOdds = s.europeanOdds?.current?.[CODE[r.wld.pick]];
  if (spfOdds > 1.01) {
    const ev = r.wld.pickProb * spfOdds - 1;
    rows.push({ section: "A主力·胜平负单关", match: key.replace("|", " vs "), kickoff: kick, play: "胜平负", pick: r.wld.pick, odds: spfOdds, modelProb: r.wld.pickProb, ev, stakeU: 1, flags: [...baseFlags, evNote(ev, r.market?.agree)].filter(Boolean) });
  } else skipped.push(`${key}: SPF未开售,单关跳过`);

  // A2 让球(竞彩线↔模型ladder对得上且方向概率过sanity才上,对不上如实跳过)
  const line = s.jingcaiHandicap?.line;
  const lad = (r.handicap?.ladder || []).find((x) => x.line === line);
  const hOdds = s.handicapOdds?.current;
  if (Number.isFinite(line) && lad && hOdds) {
    const side = lad.home >= lad.away ? "home" : "away";
    const p = lad[side], o = hOdds[side];
    if (o > 1.01 && p > 0.05 && p < 0.95) {
      const ev = p * o - 1;
      const dir = side === "home" ? "让球主胜" : "让球客胜";
      const same = (side === "home") === (r.wld.pick === "主胜") || (side === "away") === (r.wld.pick === "客胜");
      rows.push({ section: "A主力·让球", match: key.replace("|", " vs "), kickoff: kick, play: `让球(${line > 0 ? "+" : ""}${line})`, pick: dir, odds: o, modelProb: p, ev, stakeU: 1, flags: [...baseFlags, same ? "与胜平负同向" : "⚠️与胜平负不同向", evNote(ev, r.market?.agree)].filter(Boolean) });
    } else skipped.push(`${key}: 让球sanity不过(p=${p},o=${o}),跳过`);
  } else skipped.push(`${key}: 竞彩让球线${line}与模型ladder对不上,让球跳过(不硬凑)`);

  // C1 比分小注(模型首选比分,竞彩挂了才买)
  const sc = (s.scoreOdds?.top || []).find((x) => x.score === r.score.primary);
  if (sc) {
    const p = (r.score.topScores || []).find((x) => x.score === r.score.primary)?.probability ?? null;
    if (p) { const ev = p * sc.odds - 1; rows.push({ section: "C小注·比分", match: key.replace("|", " vs "), kickoff: kick, play: "比分", pick: r.score.primary, odds: sc.odds, modelProb: p, ev, stakeU: 0.25, flags: [...baseFlags, evNote(ev, r.market?.agree)].filter(Boolean) }); }
  } else skipped.push(`${key}: 竞彩未挂模型首选比分${r.score.primary},比分跳过`);

  // C2 半全场小注
  const hf = r.halfFull?.consistent ?? r.halfFull?.mostLikely;
  const hfo = (s.halfFullOdds?.top || []).find((x) => x.halfFull === hf?.hf);
  if (hf && hfo) { const ev = hf.p * hfo.odds - 1; rows.push({ section: "C小注·半全场", match: key.replace("|", " vs "), kickoff: kick, play: "半全场", pick: hf.hf, odds: hfo.odds, modelProb: hf.p, ev, stakeU: 0.25, flags: [...baseFlags, evNote(ev, r.market?.agree)].filter(Boolean) }); }
  else if (hf) skipped.push(`${key}: 竞彩未挂半全场${hf.hf},跳过`);
}

// B 小串(2串1/3串1): 腿=与市场同向+模型概率≥0.55+自评EV>-12%,按概率取top3
const legs = pred.results
  .filter((r) => r.market?.agree !== false && r.wld.pickProb >= 0.55)
  .map((r) => ({ r, s: snapOf.get(`${r.home}|${r.away}`) }))
  .filter((x) => {
    const o = x.s?.europeanOdds?.current?.[CODE[x.r.wld.pick]];
    return o > 1.01 && x.r.wld.pickProb * o - 1 > -0.12;
  })
  .sort((a, b) => b.r.wld.pickProb - a.r.wld.pickProb)
  .slice(0, 3);
const parlays = [];
const mkParlay = (sel) => ({
  legs: sel.map((x) => `${x.r.home} vs ${x.r.away}=${x.r.wld.pick}@${x.s.europeanOdds.current[CODE[x.r.wld.pick]]}`),
  combinedOdds: Number(sel.reduce((m, x) => m * x.s.europeanOdds.current[CODE[x.r.wld.pick]], 1).toFixed(2)),
  combinedProb: Number(sel.reduce((m, x) => m * x.r.wld.pickProb, 1).toFixed(4)),
  stakeU: 0.5,
});
if (legs.length >= 2) parlays.push({ name: "2串1", ...mkParlay(legs.slice(0, 2)) });
if (legs.length >= 3) parlays.push({ name: "3串1", ...mkParlay(legs.slice(0, 3)) });
for (const p of parlays) p.ev = p.combinedProb * p.combinedOdds - 1;

// D 14场胜负彩/任选9 逐腿裁决(0611用户要求:逐腿给 胆/防平/爆冷,全数据归因)
// 数据=世界杯模型全因素(Elo差/洲际校正/场馆海拔/平局概率/与市场分歧);胆规则含"中信心客胜不当胆"硬闸。
let fourteen = null;
try {
  const fx = JSON.parse(readFileSync(path.join(DATA, "fixtures", `${DATE}.json`), "utf8"));
  const sfRows = (Array.isArray(fx) ? fx : fx.fixtures || []).filter((m) => m.marketType === "shengfucai").sort((a, b) => Number(a.sequence) - Number(b.sequence));
  if (sfRows.length) {
    const predOf = new Map(pred.results.map((r) => [`${r.home}|${r.away}`, r]));
    const legsOut = [];
    for (const m of sfRows) {
      const r = predOf.get(`${m.homeTeam}|${m.awayTeam}`) || predOf.get(`${m.awayTeam}|${m.homeTeam}`);
      if (!r) { legsOut.push({ leg: Number(m.sequence), match: `${m.homeTeam} vs ${m.awayTeam}`, error: "世界杯模型无此场预测(如实标缺,不用每日模型顶)" }); continue; }
      const flipped = r.home !== m.homeTeam; // 期号腿主客与模型行反向时概率对调
      const P = r.wld.probabilities;
      const pHome = flipped ? P.away : P.home, pAway = flipped ? P.home : P.away, pDraw = P.draw;
      const dirs = [["主胜(3)", pHome], ["平局(1)", pDraw], ["客胜(0)", pAway]].sort((a, b) => b[1] - a[1]);
      const [pick, pickProb] = dirs[0]; const [second, secondProb] = dirs[1];
      const agree = r.market?.agree !== false;
      const isAwayPick = pick.startsWith("客");
      // 胆评级(硬闸:客胜中信心不当胆;与市场分歧不当胆)
      let banker = "✖不胆";
      if (pickProb >= 0.62 && pDraw < 0.25 && agree && (!isAwayPick || pickProb >= 0.62)) banker = "🎯可胆";
      else if (pickProb >= 0.55 && agree) banker = "🔸半胆";
      // 防平
      const drawGuard = pDraw >= 0.27 ? "🛡必防平(双选含1)" : pDraw >= 0.24 ? "⚠️平局偏高,建议防" : "";
      // 爆冷指数 = 模型给冷门方向的概率 + 分歧加成
      const upsetProb = Math.min(pHome, pAway);
      const upset = upsetProb >= 0.30 ? "🔥高" : upsetProb >= 0.20 ? "🌡中" : "❄低";
      // 复选建议(comboSigns=结构化方向集,供爆冷推演精确算覆盖,不靠解析文本)
      const signOf = (label) => (label.startsWith("主") ? "3" : label.startsWith("平") ? "1" : "0");
      let combo, comboSigns;
      if (Math.max(pHome, pDraw, pAway) < 0.45) { combo = "全包(3/1/0)"; comboSigns = ["3", "1", "0"]; }
      else if (pDraw >= 0.27) { combo = `双选 ${pick.slice(0, 2)}/平`; comboSigns = [...new Set([signOf(pick), "1"])]; }
      else if (secondProb >= 0.26) { combo = `双选 ${pick.slice(0, 2)}/${second.slice(0, 2)}`; comboSigns = [signOf(pick), signOf(second)]; }
      else { combo = `单选 ${pick.slice(0, 2)}`; comboSigns = [signOf(pick)]; }
      const reasons = [
        `Elo差${r.elo.diff > 0 ? "+" : ""}${r.elo.diff}`,
        r.confed?.adj ? `洲际校正${r.confed.adj > 0 ? "+" : ""}${r.confed.adj}` : "",
        r.venue?.altitude_m >= 1200 ? `高原${r.venue.altitude_m}m` : "",
        `平${(pDraw * 100).toFixed(0)}%`,
        agree ? "" : `⚠️与市场分歧${((r.market?.divergence ?? 0) * 100).toFixed(0)}pp`,
      ].filter(Boolean).join("·");
      legsOut.push({
        leg: Number(m.sequence), match: `${m.homeTeam} vs ${m.awayTeam}`, kickoff: kickoffOf(m.homeTeam, m.awayTeam) || kickoffOf(m.awayTeam, m.homeTeam),
        probs: { home: pHome, draw: pDraw, away: pAway },
        pick, pickProb, combo, comboSigns, banker, drawGuard, upset, upsetProb, reasons,
      });
    }
    // 任选9 = 按可靠度取9腿(排除不可胆的客胜中信心/分歧场进九,除非不足9再按概率补足并标注)
    const sortable = legsOut.filter((l) => !l.error);
    const prefer = sortable.filter((l) => l.banker !== "✖不胆").sort((a, b) => b.pickProb - a.pickProb);
    const rest = sortable.filter((l) => l.banker === "✖不胆").sort((a, b) => b.pickProb - a.pickProb);
    const nine = [...prefer, ...rest].slice(0, 9);
    // ── 爆冷情景推演(2026-06-11 用户追问"爆冷会出现在哪场/为什么/根据什么/什么后果")──
    // 🔶推断:全部由上方✅世界杯模型逐腿真实概率派生(腿间独立假设,如实标注);零兜底,标缺腿不进推演。
    const okLegs = legsOut.filter((l) => !l.error);
    const probOfSign = (l, s) => (s === "3" ? l.probs.home : s === "1" ? l.probs.draw : l.probs.away);
    for (const l of okLegs) {
      // 冷门方向=主/客中概率更低者(平局走"防平"通道,不算爆冷)
      const cold = l.probs.home <= l.probs.away ? ["主胜", "3", l.probs.home] : ["客胜", "0", l.probs.away];
      l.upsetDir = cold[0]; l.upsetSign = cold[1]; l.upsetDirProb = cold[2];
      const covered = l.comboSigns.includes(cold[1]);
      l.upsetConsequence = covered
        ? `复选已护住冷向(${l.combo})`
        : `复选未含${cold[0]}——该腿爆冷则单选/复选票全死`;
    }
    // Poisson-binomial 精确命中分布(DP):单选票(每腿只买主选)
    const hitDist = (ps) => { let d = [1]; for (const p of ps) { const n = new Array(d.length + 1).fill(0); for (let k = 0; k < d.length; k++) { n[k] += d[k] * (1 - p); n[k + 1] += d[k] * p; } d = n; } return d; };
    const singleDist = hitDist(okLegs.map((l) => l.pickProb));
    const nLegs = okLegs.length;
    const expHits = okLegs.reduce((s, l) => s + l.pickProb, 0);
    // 复选票(按上方复选建议买):每腿覆盖概率=所选方向概率和;注数=各腿选项数连乘
    const coverPs = okLegs.map((l) => Math.min(1, l.comboSigns.reduce((s, g) => s + probOfSign(l, g), 0)));
    const comboAll = coverPs.reduce((s, p) => s * p, 1);
    const comboTickets = okLegs.reduce((s, l) => s * l.comboSigns.length, 1);
    // 最可能爆冷腿(按冷向真实概率排序)+ 最可能双冷组合(联合概率)
    const topUpset = [...okLegs].sort((a, b) => b.upsetDirProb - a.upsetDirProb).slice(0, 5)
      .map((l) => ({ leg: l.leg, match: l.match, dir: l.upsetDir, prob: Number(l.upsetDirProb.toFixed(3)), reasons: l.reasons, consequence: l.upsetConsequence }));
    const pairs = [];
    for (let i = 0; i < okLegs.length; i++) for (let j = i + 1; j < okLegs.length; j++) pairs.push({ legs: [okLegs[i].leg, okLegs[j].leg], matches: `${okLegs[i].match} + ${okLegs[j].match}`, prob: okLegs[i].upsetDirProb * okLegs[j].upsetDirProb });
    const topPairs = pairs.sort((a, b) => b.prob - a.prob).slice(0, 3).map((p) => ({ ...p, prob: Number(p.prob.toFixed(4)) }));
    // 任选9 风险腿=入九名单里冷向概率最高的两腿(任选9不可换腿,这两腿是票的命门)
    const nineRisk = [...nine].sort((a, b) => (b.upsetDirProb ?? 0) - (a.upsetDirProb ?? 0)).slice(0, 2)
      .map((l) => `${l.leg}腿 ${l.match}(冷向${l.upsetDir}${((l.upsetDirProb ?? 0) * 100).toFixed(0)}%)`);

    fourteen = {
      period: sfRows[0]?.officialFixtureId?.split("-")[0] ?? "",
      legs: legsOut,
      bankers: legsOut.filter((l) => l.banker === "🎯可胆").map((l) => l.leg),
      drawGuards: legsOut.filter((l) => l.drawGuard.startsWith("🛡")).map((l) => l.leg),
      upsetWatch: legsOut.filter((l) => l.upset === "🔥高").map((l) => l.leg),
      renxuan9: {
        legs: nine.map((l) => l.leg).sort((a, b) => a - b),
        picks: nine.sort((a, b) => a.leg - b.leg).map((l) => `${l.leg}:${l.pick.slice(0, 2)}`),
        combinedProb: Number(nine.reduce((s, l) => s * l.pickProb, 1).toFixed(4)),
        riskLegs: nineRisk,
        note: "9腿全中概率=连乘(诚实小数字),复选加保按预算自定",
      },
      upsetScenario: {
        assumption: "🔶推断:由世界杯模型逐腿真实概率派生(腿间独立假设);爆冷=主/客中概率更低方向胜出,平局风险走防平通道",
        singleTicket: {
          pAllHit: Number((singleDist[nLegs] ?? 0).toFixed(5)),
          pAtLeast13: Number(((singleDist[nLegs] ?? 0) + (singleDist[nLegs - 1] ?? 0)).toFixed(5)),
          expHits: Number(expHits.toFixed(2)),
          note: `${nLegs}腿全单选(每腿1注共1注=2元)`,
        },
        comboTicket: {
          pAllHit: Number(comboAll.toFixed(5)),
          tickets: comboTickets,
          costYuan: comboTickets * 2,
          note: "按逐腿复选建议(单选/双选/全包)投注的全中率与注数成本",
        },
        topUpsetLegs: topUpset,
        topColdPairs: topPairs,
      },
    };
  }
} catch (e) { fourteen = { error: `14场装配失败: ${e.message}` }; }

const totalU = rows.reduce((s, r) => s + r.stakeU, 0) + parlays.reduce((s, p) => s + p.stakeU, 0);
const greenU = rows.filter((r) => r.ev > -0.08).reduce((s, r) => s + r.stakeU, 0) + parlays.reduce((s, p) => s + p.stakeU, 0);
const slip = {
  date: DATE, generatedAt: new Date().toISOString(),
  source: { model: pred.model, predictionsAt: pred.generatedAt, jingcaiOddsAt: snaps[0]?.collectedAt ?? null, adversarialMatches: Object.keys(adv).length },
  policy: { budget: "不设固定上限·按场次质量浮动(建议总额给明白账)", plays: "SPF单关+让球+2-3小串+比分/半全场小注", redHandling: "全部保留只标注(买否临场用户定)", staking: `平注 1U=${UNIT}元(SPF/让球1U·串0.5U·比分/半全场0.25U)`, unit: UNIT },
  rows, parlays, skipped, fourteen,
  totals: {
    rowsCount: rows.length, parlayCount: parlays.length, totalU,
    suggestedAmount: Math.round(totalU * UNIT),
    greenU, suggestedCoreAmount: Math.round(greenU * UNIT),
    note: "全单=照你裁决全保留;主力额=剔除自评EV<-8%后的核心仓(拿自己钱我只买这部分)",
  },
  honesty: "模型无超额edge,1X2天花板≈市场50-55%;EV多为负=竞彩抽水的诚实现实;本单是校准概率+纪律工具,不是盈利保证。",
};
const out = path.join(EXP, `wc-betting-slip-${DATE}.json`);
writeFileSync(out, JSON.stringify(slip, null, 1));
const stable = `C:\\Users\\Administrator\\Desktop\\足球推荐\\${DATE}`;
mkdirSync(stable, { recursive: true });
writeFileSync(path.join(stable, `实盘下注单-${DATE}.json`), JSON.stringify(slip, null, 1));
console.log(`✅ 下注单: ${rows.length}注+${parlays.length}串 | 建议总额=${totalU}U=${Math.round(totalU * UNIT)}元(1U=${UNIT}) | 跳过${skipped.length}项(全部如实记录)`);
console.log(`   红场保留: ${rows.filter((r) => r.flags.some((f) => f.includes("🔴"))).length / 4 | 0}场带🔴标注`);
console.log(`   ${out}`);
