import { analyzeMatch } from "../src/match-archetype-analyzer.js";

// 三场刻意做成不同原型,验证分析是否"逐场不同重点"
const cases = [
  {
    name: "① 英超·强弱深盘·锋线伤停",
    fixture: { competition: "英超", homeTeam: "曼城", awayTeam: "卢顿" },
    marketImpliedProbabilities: { home: 0.78, draw: 0.14, away: 0.08 },
    probabilities: { home: 0.76, draw: 0.15, away: 0.09 },
    pick: { code: "3", label: "主胜", probability: 0.76 },
    confidence: "高", risk: "中",
    dixonColes: { expectedGoals: { home: 2.6, away: 0.7 } },
    marketSnapshot: { jingcaiHandicap: { line: -2 } },
    handicapPick: { label: "让2主胜", line: -2, coverProbability: 0.55 },
    advancedFeatures: { riskTags: ["injury-key-out", "rotation-risk"] },
  },
  {
    name: "② 意甲·均势浅盘·平局多发",
    fixture: { competition: "意甲", homeTeam: "罗马", awayTeam: "拉齐奥" },
    marketImpliedProbabilities: { home: 0.38, draw: 0.31, away: 0.31 },
    probabilities: { home: 0.37, draw: 0.32, away: 0.31 },
    pick: { code: "3", label: "主胜", probability: 0.37 },
    confidence: "中", risk: "高",
    dixonColes: { expectedGoals: { home: 1.2, away: 1.1 } },
    marketSnapshot: { jingcaiHandicap: { line: -0.5 } },
    handicapPick: { label: "让0.5主胜", line: -0.5, coverProbability: 0.42 },
    advancedFeatures: { riskTags: ["derby"] },
    experienceContext: { drawAlert: "⚠️ 历史同情境平局率 33%(120场),平局风险偏高,可考虑兼顾平局" },
  },
  {
    name: "③ 国际友谊赛·信息稀缺·中性场",
    fixture: { competition: "国际友谊赛", homeTeam: "沙特", awayTeam: "约旦" },
    marketImpliedProbabilities: { home: 0.45, draw: 0.28, away: 0.27 },
    probabilities: { home: 0.44, draw: 0.29, away: 0.27 },
    pick: { code: "3", label: "主胜", probability: 0.44 },
    confidence: "低", risk: "高",
    dixonColes: { expectedGoals: { home: 1.4, away: 1.2 } },
    marketSnapshot: { jingcaiHandicap: { line: 0 } },
    advancedFeatures: { riskTags: ["missing-top-tier-team-intelligence"] },
  },
];

for (const c of cases) {
  const a = analyzeMatch(c);
  console.log("\n==================== " + c.name + " ====================");
  console.log(a.narrative);
}
