import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookMetrics, waterToDecimal, fairVsOffered, lineMovement, favSideOf, assessMatchOdds, payoutVerdict,
} from "../src/odds-value-lib.js";

test("bookMetrics: 返还率=1/Σ(1/o)·抽水=1-返还率(真实赔率)", () => {
  // 欧赔 1.26/4.65/8.25 → Σ1/o≈1.130 → 返还≈88.5%
  const m = bookMetrics([1.26, 4.65, 8.25]);
  assert.ok(m);
  assert.ok(Math.abs(m.payout - 0.885) < 0.005, `payout=${m.payout}`);
  assert.ok(Math.abs(m.vig - 0.115) < 0.005, `vig=${m.vig}`);
  assert.equal(m.n, 3);
});

test("bookMetrics: 亚盘抽水显著低于1X2(本库核心价值断言)", () => {
  const x1 = bookMetrics([1.96, 3.4, 3.08]);          // 竞彩让球1X2
  const ah = bookMetrics([1.88, 1.90]);                // 亚盘(水位+1)
  assert.ok(ah.vig < x1.vig, "亚盘抽水应低于1X2");
  assert.ok(x1.vig - ah.vig > 0.04, `差应>4pp,实=${(x1.vig - ah.vig)}`);
});

test("bookMetrics: 路数不足/坏赔率返回 null(不编造)", () => {
  assert.equal(bookMetrics([1.9]), null);
  assert.equal(bookMetrics([0.5, 0.8]), null);   // <=1 全过滤掉
  assert.equal(bookMetrics([]), null);
  assert.equal(bookMetrics(null), null);
});

test("waterToDecimal: 水位<1转decimal·>1原样·坏值null", () => {
  assert.equal(waterToDecimal(0.88), 1.88);
  assert.equal(waterToDecimal(1.92), 1.92);
  assert.equal(waterToDecimal(0), null);
  assert.equal(waterToDecimal("x"), null);
});

test("fairVsOffered: 开价系统性低于公平价(被抽水→gapPct<0)", () => {
  const r = fairVsOffered({ home: 1.26, draw: 4.65, away: 8.25 });
  assert.ok(r && r.length === 3);
  // de-vig 后概率和=1,公平价=1/p;含抽水的开价必然<公平价 → 平均 gapPct<0
  const avg = r.reduce((s, x) => s + x.gapPct, 0) / 3;
  assert.ok(avg < 0, `平均gapPct应<0,实=${avg}`);
  for (const x of r) { assert.ok(x.fair > 1, "公平价>1"); assert.ok(x.prob > 0 && x.prob < 1); }
});

test("fairVsOffered: 缺/坏赔率返回 null", () => {
  assert.equal(fairVsOffered(null), null);
  assert.equal(fairVsOffered({ home: 1.0, draw: 2, away: 3 }), null);
});

test("favSideOf: 热门=隐含概率更高侧", () => {
  assert.equal(favSideOf({ cur: { home: 1.26, draw: 4.65, away: 8.25 } }), "home");
  assert.equal(favSideOf({ cur: { home: 8.25, draw: 4.65, away: 1.26 } }), "away");
  assert.equal(favSideOf({ cur: null, init: { home: 1.5, draw: 4, away: 6 } }), "home");
  assert.equal(favSideOf(null), null);
});

test("lineMovement: 加注/退烧/平稳方向正确·实证文案", () => {
  // 热门(home)被加注:init 1.50→cur 1.30(隐含升)
  const up = lineMovement({ init: { home: 1.5, draw: 4, away: 6 }, cur: { home: 1.3, draw: 4.5, away: 8 } });
  assert.equal(up.favKey, "home");
  assert.equal(up.dir, "加注");
  assert.ok(up.driftPp > 2 && up.label.includes("56.4%"));
  // 退烧:init 1.30→cur 1.55
  const dn = lineMovement({ init: { home: 1.3, draw: 4.5, away: 8 }, cur: { home: 1.55, draw: 4, away: 5.5 } });
  assert.equal(dn.dir, "退烧");
  assert.ok(dn.driftPp < -2 && dn.label.includes("45.5%"));
  // 平稳
  const fl = lineMovement({ init: { home: 1.5, draw: 4, away: 6 }, cur: { home: 1.5, draw: 4, away: 6 } });
  assert.equal(fl.dir, "平稳");
  assert.equal(fl.hasMove, false);
});

test("lineMovement: 终盘优先作终点·缺数据null", () => {
  const m = lineMovement({ init: { home: 1.5, draw: 4, away: 6 }, cur: { home: 1.45, draw: 4, away: 6.2 }, fin: { home: 1.3, draw: 4.5, away: 8 } });
  assert.ok(m.stageNote.includes("终盘"));
  assert.ok(m.driftPp > 2, "应用初→终盘漂移");
  assert.equal(lineMovement(null), null);
  assert.equal(lineMovement({ cur: null, init: null }), null);
});

test("assessMatchOdds: 组装多市场·标出最划算/最贵·缺市场不进表", () => {
  const vo = {
    euro: { init: { home: 1.45, draw: 4.2, away: 7 }, cur: { home: 1.26, draw: 4.65, away: 8.25 }, fin: null },
    hcp: { cur: { home: 1.96, draw: 3.4, away: 3.08 } },
    ah: { cur: { line: -1.25, homeWater: 0.88, awayWater: 0.90 } },
    totals: { cur: { line: 2.75, over: 1.91, under: 1.81 } },
    jcLine: -1,
  };
  const a = assessMatchOdds(vo);
  assert.equal(a.markets.length, 4);
  assert.equal(a.cheapest.key, "ah", "亚盘抽水最低");
  assert.ok(["euro", "hcp"].includes(a.dearest.key), "1X2抽水最高");
  assert.ok(a.fair && a.fair.length === 3);
  assert.ok(a.movement && a.movement.dir === "加注");
  assert.equal(a.hasData, true);
});

test("assessMatchOdds: 全缺→hasData false·不报错", () => {
  const a = assessMatchOdds({ euro: {}, hcp: {}, ah: {}, totals: {} });
  assert.equal(a.hasData, false);
  assert.equal(a.markets.length, 0);
  assert.equal(a.cheapest, null);
  assert.equal(assessMatchOdds(null), null);
});

test("payoutVerdict: 分档标签", () => {
  assert.equal(payoutVerdict(0.96).tag, "🟢极低抽水");
  assert.equal(payoutVerdict(0.93).tag, "🟢低抽水");
  assert.equal(payoutVerdict(0.885).tag, "🟡中等抽水");
  assert.equal(payoutVerdict(0.74).tag, "🔴高抽水");
  assert.equal(payoutVerdict(null).tag, "—");
});
