import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tripleRatio,
  orientRowPairs,
  orientRowMaps,
  swapGuardViolation,
  ORIENT_A_IS_1X2,
  ORIENT_B_IS_1X2,
  ORIENT_UNCERTAIN,
} from "../src/spf-orientation.js";
import { orientIngestFeeds, auditSnapshots, AUDIT_KINDS } from "../scripts/ingest-500-jingcai-fallback.mjs";

// 缺陷#3#13#4(2026-06-10):500 的 pl_spf/pl_nspf 两 XML 内容会互换(文件名不可信),
//   06-09 按文件名硬解析把匈牙利 1X2 1.17 大热推反(真钱事故)。
//   本测试钉死:①离散度投票定向纠正互换 ②不确定返回 uncertain 绝不硬猜
//   ③逐场互换残留守护(旧实现读不存在的 .latest = 死代码) ④审计闸真值化不打假✅。

// 真实形状固件:1X2(悬殊/大热离散)vs 让球(收敛)。匈牙利案例数字。
const EURO_ROWS = [
  { win: "1.17", draw: "5.35", lost: "11.5" },  // 匈牙利大热,ratio≈9.83
  { win: "1.30", draw: "4.80", lost: "9.00" },  // ratio≈6.92
  { win: "2.10", draw: "3.30", lost: "3.40" },  // ratio≈1.62(均势场)
];
const HC_ROWS = [
  { win: "3.11", draw: "3.36", lost: "1.96" },  // 让-2,ratio≈1.71
  { win: "2.80", draw: "3.20", lost: "2.30" },  // ratio≈1.39
  { win: "3.05", draw: "3.40", lost: "2.05" },  // ratio≈1.66
];
const mapOf = (rows) => new Map(rows.map((r, i) => [`600${i + 1}`, r]));

test("tripleRatio:win/draw/lost 与 home/draw/away 两种行形状都识别;无效行返回 null", () => {
  assert.ok(Math.abs(tripleRatio({ win: "1.17", draw: "5.35", lost: "11.5" }) - 11.5 / 1.17) < 1e-9);
  assert.ok(Math.abs(tripleRatio({ home: 2, draw: 4, away: 8 }) - 4) < 1e-9);
  assert.equal(tripleRatio(null), null);
  assert.equal(tripleRatio({ win: "1.5", draw: "" }), null);
  assert.equal(tripleRatio({ win: "0", draw: "3", lost: "4" }), null);
});

test("定向:正常命名(A=1X2)→ A_IS_1X2;互换注入(A=让球)→ B_IS_1X2 纠正", () => {
  const normal = orientRowMaps(mapOf(EURO_ROWS), mapOf(HC_ROWS));
  assert.equal(normal.orientation, ORIENT_A_IS_1X2);
  assert.ok(normal.voteA >= 2 && normal.voteB === 0);
  // 人工互换注入:两份内容对调 → 投票必须翻向 B,绝不再按文件名输出
  const swapped = orientRowMaps(mapOf(HC_ROWS), mapOf(EURO_ROWS));
  assert.equal(swapped.orientation, ORIENT_B_IS_1X2);
  assert.ok(swapped.voteB >= 2 && swapped.voteA === 0);
});

test("定向:平票/零样本返回 uncertain(绝不硬猜兜底)", () => {
  // 零样本(空 feed / 无交集)
  assert.equal(orientRowMaps(new Map(), new Map()).orientation, ORIENT_UNCERTAIN);
  assert.equal(orientRowMaps(mapOf(EURO_ROWS), new Map()).orientation, ORIENT_UNCERTAIN);
  // 两 feed 全均势 → 无离散度差 → 0:0 平票
  const flat = [{ win: "2.5", draw: "3.1", lost: "2.8" }];
  assert.equal(orientRowMaps(mapOf(flat), mapOf(flat)).orientation, ORIENT_UNCERTAIN);
  // 一票对一票平票
  const tie = orientRowPairs([
    { a: EURO_ROWS[0], b: HC_ROWS[0] },
    { b: EURO_ROWS[1], a: HC_ROWS[1] },
  ]);
  assert.equal(tie.orientation, ORIENT_UNCERTAIN);
  assert.equal(tie.voteA, 1);
  assert.equal(tie.voteB, 1);
});

test("swapGuardViolation:互换残留命中(让球离散度远高于胜平负);正确方向/悬殊场 euro=null 不误伤", () => {
  const euroOk = { current: { home: 1.17, draw: 5.35, away: 11.5 } };
  const hcOk = { current: { home: 3.11, draw: 3.36, away: 1.96 } };
  // 正确方向 → 不告警
  assert.equal(swapGuardViolation(euroOk, hcOk), null);
  // 互换残留(euro 槽里是让球、handicap 槽里是 1X2)→ 必须命中
  const v = swapGuardViolation(hcOk, euroOk);
  assert.ok(v && /互换残留/.test(v), `应命中互换残留,实得 ${v}`);
  // 悬殊场 1X2 未开售(euro=null):无从逐场比对,由 feed 级投票覆盖,不误伤
  assert.equal(swapGuardViolation(null, hcOk), null);
  assert.equal(swapGuardViolation(euroOk, null), null);
  // 旧实现死代码回归锁:oddsSet 形状只有 initial/current,守护必须读 .current 而非 .latest
  assert.equal(swapGuardViolation({ latest: euroOk.current }, { latest: hcOk.current }), null);
});

