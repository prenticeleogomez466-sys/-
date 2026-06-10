import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  mulberry32, poissonSample, nbSample, sampleScoreline, rankGroup,
  standardSeedOrder, seedBracket, simulateGroupStage, runMonteCarlo,
} from "../src/tournament-simulator.js";
import { venueLambdaMultiplier, matchVenueMult, groupVenueMults, eloExpectation, worldCupMatchOdds, marketWeOf, worldCupVenue, worldCupLambdaContext } from "../src/world-cup-priors.js";
import { getDataSubdir } from "../src/paths.js";

const BRACKET_PATH = join(getDataSubdir("world-cup"), "2026", "bracket.json");
const HAS_BRACKET = existsSync(BRACKET_PATH);
const BRACKET = HAS_BRACKET ? JSON.parse(readFileSync(BRACKET_PATH, "utf8")) : null;
const SCHEDULE_PATH = join(getDataSubdir("world-cup"), "2026", "match-dates.json");
// 真实赛程含逐场对阵(homeTeam/awayTeam)才能跑「每日 fixture 按对阵解析场馆」的回归。
const HAS_SCHEDULE = existsSync(SCHEDULE_PATH)
  && Object.values(JSON.parse(readFileSync(SCHEDULE_PATH, "utf8")).matchDate ?? {}).some((m) => m?.homeTeam && m?.venueCity);

test("mulberry32 同 seed 可复现、不同 seed 不同", () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.ok(sa.every((x) => x >= 0 && x < 1));
});

test("poissonSample 大样本均值≈lambda", () => {
  const rng = mulberry32(7);
  let sum = 0; const N = 20000;
  for (let i = 0; i < N; i++) sum += poissonSample(1.6, rng);
  assert.ok(Math.abs(sum / N - 1.6) < 0.05, `mean ${sum / N}`);
});

test("sampleScoreline 强队主胜期望更高", () => {
  const rng = mulberry32(1);
  const exp = sampleScoreline(2000, 1500, { lambdaTotal: 2.6 }, rng);
  assert.ok(exp.we > 0.7, `we=${exp.we}`);
});

test("rankGroup 真 tiebreaker:积分优先、净胜球次之", () => {
  const teams = ["A", "B", "C", "D"];
  // A 全胜, B/C/D 各 1 胜;构造 A 第一,B 净胜球高于 C
  const matches = [
    { home: "A", away: "B", ga: 2, gb: 0 },
    { home: "A", away: "C", ga: 2, gb: 0 },
    { home: "A", away: "D", ga: 2, gb: 0 },
    { home: "B", away: "C", ga: 3, gb: 0 },
    { home: "C", away: "D", ga: 1, gb: 0 },
    { home: "D", away: "B", ga: 1, gb: 0 },
  ];
  const eloOf = (t) => ({ A: 1900, B: 1800, C: 1700, D: 1600 })[t];
  const ranked = rankGroup(teams, matches, eloOf);
  assert.equal(ranked[0], "A"); // 9 分第一
  // B,C,D 各 3 分 → 净胜球:B(+3-3+ -1? 计算) 用断言:第一必 A,最后一名净胜球最低
  assert.equal(ranked.length, 4);
  assert.ok(ranked.includes("B") && ranked.includes("C") && ranked.includes("D"));
});

test("rankGroup 全平时用相互战绩,再用评级兜底(非随机/可复现)", () => {
  const teams = ["A", "B"];
  const matches = [{ home: "A", away: "B", ga: 1, gb: 1 }]; // 全平
  const eloOf = (t) => ({ A: 1500, B: 1700 })[t];
  const r1 = rankGroup(teams, matches, eloOf);
  const r2 = rankGroup(teams, matches, eloOf);
  assert.deepEqual(r1, r2); // 确定性
  assert.equal(r1[0], "B"); // 评级高者兜底在前
});

