// 14场闸"停售日=最后购买日"口径(2026-06-11 用户裁决,世界杯26085期实案:停售6/11、首腿6/12)。
// 钉死三边界:①推荐日=停售日且腿全在未来→放行(带口径注记);②停售日已过→仍拒;③停售日在未来且当日无腿→仍拒(只放行停售日当天)。
import test from "node:test";
import assert from "node:assert/strict";
import { buildFourteenPlan } from "../src/prediction-engine.js";

function mkLeg(i, { kickoffDate = "2026-06-12", notes = "" } = {}) {
  return {
    fixture: {
      id: `sfc-test-${i}`, homeTeam: `主队${i}`, awayTeam: `客队${i}`,
      competition: "世界杯", date: kickoffDate, kickoff: `${kickoffDate}T03:00:00+08:00`,
      marketType: "shengfucai", tags: ["14场胜负彩"], notes
    },
    pick: { code: "3", probability: 0.55 },
    secondaryPick: { code: "0", probability: 0.25 },
    probabilities: { home: 0.55, draw: 0.20, away: 0.25 },
    confidence: 70, risk: "低", rationale: "测试桩",
    advancedFeatures: { quality: { score: 80 } },
    marketSnapshot: { europeanOdds: { current: { home: 2.1, draw: 3.3, away: 3.4 } } }
  };
}

function mkPeriod(stopSaleIso) {
  const notes = `第26085期 停售=${stopSaleIso}`;
  // 腿全在未来(6/12~6/16),无任何腿落在停售日当天
  return Array.from({ length: 14 }, (_, i) => mkLeg(i, { kickoffDate: i < 7 ? "2026-06-12" : "2026-06-16", notes }));
}

test("停售日当天+腿全在未来 → 放行(stopSaleDayRelease),note 带口径注记", () => {
  const plan = buildFourteenPlan(mkPeriod("2026-06-11T22:00:00+08:00"), "2026-06-11");
  assert.equal(plan.available, true);
  assert.equal(plan.stopSaleDayRelease, true);
  assert.match(plan.note ?? "", /停售日=最后购买日/);
});

test("停售日已过(昨天停售) → 仍拒,不因新口径漏放", () => {
  const plan = buildFourteenPlan(mkPeriod("2026-06-10T22:00:00+08:00"), "2026-06-11");
  assert.equal(plan.available, false);
  assert.match(plan.note ?? "", /已于 2026-06-10 停售/);
});

test("停售日在未来且当日无腿 → 仍拒(只放行停售日当天,不提前预售放行)", () => {
  const plan = buildFourteenPlan(mkPeriod("2026-06-13T22:00:00+08:00"), "2026-06-11");
  assert.equal(plan.available, false);
  assert.equal(plan.stopSaleDayRelease, false);
  assert.match(plan.note ?? "", /停售日 2026-06-13 当天将按/);
});

test("原有口径不回归:当日有腿开赛 → 照常放行(matchOnDate 通路)", () => {
  const legs = mkPeriod("2026-06-13T22:00:00+08:00");
  legs[0].fixture.date = "2026-06-11";
  legs[0].fixture.kickoff = "2026-06-11T20:00:00+08:00";
  const plan = buildFourteenPlan(legs, "2026-06-11");
  assert.equal(plan.available, true);
  assert.equal(plan.stopSaleDayRelease, false);
  assert.equal(plan.note, undefined);
});
