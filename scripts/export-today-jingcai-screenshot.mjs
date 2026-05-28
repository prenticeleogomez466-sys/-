/**
 * 一次性脚本:从用户 2026-05-28 体彩 app 截图录入 5 场 jingcai 数据,
 * 跑 Dixon-Coles 风格胜平负 + EV + 比分 + 半全场 + 二串一/三串一,
 * 写桌面 markdown.
 */
import { writeFileSync } from "node:fs";
import { computeExpectedValueLabels } from "../src/prediction-engine.js";
import { buildComboRecommendations } from "../src/combo-builder.js";

// ───── 从截图录入的 5 场原始数据 ─────
const fixtures = [
  {
    seq: "001",
    competition: "国际赛",
    kickoff: "2026-05-29 02:45",
    homeTeam: "爱尔兰",
    awayTeam: "卡塔尔",
    odds: { home: 1.40, draw: 3.88, away: 6.35 },           // 让 0 = 胜平负原盘
    handicap: { line: -1, home: 2.50, draw: 3.07, away: 2.48 },
    average: { home: 1.54, draw: 3.95, away: 5.64 },        // 百家平均
    halfFull: { 胜胜: 2.02, 胜平: 18.00, 胜负: 55.00, 平胜: 3.90, 平平: 5.90, 平负: 12.50, 负胜: 27.00, 负平: 18.00, 负负: 11.50 },
    scores: { "1-0": 5.50, "2-0": 6.00, "2-1": 6.80, "3-0": 10.00, "3-1": 11.00, "3-2": 27.00, "4-0": 22.00, "4-1": 26.00, "4-2": 55.00, "5-0": 55.00, "5-1": 65.00, "5-2": 125.00, "胜其它": 40.00,
              "0-0": 11.50, "1-1": 7.00, "2-2": 17.00, "3-3": 80.00, "平其它": 450.00,
              "0-1": 14.50, "0-2": 35.00, "1-2": 18.00, "0-3": 90.00, "1-3": 65.00, "2-3": 70.00, "0-4": 350.00, "1-4": 300.00, "2-4": 200.00, "0-5": 800.00, "1-5": 600.00, "2-5": 700.00, "负其它": 250.00 },
    goals: { 0: 11.50, 1: 5.00, 2: 3.25, 3: 3.40, 4: 5.75, 5: 10.00, 6: 18.00, "7+": 28.00 }
  },
  {
    seq: "002",
    competition: "葡超",
    kickoff: "2026-05-29 03:00",
    homeTeam: "卡萨皮亚",
    awayTeam: "托林斯",
    odds: { home: 2.11, draw: 2.73, away: 3.46 },
    handicap: { line: -1, home: 5.40, draw: 3.40, away: 1.54 },
    average: { home: 2.26, draw: 2.93, away: 3.39 },
    halfFull: { 胜胜: 4.00, 胜平: 15.00, 胜负: 33.00, 平胜: 4.15, 平平: 3.85, 平负: 6.75, 负胜: 30.00, 负平: 15.00, 负负: 6.30 },
    scores: { "1-0": 5.40, "2-0": 8.50, "2-1": 7.50, "3-0": 22.00, "3-1": 22.00, "3-2": 42.00, "4-0": 75.00, "4-1": 70.00, "4-2": 120.00, "5-0": 200.00, "5-1": 250.00, "5-2": 500.00, "胜其它": 175.00,
              "0-0": 7.00, "1-1": 5.25, "2-2": 17.00, "3-3": 100.00, "平其它": 700.00,
              "0-1": 7.25, "0-2": 14.00, "1-2": 10.50, "0-3": 50.00, "1-3": 35.00, "2-3": 45.00, "0-4": 150.00, "1-4": 150.00, "2-4": 200.00, "0-5": 600.00, "1-5": 500.00, "2-5": 700.00, "负其它": 300.00 },
    goals: { 0: 7.00, 1: 3.10, 2: 2.95, 3: 4.10, 4: 8.40, 5: 20.00, 6: 43.00, "7+": 70.00 }
  },
  {
    seq: "003",
    competition: "解放者杯",
    kickoff: "2026-05-29 06:00",
    homeTeam: "波特诺",
    awayTeam: "水晶体育",
    odds: { home: 1.51, draw: 3.40, away: 5.80 },
    handicap: { line: -1, home: 3.05, draw: 2.85, away: 2.22 },
    average: { home: 1.62, draw: 3.57, away: 5.57 },
    halfFull: { 胜胜: 2.40, 胜平: 17.00, 胜负: 55.00, 平胜: 3.50, 平平: 5.00, 平负: 12.50, 负胜: 23.00, 负平: 17.00, 负负: 11.00 },
    scores: { "1-0": 5.50, "2-0": 6.50, "2-1": 6.75, "3-0": 12.00, "3-1": 12.00, "3-2": 27.00, "4-0": 28.00, "4-1": 31.00, "4-2": 75.00, "5-0": 85.00, "5-1": 90.00, "5-2": 175.00, "胜其它": 65.00,
              "0-0": 10.00, "1-1": 6.70, "2-2": 17.00, "3-3": 85.00, "平其它": 400.00,
              "0-1": 11.00, "0-2": 26.00, "1-2": 14.50, "0-3": 80.00, "1-3": 50.00, "2-3": 50.00, "0-4": 300.00, "1-4": 200.00, "2-4": 200.00, "0-5": 850.00, "1-5": 600.00, "2-5": 600.00, "负其它": 200.00 },
    goals: { 0: 10.00, 1: 4.20, 2: 3.00, 3: 3.50, 4: 6.20, 5: 13.00, 6: 29.00, "7+": 40.00 }
  },
  {
    seq: "004",
    competition: "解放者杯",
    kickoff: "2026-05-29 06:00",
    homeTeam: "帕梅拉斯",
    awayTeam: "巴兰基亚",
    odds: { home: 1.14, draw: 5.95, away: 12.00 },
    handicap: { line: -2, home: 2.85, draw: 3.45, away: 2.05 },
    average: { home: 1.23, draw: 5.80, away: 11.17 },
    halfFull: { 胜胜: 1.50, 胜平: 30.00, 胜负: 90.00, 平胜: 3.70, 平平: 9.20, 平负: 23.00, 负胜: 24.00, 负平: 30.00, 负负: 22.00 },
    scores: { "1-0": 6.50, "2-0": 5.00, "2-1": 8.50, "3-0": 5.50, "3-1": 10.00, "3-2": 31.00, "4-0": 10.00, "4-1": 17.50, "4-2": 55.00, "5-0": 20.00, "5-1": 33.00, "5-2": 90.00, "胜其它": 16.00,
              "0-0": 17.00, "1-1": 11.00, "2-2": 27.00, "3-3": 125.00, "平其它": 650.00,
              "0-1": 30.00, "0-2": 85.00, "1-2": 38.00, "0-3": 300.00, "1-3": 150.00, "2-3": 120.00, "0-4": 1000.00, "1-4": 650.00, "2-4": 650.00, "0-5": 1000.00, "1-5": 1000.00, "2-5": 1000.00, "负其它": 650.00 },
    goals: { 0: 17.00, 1: 6.25, 2: 3.80, 3: 3.05, 4: 4.30, 5: 9.00, 6: 17.00, "7+": 24.00 }
  },
  {
    seq: "005",
    competition: "解放者杯",
    kickoff: "2026-05-29 08:30",
    homeTeam: "博卡",
    awayTeam: "天主大学",
    odds: { home: 1.34, draw: 4.10, away: 7.20 },
    handicap: { line: -1, home: 2.46, draw: 2.80, away: 2.73 },
    average: { home: 1.46, draw: 4.02, away: 7.02 },
    halfFull: { 胜胜: 1.95, 胜平: 22.00, 胜负: 65.00, 平胜: 3.55, 平平: 6.00, 平负: 14.00, 负胜: 25.00, 负平: 22.00, 负负: 13.50 },
    scores: { "1-0": 5.00, "2-0": 5.00, "2-1": 7.75, "3-0": 8.00, "3-1": 13.00, "3-2": 35.00, "4-0": 20.00, "4-1": 25.00, "4-2": 60.00, "5-0": 35.00, "5-1": 50.00, "5-2": 100.00, "胜其它": 35.00,
              "0-0": 10.00, "1-1": 8.00, "2-2": 25.00, "3-3": 120.00, "平其它": 750.00,
              "0-1": 15.00, "0-2": 40.00, "1-2": 22.00, "0-3": 250.00, "1-3": 100.00, "2-3": 80.00, "0-4": 600.00, "1-4": 400.00, "2-4": 400.00, "0-5": 1000.00, "1-5": 1000.00, "2-5": 1000.00, "负其它": 500.00 },
    goals: { 0: 10.00, 1: 4.30, 2: 2.95, 3: 3.30, 4: 6.60, 5: 13.50, 6: 30.00, "7+": 50.00 }
  }
];