test("standardSeedOrder 8 队种子树:1号对8号、强队分两半区", () => {
  const order = standardSeedOrder(8); // 0-based 种子下标
  assert.equal(order.length, 8);
  // 第一场是种子1(idx0) vs 种子8(idx7)
  assert.equal(order[0], 0);
  assert.equal(order[1], 7);
  // 标准种子序 [1,8,4,5,2,7,3,6] → 种子2(0-based=1)位于后半区起点(idx4),与种子1分两半区
  assert.equal(order[4], 1);
  assert.ok(order.slice(0, 4).includes(0) && order.slice(4).includes(1));
});

test("simulateGroupStage 产 24 直接出线 + 8 最佳第三 = 32", () => {
  const groups = {};
  for (let g = 0; g < 12; g++) groups[String.fromCharCode(65 + g)] = [`${g}-1`, `${g}-2`, `${g}-3`, `${g}-4`];
  const eloOf = (t) => 1500 + (t.endsWith("-1") ? 300 : t.endsWith("-2") ? 150 : t.endsWith("-3") ? 50 : 0);
  const rng = mulberry32(99);
  const gs = simulateGroupStage(groups, eloOf, rng, {});
  assert.equal(gs.winners.length, 12);
  assert.equal(gs.runners.length, 12);
  assert.equal(gs.bestThirds.length, 8);
  assert.equal(gs.advancers.length, 32);
});

test("bracket.json:第三名分配表 495 行、骨架完整", { skip: !HAS_BRACKET }, () => {
  assert.equal(Object.keys(BRACKET.thirdPlaceTable).length, 495);
  assert.equal(BRACKET.r32.length, 16);
  assert.equal(BRACKET.r16.length, 8);
  assert.equal(BRACKET.qf.length, 4);
  assert.equal(BRACKET.sf.length, 2);
  assert.ok(BRACKET.final && BRACKET.final.m === 104);
});

test("官方表:任一第三名位次都不接收本组三名(无同组 R32 重赛)", { skip: !HAS_BRACKET }, () => {
  const seen = {};
  for (const assign of Object.values(BRACKET.thirdPlaceTable)) {
    for (const [slot, g] of Object.entries(assign)) (seen[slot] ??= new Set()).add(g);
  }
  // 8 个接收位次,每个聚合来源组都不含自身组
  assert.equal(Object.keys(seen).length, 8);
  for (const [slot, set] of Object.entries(seen)) {
    assert.ok(!set.has(slot[1]), `${slot} 收到本组三名 ${slot[1]}`);
  }
});

test("runMonteCarlo 官方对阵表:审计通过、可复现、强队夺冠最高", { skip: !HAS_BRACKET }, () => {
  const groups = {};
  for (let g = 0; g < 12; g++) groups[String.fromCharCode(65 + g)] = [`${g}-1`, `${g}-2`, `${g}-3`, `${g}-4`];
  const eloOf = (t) => (t === "0-1" ? 2100 : 1500 + (t.endsWith("-1") ? 250 : t.endsWith("-2") ? 120 : t.endsWith("-3") ? 40 : 0));
  const cfg = { groups, eloOf, hosts: new Set(), lambdaTotal: 2.6, bracket: BRACKET };
  const res = runMonteCarlo(cfg, 3000, 777);
  assert.ok(res.audit.ok, `audit ${JSON.stringify(res.audit)}`);
  assert.equal(res.teams[0].team, "0-1");
  const res2 = runMonteCarlo(cfg, 3000, 777);
  assert.equal(res.teams[0].champion, res2.teams[0].champion); // 同 seed 复现
});

test("runMonteCarlo:概率单调、夺冠和≈1、出线和≈32,强队夺冠概率最高", () => {
  const groups = {};
  for (let g = 0; g < 12; g++) groups[String.fromCharCode(65 + g)] = [`${g}-1`, `${g}-2`, `${g}-3`, `${g}-4`];
  // A-1 全场最强
  const eloOf = (t) => {
    if (t === "0-1") return 2100;
    return 1500 + (t.endsWith("-1") ? 250 : t.endsWith("-2") ? 120 : t.endsWith("-3") ? 40 : 0);
  };
  const res = runMonteCarlo({ groups, eloOf, hosts: new Set(), lambdaTotal: 2.6 }, 3000, 12345);
  assert.ok(res.audit.ok, `audit ${JSON.stringify(res.audit)}`);
  assert.ok(res.audit.monotonic);
  // 最强队夺冠概率应排第一且 > 任何其他
  assert.equal(res.teams[0].team, "0-1");
  assert.ok(res.teams[0].champion > res.teams[1].champion);
  // 同 seed 可复现
  const res2 = runMonteCarlo({ groups, eloOf, hosts: new Set(), lambdaTotal: 2.6 }, 3000, 12345);
  assert.equal(res.teams[0].champion, res2.teams[0].champion);
});

