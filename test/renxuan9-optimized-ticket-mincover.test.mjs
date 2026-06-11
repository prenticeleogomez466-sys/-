// engine-core-spot-3(2026-06-11 审计):任选9 optimizedTicket 绕过 isLowSampleWorldCup/isWeakLeague
// "不当胆"护栏 —— picks 层世界杯腿全部双选,同一输出 optimizedTicket 却把世界杯腿标『胆』,
// 同一张 xlsx 两层互相矛盾(daily-report.js 消费 optimizedTicket)。
// 根因:optimizeTicket 按预算纯概率分配胆/双/全,不接收任何护栏约束。
// 修法:optimizeTicket 每腿支持 minCover 约束(护栏腿强制 ≥2 选),预算优化在约束内进行。
import test from "node:test";
import assert from "node:assert/strict";
import { optimizeTicket } from "../src/ticket-optimizer.js";
import { buildRenxuan9 } from "../src/prediction-engine.js";

const leg = (h, d, a, minCover) => ({ probs: [h, d, a], codes: ["3", "1", "0"], ...(minCover ? { minCover } : {}) });

// ── 单元:optimizeTicket 尊重 minCover ───────────────────────────────────────
test("minCover=2 的强腿绝不被留成单选(护栏优先于贪心边际收益)", () => {
  // 0.85 强腿贪心永远最后升级(边际收益最低);minCover=2 必须强制它至少双选
  const r = optimizeTicket([leg(0.85, 0.1, 0.05, 2), leg(0.38, 0.34, 0.28)], { budget: 4 });
  assert.ok(r.legs[0].cover >= 2, `护栏腿 cover 必须≥2,实得 ${r.legs[0].cover}`);
  assert.notEqual(r.legs[0].type, "胆", "护栏腿绝不得标『胆』");
});

test("约束初始成本即超预算时:护栏仍优先生效(安全约束>预算),成本如实上报", () => {
  // budget=1 只够全单选,但护栏腿 minCover=2 → 约束必须赢,cost 如实=2
  const r = optimizeTicket([leg(0.85, 0.1, 0.05, 2), leg(0.6, 0.25, 0.15)], { budget: 1 });
  assert.ok(r.legs[0].cover >= 2, "预算不足也不得把护栏腿降回胆");
  assert.equal(r.cost, 2, "成本须如实反映约束(不假报≤预算)");
  assert.equal(r.legs[1].cover, 1, "无约束腿在预算耗尽时保持单选");
});

test("无 minCover 时行为与旧版完全一致(回归保护)", () => {
  const legs = [leg(0.8, 0.13, 0.07), leg(0.45, 0.30, 0.25), leg(0.4, 0.32, 0.28)];
  const r = optimizeTicket(legs, { budget: 8 });
  assert.ok(r.cost <= 8);
  assert.equal(r.legs[0].cover, 1, "0.80 强腿无约束时仍留单选(贪心不变)");
  assert.ok(r.jointHitProb > r.baselineHitProb);
});

test("minCover 异常值安全:>3 截到 maxCover、非数/0/负按 1 处理", () => {
  const r = optimizeTicket([leg(0.5, 0.3, 0.2, 99), { probs: [0.6, 0.25, 0.15], codes: ["3", "1", "0"], minCover: "garbage" }], { budget: 9 });
  assert.ok(r.legs[0].cover <= 3, "minCover 超界截断到 3");
  assert.ok(r.legs[1].cover >= 1, "坏 minCover 按 1 兜底解析(解析护栏,非业务兜底)");
});

// ── 集成:buildRenxuan9 两层口径一致 ─────────────────────────────────────────
// 同 wc-banker-guard.test.mjs 的桩:胆相十足的世界杯场(高gap/高置信/市场热门),
// picks 层已挡胆 → optimizedTicket 必须同向(该腿 cover≥2),对照组未知联赛照常可当胆。
function mkPred(i, { competition, code = "3", gap = 0.30, p1 = 0.55, confidence = 70, favProb = 0.72 } = {}) {
  const p2 = p1 - gap;
  const pDraw = Math.round((1 - p1 - p2) * 100) / 100;
  const probs = code === "3"
    ? { home: p1, draw: pDraw, away: p2 }
    : { home: p2, draw: pDraw, away: p1 };
  return {
    fixture: {
      id: `wc-opt-${i}`, homeTeam: `主队${i}`, awayTeam: `客队${i}`,
      competition, date: "2026-06-12", kickoff: "2026-06-12T03:00:00+08:00",
      marketType: "shengfucai", tags: ["14场胜负彩"], notes: ""
    },
    pick: { code, probability: p1 },
    secondaryPick: { code: code === "3" ? "0" : "3", probability: p2 },
    probabilities: probs,
    confidence, risk: "低", rationale: "测试桩",
    selectionTier: { label: "T1", marketFavProb: favProb, backtestHit: 0.73, bankerEligible: true, noMarketOdds: false },
    advancedFeatures: { quality: { score: 80 } },
    marketSnapshot: { europeanOdds: { current: { home: 2.1, draw: 3.3, away: 3.4 } } }
  };
}
const mk9 = (comp) => {
  const preds = [mkPred(0, { competition: comp, gap: 0.45, p1: 0.66, confidence: 90, favProb: 0.85 })];
  for (let i = 1; i <= 8; i++) preds.push(mkPred(i, { competition: "测试联赛X", gap: 0.24, p1: 0.55, confidence: 55, favProb: 0.66 }));
  return preds;
};

test("任选9 optimizedTicket:世界杯腿(样本<20)绝不标『胆』,与 picks 层护栏同向", () => {
  const r9 = buildRenxuan9(mk9("世界杯"));
  assert.equal(r9.ok, true);
  const wcPick = r9.picks.find((p) => p.match === "主队0 对 客队0");
  assert.ok(wcPick && wcPick.type !== "胆", "前置:picks 层护栏生效(wc-banker-guard 已钉)");
  const optLeg = r9.optimizedTicket.legs.find((l) => l.match === "主队0 对 客队0");
  assert.ok(optLeg, "optimizedTicket 必含世界杯腿(绝不弃赛)");
  assert.notEqual(optLeg.type, "胆", "optimizedTicket 不得把世界杯低样本腿标『胆』(两层矛盾=本缺陷)");
  assert.ok(optLeg.cover.split("/").length >= 2, "护栏腿覆盖必须≥2选");
});

test("任选9 optimizedTicket 对照组:同参未知联赛腿照常可当胆(证明挡的是护栏而非全面禁胆)", () => {
  const ctrl = buildRenxuan9(mk9("测试联赛Y"));
  const ctrlLeg = ctrl.optimizedTicket.legs.find((l) => l.match === "主队0 对 客队0");
  assert.ok(ctrlLeg, "对照腿存在");
  assert.equal(ctrlLeg.type, "胆", "0.85 市场热门强腿无护栏时应被优化器留作胆(贪心逻辑未被破坏)");
});