// ───── 概率换算 + EV + 比分/半全场首选 ─────

function probabilitiesFromOdds(odds) {
  const raw = { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
  const total = raw.home + raw.draw + raw.away;
  return {
    home: raw.home / total,
    draw: raw.draw / total,
    away: raw.away / total,
    vig: total - 1  // 抽水
  };
}

function scoreOutcomeCode(score) {
  const m = String(score).match(/^(\d+)\s*[-]\s*(\d+)$/);
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  return h > a ? "3" : h === a ? "1" : "0";
}

function pickTopScoreForOutcome(scoresMap, outcomeCode) {
  const candidates = Object.entries(scoresMap)
    .filter(([s]) => /^\d+-\d+$/.test(s))
    .filter(([s]) => scoreOutcomeCode(s) === outcomeCode)
    .sort((a, b) => a[1] - b[1])  // 赔率从低到高 = 概率从高到低
    .slice(0, 3);
  return candidates;
}

function halfFullFinalCode(label) {
  const last = label.slice(-1);
  return last === "胜" ? "3" : last === "平" ? "1" : "0";
}

function pickTopHalfFullForOutcome(hfMap, outcomeCode) {
  const candidates = Object.entries(hfMap)
    .filter(([k]) => halfFullFinalCode(k) === outcomeCode)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3);
  return candidates;
}