// ───────────────────────── 第6轮大融合强化测试(NB过离散 + venue,2026-06-04)─────────────────────────

test("nbSample 大样本均值≈mu 且过离散(方差>泊松)", () => {
  const rng = mulberry32(2026);
  const N = 40000, mu = 1.3, size = 8;
  const xs = []; for (let i = 0; i < N; i++) xs.push(nbSample(mu, size, rng));
  const mean = xs.reduce((s, x) => s + x, 0) / N;
  const varr = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / N;
  assert.ok(Math.abs(mean - mu) < 0.05, `mean ${mean} vs ${mu}`);
  // 负二项理论方差 = mu + mu²/size > 泊松方差(=mu)
  const theo = mu + mu * mu / size;
  assert.ok(varr > mu, `过离散:方差 ${varr.toFixed(3)} 应 > 泊松 ${mu}`);
  assert.ok(Math.abs(varr - theo) < 0.1, `方差 ${varr.toFixed(3)} ≈ 理论 ${theo.toFixed(3)}`);
});

test("nbSample size 非正/∞ 退化为纯泊松(俱乐部路径零改动)", () => {
  const r1 = mulberry32(5), r2 = mulberry32(5);
  // nbSize=undefined → 与 poissonSample 同一抽样序列
  const a = []; for (let i = 0; i < 50; i++) a.push(nbSample(1.4, undefined, r1));
  const b = []; for (let i = 0; i < 50; i++) b.push(poissonSample(1.4, r2));
  assert.deepEqual(a, b);
});

test("sampleScoreline 缺 nbSize 退泊松、带 nbSize=8 仍均值守恒可复现", () => {
  // 缺省路径与显式泊松一致
  const r1 = mulberry32(11), r2 = mulberry32(11);
  const s1 = sampleScoreline(1800, 1800, { lambdaTotal: 2.54 }, r1);
  const s2 = sampleScoreline(1800, 1800, { lambdaTotal: 2.54 }, r2);
  assert.deepEqual(s1, s2); // 可复现
  // NB(8) 路径:大样本总进球均值仍≈lamTot(过离散不改均值)
  const rng = mulberry32(3); let tot = 0; const N = 20000;
  for (let i = 0; i < N; i++) { const s = sampleScoreline(1800, 1800, { lambdaTotal: 2.54, nbSize: 8 }, rng); tot += s.a + s.b; }
  assert.ok(Math.abs(tot / N - 2.54) < 0.06, `NB 总进球均值 ${(tot / N).toFixed(3)} ≈ 2.54`);
});

test("venueMult 抬/压总进球:>1 升、<1 降(对称作用两队)", () => {
  const run = (vm) => { const rng = mulberry32(8); let t = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const s = sampleScoreline(1800, 1800, { lambdaTotal: 2.5, venueMult: vm }, rng); t += s.a + s.b; } return t / N; };
  const base = run(1), hi = run(1.06), lo = run(0.95);
  assert.ok(hi > base && base > lo, `墨城1.06=${hi.toFixed(2)} > 中性=${base.toFixed(2)} > 蒙特雷0.95=${lo.toFixed(2)}`);
  assert.ok(Math.abs(hi / base - 1.06) < 0.03, "高原乘子量级正确");
});

