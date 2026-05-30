import { test } from "node:test";
import assert from "node:assert/strict";
import {
  favoriteFrame,
  extractAnalogRecord,
  analogDistance,
  analyzeHistoricalAnalogs,
  analogToLR
} from "../src/historical-analog-engine.js";

test("favoriteFrame:主队热门时以主为 fav,漂移用收盘-开盘", () => {
  const f = favoriteFrame({ home: 0.6, draw: 0.22, away: 0.18 }, { home: 0.65, draw: 0.2, away: 0.15 });
  assert.equal(f.favIsHome, true);
  assert.equal(f.favOpen, 0.6);
  assert.equal(f.dogOpen, 0.18);
  assert.ok(Math.abs(f.favDrift - 0.05) < 1e-9); // 热门被推高
  assert.ok(Math.abs(f.dogDrift - -0.03) < 1e-9);
});

test("favoriteFrame:客队热门时以客为 fav", () => {
  const f = favoriteFrame({ home: 0.25, draw: 0.25, away: 0.5 });
  assert.equal(f.favIsHome, false);
  assert.equal(f.favOpen, 0.5);
  assert.equal(f.dogOpen, 0.25);
  assert.equal(f.favDrift, 0); // 无收盘 → 漂移 0
});

test("favoriteFrame:坏赔率返回 null", () => {
  assert.equal(favoriteFrame(null), null);
  assert.equal(favoriteFrame({ home: NaN, away: 0.3 }), null);
});

test("extractAnalogRecord:主胜场在 fav 框架下 ft=fav,半场比分映射正确", () => {
  const rec = extractAnalogRecord({
    league: "E0", odds: { home: 0.6, draw: 0.22, away: 0.18 },
    oddsClose: { home: 0.62, draw: 0.21, away: 0.17 },
    homeGoals: 2, awayGoals: 0, halfHome: 1, halfAway: 0, home: "A", away: "B", date: "2024-01-01"
  });
  assert.equal(rec.ft, "fav");
  assert.equal(rec.favG, 2);
  assert.equal(rec.dogG, 0);
  assert.equal(rec.htRes, "fav");
});

test("extractAnalogRecord:客队热门且客胜 → ft=fav,favG 取客队进球", () => {
  const rec = extractAnalogRecord({
    league: "E0", odds: { home: 0.2, draw: 0.25, away: 0.55 },
    homeGoals: 0, awayGoals: 3, halfHome: 0, halfAway: 1
  });
  assert.equal(rec.ft, "fav");   // 热门(客)赢
  assert.equal(rec.favG, 3);
  assert.equal(rec.dogG, 0);
});

test("extractAnalogRecord:缺半场比分时 htRes=null 不崩", () => {
  const rec = extractAnalogRecord({
    league: "E0", odds: { home: 0.5, draw: 0.25, away: 0.25 },
    homeGoals: 1, awayGoals: 1, halfHome: null, halfAway: null
  });
  assert.equal(rec.htRes, null);
  assert.equal(rec.ft, "draw");
});

test("analogDistance:同特征距离为 0,漂移差异被加权放大", () => {
  const a = { favOpen: 0.6, dogOpen: 0.2, drawOpen: 0.2, favDrift: 0, dogDrift: 0 };
  assert.equal(analogDistance(a, a), 0);
  const b = { ...a, favDrift: 0.1 };
  const c = { ...a, drawOpen: 0.3 }; // 同样 0.1 偏差但在低权维度
  assert.ok(analogDistance(a, b) > analogDistance(a, c)); // drift 权重(2)> draw 权重(0.5)
});

function synthHistory() {
  // 构造同联赛历史:热门强(favOpen≈0.6)且热门被推高 → 多数热门赢、2-0
  const out = [];
  for (let i = 0; i < 80; i++) {
    const jitter = (i % 7) * 0.005;
    out.push({
      league: "E0",
      odds: { home: 0.6 + jitter, draw: 0.22, away: 0.18 - jitter },
      oddsClose: { home: 0.63 + jitter, draw: 0.21, away: 0.16 - jitter },
      homeGoals: i % 5 === 0 ? 1 : 2, awayGoals: i % 5 === 0 ? 1 : 0,
      halfHome: i % 5 === 0 ? 0 : 1, halfAway: 0, home: `H${i}`, away: `A${i}`, date: "2024-02-01"
    });
  }
  // 噪声:另一联赛 + 反向盘口,不应被选中
  for (let i = 0; i < 40; i++) {
    out.push({
      league: "SP1", odds: { home: 0.2, draw: 0.25, away: 0.55 },
      oddsClose: { home: 0.2, draw: 0.25, away: 0.55 },
      homeGoals: 0, awayGoals: 2, halfHome: 0, halfAway: 1
    });
  }
  return out;
}

test("analyzeHistoricalAnalogs:相近盘口的同联赛历史 → 主胜为锚,带半全场/比分", () => {
  const res = analyzeHistoricalAnalogs(
    { league: "E0", opening: { home: 0.6, draw: 0.22, away: 0.18 }, closing: { home: 0.63, draw: 0.21, away: 0.16 } },
    synthHistory(),
    { k: 40 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.wld, "home");
  assert.ok(res.probabilities.home > 0.6);
  assert.ok(res.analogCount <= 40);
  assert.ok(res.halfFull && res.halfFull.label.includes("/")); // 形如 主/主
  assert.ok(res.score && /^\d-\d$/.test(res.score.label));
  assert.ok(res.confidence > 0);
});

test("analyzeHistoricalAnalogs:跨联赛不污染 —— 只用同联赛样本", () => {
  const res = analyzeHistoricalAnalogs(
    { league: "E0", opening: { home: 0.6, draw: 0.22, away: 0.18 } },
    synthHistory(), { k: 100 }
  );
  // E0 只有 80 场,即使 k=100 也只能取到 80(SP1 被联赛过滤掉)
  assert.ok(res.analogCount <= 80);
});

test("analyzeHistoricalAnalogs:无同联赛历史 → ok:false", () => {
  const res = analyzeHistoricalAnalogs(
    { league: "ZZ", opening: { home: 0.5, draw: 0.25, away: 0.25 } }, synthHistory());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-same-league-history");
});

test("analogToLR:类比抬高主胜 → home LR>1,且夹在[0.5,2]", () => {
  const analog = { ok: true, effectiveN: 30, probabilities: { home: 0.7, draw: 0.18, away: 0.12 } };
  const lr = analogToLR(analog, { home: 0.5, draw: 0.27, away: 0.23 });
  assert.ok(lr.home > 1);
  assert.ok(lr.away < 1);
  for (const k of ["home", "draw", "away"]) {
    assert.ok(lr[k] >= 0.5 && lr[k] <= 2.0);
  }
});

test("analogToLR:有效样本不足 → 不发信号(null)", () => {
  const analog = { ok: true, effectiveN: 3, probabilities: { home: 0.7, draw: 0.18, away: 0.12 } };
  assert.equal(analogToLR(analog, { home: 0.5, draw: 0.3, away: 0.2 }), null);
});