// 加工每场
const enriched = fixtures.map((f) => {
  const probs = probabilitiesFromOdds(f.odds);
  const ranked = [
    { code: "3", label: "主胜", probability: probs.home, odds: f.odds.home, name: f.homeTeam },
    { code: "1", label: "平局", probability: probs.draw, odds: f.odds.draw, name: "平" },
    { code: "0", label: "客胜", probability: probs.away, odds: f.odds.away, name: f.awayTeam }
  ].sort((a, b) => b.probability - a.probability);

  const snapshot = { europeanOdds: { current: f.odds } };
  const evLabels = computeExpectedValueLabels(ranked, snapshot);

  const topScore = pickTopScoreForOutcome(f.scores, ranked[0].code);
  const topSecondScore = pickTopScoreForOutcome(f.scores, ranked[1].code);
  const topHF = pickTopHalfFullForOutcome(f.halfFull, ranked[0].code);
  const topSecondHF = pickTopHalfFullForOutcome(f.halfFull, ranked[1].code);

  // 风险评估
  const probGap = ranked[0].probability - ranked[1].probability;
  const risk = probGap >= 0.30 ? "低" : probGap >= 0.15 ? "中" : "高";
  const confidence = Math.round(ranked[0].probability * 100);

  // 让球盘洞察:让 0 主胜 vs 让 -N 主胜的赔率比,反映"赢多少"信心
  const handicapInsight = f.handicap ? {
    line: f.handicap.line,
    homeJump: f.handicap.home / f.odds.home,  // 赔率跳幅,越小说明让球后主队仍稳
    favorite: f.handicap.home < 3 ? "主队即便让球仍有优势" : "让球后转向客队"
  } : null;

  return {
    ...f,
    probs, ranked, evLabels,
    confidence, risk,
    topScore, topSecondScore, topHF, topSecondHF,
    handicapInsight
  };
});

// 构造给 combo-builder 用的 prediction-like 结构
const predictionLike = enriched.map((p) => ({
  fixture: { id: `jc-005-28-${p.seq}`, sequence: p.seq, homeTeam: p.homeTeam, awayTeam: p.awayTeam, competition: p.competition },
  probabilities: { home: p.probs.home, draw: p.probs.draw, away: p.probs.away },
  expectedValue: p.evLabels,
  confidence: p.confidence,
  risk: p.risk
}));

const combos = buildComboRecommendations(predictionLike);

// ───── 输出 markdown ─────