test("venueLambdaMultiplier 边界:极端高原↑、露天高温↓、顶棚中性、中高海拔中性", () => {
  assert.equal(venueLambdaMultiplier({ altitude_m: 2240, june_july_avg_high_c: 24 }).mult, 1.06); // 墨西哥城
  assert.equal(venueLambdaMultiplier({ altitude_m: 540, june_july_avg_high_c: 35 }).mult, 0.95);  // 蒙特雷露天高温
  assert.equal(venueLambdaMultiplier({ altitude_m: 180, june_july_avg_high_c: 35, indoor_climate_controlled: true }).mult, 1); // 达拉斯顶棚
  assert.equal(venueLambdaMultiplier({ altitude_m: 1560, june_july_avg_high_c: 28 }).mult, 1); // 瓜达拉哈拉中高海拔实测中性
  assert.equal(venueLambdaMultiplier(null).mult, 1); // 无 venue 中性
});

test("matchVenueMult 真实赛号映射:墨城海拔恒↑、低海拔城落在合法高温档位", { skip: !HAS_BRACKET }, () => {
  // 2026-06-10 修:开赛进 Open-Meteo 16 天预报窗后,高温乘子用真实预报(1/0.97/0.95 随天气浮动),
  //   写死气候均温档位会随天气假红。守护不变量=赛号→城市映射 + 海拔加成方向 + 乘子有界。
  const HEAT = [1, 0.97, 0.95]; // venueLambdaMultiplier 高温乘子的全部合法档位
  for (const n of [1, 79]) { // 墨西哥城 2240m:必带 ×1.06 海拔加成 → 恒 >1
    const m = matchVenueMult(n);
    assert.ok(m > 1, `墨城场${n} 应>1,实得 ${m}`);
    assert.ok(HEAT.some((h) => Math.abs(m - Number((1.06 * h).toFixed(4))) < 1e-9), `墨城场${n}=${m} 应为 1.06×{1,0.97,0.95}`);
  }
  for (const [n, city] of [[6, "蒙特雷"], [104, "决赛East Rutherford"]]) { // 低海拔:无海拔加成 → ∈{1,0.97,0.95}
    const m = matchVenueMult(n);
    assert.ok(HEAT.includes(m), `${city}场${n}=${m} 应∈{1,0.97,0.95}`);
  }
});

test("groupVenueMults A 组对齐真实赛程(赛号1-6逐场一致,墨城两场海拔加成)", { skip: !HAS_BRACKET }, () => {
  const g = groupVenueMults();
  const a = g["A"] ?? Object.values(g)[0];
  assert.equal(a.length, 6);
  assert.deepEqual(a, [1, 2, 3, 4, 5, 6].map((n) => matchVenueMult(n))); // 组数组与赛号1-6逐场对齐
  assert.ok(a[0] > 1 && a[4] > 1, `赛号1、5 墨西哥城海拔加成应>1,实得 ${a[0]}/${a[4]}`); // 墨城两场
  assert.ok(a[5] <= 1, `赛号6 蒙特雷无海拔加成应≤1,实得 ${a[5]}`);
});

// ── 每日竞彩 fixture(只带中文队名+日期、无场馆字段)按真实对阵解析场馆 → 海拔/天气 λ 真生效 ──
//    2026-06-07 体检修:此前 worldCupVenue 只认显式场馆字段、每日 fixture 恒 venue=null、乘子恒 1,
//    世界杯海拔/天气吸收在用户每天看的推荐路径上静默失效。守护此桥不再回退。
test("worldCupVenue 按中文对阵解析:墨西哥vs南非→阿兹特克(2240m)", { skip: !HAS_SCHEDULE }, () => {
  const v = worldCupVenue({ homeTeam: "墨西哥", awayTeam: "南非", competition: "世界杯" });
  assert.ok(v, "应解析到场馆,不得为 null");
  assert.equal(v.altitude_m, 2240);
  assert.match(v.stadium, /Azteca/);
});

test("worldCupLambdaContext 高海拔在每日路径生效:墨城揭幕战 lambdaMult=1.06", { skip: !HAS_SCHEDULE }, () => {
  const c = worldCupLambdaContext({ homeTeam: "墨西哥", awayTeam: "南非", competition: "世界杯", date: "2026-06-11" }, "2026-06-11");
  assert.equal(c.isWC, true);
  assert.equal(c.lambdaMult, 1.06);
});