// ===== ingest 主链:orientIngestFeeds(缺陷#3 每日无人值守链)=====
const asFeed = (rows) => rows.map((r, i) => ({ matchnum: `600${i + 1}`, latest: r, home: `主${i}`, away: `客${i}` }));

test("orientIngestFeeds:常态日(pl_spf=让球/pl_nspf=1X2)→ euro 取 pl_nspf", () => {
  const o = orientIngestFeeds(asFeed(HC_ROWS), asFeed(EURO_ROWS));
  assert.equal(o.orientation, ORIENT_B_IS_1X2);
  assert.equal(o.euroFile, "pl_nspf");
  assert.equal(o.hcFile, "pl_spf");
  assert.equal(o.euroList[0].latest.win, "1.17", "euroList 必须指向真 1X2 内容");
});

test("orientIngestFeeds:互换日(pl_spf=1X2)→ 自动纠正 euro 取 pl_spf(06-09 事故场景)", () => {
  const o = orientIngestFeeds(asFeed(EURO_ROWS), asFeed(HC_ROWS));
  assert.equal(o.orientation, ORIENT_A_IS_1X2);
  assert.equal(o.euroFile, "pl_spf");
  assert.equal(o.euroList[0].latest.win, "1.17", "互换日 euroList 仍须指向真 1X2 内容(匈牙利 1.17 主胜不被推反)");
});

test("orientIngestFeeds:不确定 → euroList/hcList=null(调用方必须阻断落盘)", () => {
  const o = orientIngestFeeds([], []);
  assert.equal(o.orientation, ORIENT_UNCERTAIN);
  assert.equal(o.euroList, null);
  assert.equal(o.hcList, null);
});

// ===== 审计闸真值化(缺陷#4):构造缺失样本断言不打假✅ =====
function snap(over = {}) {
  return {
    homeTeam: "主", awayTeam: "客",
    europeanOdds: { current: { home: 2, draw: 3, away: 4 } },
    handicapOdds: { current: { home: 3, draw: 3.3, away: 2 } },
    scoreOdds: { top: [{ score: "1-0", odds: 5 }] },
    halfFullOdds: { top: [{ halfFull: "主胜-主胜", odds: 3 }] },
    totalGoalsOdds: { over25: 0.55, under25: 0.45 },
    totals: { current: { line: 2.5, over: 1.9, under: 1.9 } },
    ...over,
  };
}

test("auditSnapshots:06-10 实测场景——胜平负 8/10 · 大小球 0/10 绝不打✅,且明确列出缺哪种缺几场", () => {
  const snapshots = [];
  for (let i = 0; i < 10; i++) {
    snapshots.push(snap({
      europeanOdds: i < 8 ? snap().europeanOdds : null, // 2 场悬殊场 1X2 未开售
      totals: null,                                      // odds.xml 大小球全挂
    }));
  }
  const a = auditSnapshots(snapshots);
  assert.equal(a.fullCoverage, false, "胜平负 8/10 + 大小球 0/10 禁打全覆盖✅");
  assert.equal(a.counts.胜平负, 8);
  assert.equal(a.counts.大小球, 0);
  assert.equal(a.counts.总进球, 10);
  assert.ok(a.missingKinds.includes("胜平负 缺2/10"), `应列出胜平负缺口,实得 ${a.missingKinds}`);
  assert.ok(a.missingKinds.includes("大小球 缺10/10"), `应列出大小球缺口,实得 ${a.missingKinds}`);
});

test("auditSnapshots:jqs(总进球)有值绝不替身遮蔽 totals(大小球)全 NULL", () => {
  const a = auditSnapshots([snap({ totals: null })]); // jqs over25 有值,totals 缺
  assert.equal(a.fullCoverage, false, "jqs 替身遮蔽 = 假✅,必须分项独立计数");
  assert.ok(a.missingKinds.some((k) => k.startsWith("大小球")));
  assert.ok(a.gaps[0].includes("大小球"), "逐场缺口须点名大小球");
  assert.ok(!a.gaps[0].includes("总进球"), "总进球有值不应入缺口");
});

test("auditSnapshots:六项全有才允许✅;空集不算全覆盖", () => {
  const full = auditSnapshots([snap(), snap()]);
  assert.equal(full.fullCoverage, true);
  assert.equal(full.missingKinds.length, 0);
  assert.equal(full.gaps.length, 0);
  assert.deepEqual(Object.keys(full.counts), AUDIT_KINDS);
  assert.equal(auditSnapshots([]).fullCoverage, false, "0 场不允许打✅");
});

test("auditSnapshots:让球/比分/半全场缺失同样进缺口(旧实现胜平负/让球不进 gaps)", () => {
  const a = auditSnapshots([snap({ handicapOdds: null, scoreOdds: null, halfFullOdds: { top: [] } })]);
  assert.equal(a.fullCoverage, false);
  assert.ok(a.missingKinds.includes("让球 缺1/1"));
  assert.ok(a.missingKinds.includes("比分 缺1/1"));
  assert.ok(a.missingKinds.includes("半全场 缺1/1"));
  assert.ok(a.gaps[0].includes("让球") && a.gaps[0].includes("比分") && a.gaps[0].includes("半全场"));
});