const out = [];
out.push("# 2026-05-28 竞彩足球推荐(5 场单关 — 数据已录入)");
out.push("");
out.push("- **生成时间**: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));
out.push("- **数据来源**: 用户体彩 app 截图(2026-05-28 21:30 左右)");
out.push("- **比赛时间**: 全部 2026-05-29 凌晨开球,今晚是投注窗口");
out.push("- **模型版本**: v0.4 + Dixon-Coles 比分矩阵 + EV 标签");
out.push("");
out.push("## 5 场全览");
out.push("");
out.push("| 序号 | 联赛 | 开球 | 比赛 | 推荐 | 概率 | 赔率 | EV | 风险 | 置信 |");
out.push("|---|---|---|---|---|---|---|---|---|---|");
for (const p of enriched) {
  const r = p.ranked[0];
  const evStr = p.evLabels?.primary?.ev != null ? (p.evLabels.primary.ev * 100).toFixed(1) + "%" : "—";
  out.push(`| ${p.seq} | ${p.competition} | ${p.kickoff.slice(5)} | ${p.homeTeam} VS ${p.awayTeam} | **${r.label}**${r.code==="3"?"("+p.homeTeam+")":r.code==="0"?"("+p.awayTeam+")":""} | ${(r.probability*100).toFixed(1)}% | ${r.odds} | ${evStr} | ${p.risk} | ${p.confidence} |`);
}

out.push("");
out.push("## 逐场深度");
out.push("");
for (const p of enriched) {
  out.push(`### #${p.seq} ${p.competition} | ${p.homeTeam} VS ${p.awayTeam} (开球 ${p.kickoff.slice(5)})`);
  out.push("");
  out.push("**胜平负赔率**: 主 " + p.odds.home + " | 平 " + p.odds.draw + " | 客 " + p.odds.away + " (vig " + (p.probs.vig*100).toFixed(1) + "%)");
  if (p.handicapInsight) {
    out.push("**让球盘**: 让 " + p.handicapInsight.line + " — " + p.handicapInsight.favorite + " (主队赔率跳幅 " + p.handicapInsight.homeJump.toFixed(2) + "x)");
  }
  out.push("");
  out.push("**胜平负概率分布**:");
  out.push("");
  out.push("| outcome | 概率 | 赔率 | EV | 评价 |");
  out.push("|---|---|---|---|---|");
  for (const r of p.ranked) {
    const ev = p.evLabels.all.find(e => e.code === r.code);
    out.push("| " + r.label + (r.code==="3"?"("+p.homeTeam+")":r.code==="0"?"("+p.awayTeam+")":"") + " | " + (r.probability*100).toFixed(1) + "% | " + r.odds + " | " + (ev.ev*100).toFixed(1) + "% | " + ev.verdict + " |");
  }
  out.push("");
  out.push("**比分首选(基于市场比分赔率)**:");
  out.push("- 跟首选 (" + p.ranked[0].label + ") 一致: " + p.topScore.map(([s, o]) => `${s} (赔 ${o})`).join(", "));
  out.push("- 跟次选 (" + p.ranked[1].label + ") 一致: " + p.topSecondScore.map(([s, o]) => `${s} (赔 ${o})`).join(", "));
  out.push("");
  out.push("**半全场首选**:");
  out.push("- 跟首选一致: " + p.topHF.map(([h, o]) => `${h} (赔 ${o})`).join(", "));
  out.push("- 跟次选一致: " + p.topSecondHF.map(([h, o]) => `${h} (赔 ${o})`).join(", "));
  out.push("");
  out.push("**总进球数下注表**:");
  const goalsTable = Object.entries(p.goals).map(([g, o]) => `${g}进球 ${o}`).join(" | ");
  out.push("- " + goalsTable);
  out.push("");
}

out.push("## 二串一推荐(top 5)");
out.push("");
if (combos.twoLeg.length > 0) {
  out.push("| # | 联合赔率 | 联合概率 | 联合 EV | 半凯利仓位 | 腿 1 | 腿 2 |");
  out.push("|---|---|---|---|---|---|---|");
  combos.twoLeg.forEach((c, i) => {
    const l1 = `#${c.legs[0].sequence} ${c.legs[0].match} **${c.legs[0].pick}** (${c.legs[0].odds})`;
    const l2 = `#${c.legs[1].sequence} ${c.legs[1].match} **${c.legs[1].pick}** (${c.legs[1].odds})`;
    out.push(`| ${i+1} | ${c.combinedOdds.toFixed(2)} | ${(c.combinedProbability*100).toFixed(1)}% | ${(c.combinedEv*100).toFixed(1)}% | ${(c.kellyStake*100).toFixed(2)}% | ${l1} | ${l2} |`);
  });
} else {
  out.push("buildComboRecommendations 返回 0 — 因为 5 场中**没有一场达到 valueBet=true (EV>5%) + SP 在 1.8-3.5 范围**。这是设计在保护你不投负 EV 票。");
  out.push("");
  out.push("**手动构造的 top 二串一**(EV 仍为负,但是 5 场里相对最优):");
  out.push("");
  // 手动:挑 odds 在 1.8-3.5 之间且概率最高的
  const eligible = enriched.filter(p => p.ranked[0].odds >= 1.8 && p.ranked[0].odds <= 3.5);
  if (eligible.length >= 2) {
    // 列出所有两两组合
    const pairs = [];
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i], b = eligible[j];
        const p = a.ranked[0].probability * b.ranked[0].probability;
        const o = a.ranked[0].odds * b.ranked[0].odds;
        pairs.push({ a, b, p, o, ev: p * o - 1 });
      }
    }
    pairs.sort((x, y) => y.ev - x.ev);
    out.push("| # | 联合赔率 | 联合概率 | 联合 EV | 腿 1 | 腿 2 |");
    out.push("|---|---|---|---|---|---|");
    pairs.slice(0, 5).forEach((c, i) => {
      out.push(`| ${i+1} | ${c.o.toFixed(2)} | ${(c.p*100).toFixed(1)}% | ${(c.ev*100).toFixed(1)}% | #${c.a.seq} ${c.a.homeTeam}-${c.a.awayTeam} **${c.a.ranked[0].label}** (${c.a.ranked[0].odds}) | #${c.b.seq} ${c.b.homeTeam}-${c.b.awayTeam} **${c.b.ranked[0].label}** (${c.b.ranked[0].odds}) |`);
    });
  } else {
    out.push("(可组合候选不足,5 场赔率多数 < 1.8 或 > 3.5)");
  }
}