test("worldCupLambdaContext 按 kickoff 判定:14场胜负彩销售日在窗口外、比赛日在窗内→isWC=true", { skip: !HAS_SCHEDULE }, () => {
  // 14场胜负彩 fixture.date=销售业务日(6/07,窗口外),kickoff=真实比赛日(6/12,窗内)。
  // 用销售日会漏判世界杯→海拔/天气整批漏(2026-06-07 体检发现)。须按 kickoff 判定。
  const fx = { homeTeam: "墨西哥", awayTeam: "南非", competition: "世界杯", date: "2026-06-07", kickoff: "2026-06-12" };
  const c = worldCupLambdaContext(fx); // 不传显式 date → 内部应优先 kickoff
  assert.equal(c.isWC, true);
  assert.equal(c.lambdaMult, 1.06);
});

test("worldCupVenue 队名变体别名:USA/伊朗/科特迪瓦 中文 fixture 也能解析", { skip: !HAS_SCHEDULE }, () => {
  // 这三队 feed 用 USA / IR Iran / Côte d'Ivoire,与 groups.json 英文名不同 → 须经别名/去音调符归一
  for (const [h, a] of [["美国", "巴拉圭"], ["伊朗", "新西兰"], ["科特迪瓦", "厄瓜多尔"]]) {
    const v = worldCupVenue({ homeTeam: h, awayTeam: a, competition: "世界杯" });
    assert.ok(v, `${h} vs ${a} 应解析到承办城市,不得为 null`);
  }
});

test("eloExpectation 概率和恒为1、强队主胜更高", () => {
  for (const [h, a] of [[1800, 1800], [1900, 1700], [2100, 1500]]) {
    const e = eloExpectation(h, a, 0);
    assert.ok(Math.abs(e.home + e.draw + e.away - 1) < 1e-9, `和=${e.home + e.draw + e.away}`);
  }
  assert.ok(eloExpectation(1900, 1700, 0).home > eloExpectation(1800, 1800, 0).home);
});

// ───────────────────────── 开赛后 match 级市场融合(大融合③,2026-06-04)─────────────────────────

test("sampleScoreline market 融合:marketWe 高→主胜占比明显升", () => {
  const winShare = (ctx) => { const rng = mulberry32(1); let h = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const s = sampleScoreline(1700, 1800, ctx, rng); if (s.a > s.b) h++; } return h / N; };
  const eloOnly = winShare({ lambdaTotal: 2.5 });               // 纯 Elo(弱队)
  const withMkt = winShare({ lambdaTotal: 2.5, marketWe: 0.85 }); // 市场却看好该队
  assert.ok(withMkt > eloOnly + 0.1, `market 融合应抬主胜 ${eloOnly.toFixed(2)}→${withMkt.toFixed(2)}`);
});

test("sampleScoreline 缺省 marketWe = 纯 Elo(开赛前/未知对阵零改动、可复现)", () => {
  const r1 = mulberry32(2), r2 = mulberry32(2);
  const a = sampleScoreline(1800, 1700, { lambdaTotal: 2.5, nbSize: 8 }, r1);
  const b = sampleScoreline(1800, 1700, { lambdaTotal: 2.5, nbSize: 8, marketWe: undefined }, r2);
  assert.deepEqual(a, b);
});

test("worldCupMatchOdds / marketWeOf 无逐场赔率→null(match-odds.json fixtures 空,纯 Elo)", () => {
  // 开赛前 match-odds.json fixtures=[] → 任何对阵都无市场胜率,引擎回退纯 Elo
  assert.equal(worldCupMatchOdds("Spain", "Mexico"), null);
  assert.equal(marketWeOf("Spain", "Mexico"), null);
});

test("marketAlpha 控制市场权重:α=1 完全跟市场胜率", () => {
  // marketWe=0.9, α=1 → we 应≈0.9 → 主胜占比应远高于 Elo 均势
  const rng = mulberry32(3); let h = 0; const N = 20000;
  for (let i = 0; i < N; i++) { const s = sampleScoreline(1800, 1800, { lambdaTotal: 2.5, marketWe: 0.9, marketAlpha: 1 }, rng); if (s.a > s.b) h++; }
  assert.ok(h / N > 0.6, `α=1 跟市场 we=0.9 主胜占比应高,实际 ${(h / N).toFixed(2)}`);
});