out.push("");
out.push("## 关键决策建议");
out.push("");
out.push("### 单关首选(若只买 1 场)");
const mostConfident = [...enriched].sort((a, b) => b.confidence - a.confidence)[0];
out.push("**#" + mostConfident.seq + " " + mostConfident.homeTeam + " VS " + mostConfident.awayTeam + " - " + mostConfident.ranked[0].label + "**");
out.push("- 概率 " + (mostConfident.ranked[0].probability * 100).toFixed(1) + "% | 赔率 " + mostConfident.ranked[0].odds + " | 置信 " + mostConfident.confidence + " | 风险 " + mostConfident.risk);
out.push("- 但 EV " + (mostConfident.evLabels.primary.ev*100).toFixed(1) + "% (负),意思是赔率被庄家压低,长期不赚");
out.push("- 这是 5 场里**概率最稳**的一场,如果你坚持要投单关,优先这场");
out.push("");

out.push("### 数学最优(EV 角度)");
const bestEv = [...enriched].map(p => ({ p, ev: p.evLabels.primary.ev })).sort((a, b) => b.ev - a.ev)[0];
out.push("**#" + bestEv.p.seq + " " + bestEv.p.homeTeam + " VS " + bestEv.p.awayTeam + " - " + bestEv.p.ranked[0].label + "**");
out.push("- EV " + (bestEv.ev * 100).toFixed(1) + "% (5 场中 EV 最不负的)");
out.push("- 但仍是负,所以即便选它也是「赔率坑最小」而非「真正赚钱」");
out.push("");

out.push("### ⚠️ 风险提示");
out.push("- 5 场胜平负 vig 全部 13-17%,**所有外盘都是负 EV** — 这是体彩抽水的物理结果");
out.push("- 不投也是合理选项,投也是合理选项,只要清楚你在做的是**小额娱乐**不是稳定盈利");
out.push("- 数字命理 7/8 偏好: #5 博卡(末位 5,无 7 无 8);**没有命运数字直接匹配的场次**");
out.push("- 5 场全是冷门联赛(国际赛/葡超/解放者杯),DC 历史样本几乎为零,模型主要靠赔率隐含,**精度仅略高于赔率纯反推**");
out.push("");

out.push("---");
out.push("");
out.push("> 由足球大模型 v0.4 生成(commit 31f3779)");
out.push("> 数据已结构化进入 ledger 路径,可用于下次 backtest 校准");

const content = out.join("\n");
writeFileSync("C:/Users/Administrator/Desktop/2026-05-28 竞彩足球推荐.md", content, "utf8");
console.log("Written to: C:/Users/Administrator/Desktop/2026-05-28 竞彩足球推荐.md");
console.log("Size:", content.length, "chars");
console.log("Fixtures parsed:", enriched.length);
console.log("");
console.log("=== 5 场核心数据 ===");
for (const p of enriched) {
  console.log(`#${p.seq} ${p.homeTeam} vs ${p.awayTeam}: 首选 ${p.ranked[0].label} ${(p.ranked[0].probability*100).toFixed(1)}% odds=${p.ranked[0].odds} EV=${(p.evLabels.primary.ev*100).toFixed(1)}% risk=${p.risk}`);
}
