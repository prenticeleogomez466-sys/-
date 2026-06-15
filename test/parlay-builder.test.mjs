// 串关构建守护(2026-06-12):de-vig 归一、缺赔种不出腿(绝不兜底)、同场单玩法规则、分档去重、EV 诚实。
import test from "node:test";
import assert from "node:assert/strict";
import { buildParlayLegs, buildParlayPlan } from "../src/parlay-builder.js";

const mkPred = (over = {}) => ({
  fixture: { homeTeam: "甲队", awayTeam: "乙队", sequence: "5001" },
  probabilities: { home: 0.55, draw: 0.25, away: 0.20 },
  handicapPick: { line: -1, handicapWld: { probabilities: { home: 0.30, draw: 0.32, away: 0.38 } } },
  marketSnapshot: {
    europeanOdds: { current: { home: 1.62, draw: 3.32, away: 4.75 } },
    jingcaiHandicap: { line: -1 },
    handicapOdds: { current: { home: 3.11, draw: 3.2, away: 2.02 } },
    scoreOdds: { top: [{ score: "1-1", odds: 5 }, { score: "1-0", odds: 5.4 }, { score: "2-1", odds: 5.65 }, { score: "2-0", odds: 6.5 }, { score: "0-0", odds: 9.5 }, { score: "0-1", odds: 11.5 }, { score: "3-0", odds: 14 }, { score: "3-1", odds: 14 }] },
    halfFullOdds: { top: [{ halfFull: "主胜-主胜", odds: 2.51 }, { halfFull: "平局-主胜", odds: 4.25 }, { halfFull: "平局-平局", odds: 4.8 }, { halfFull: "客胜-客胜", odds: 8.4 }, { halfFull: "平局-客胜", odds: 10 }, { halfFull: "主胜-平局", odds: 16 }, { halfFull: "客胜-平局", odds: 16 }, { halfFull: "客胜-主胜", odds: 25 }, { halfFull: "主胜-客胜", odds: 36 }] },
  },
  ...over,
});
const JQS = { 0: 9.5, 1: 4.3, 2: 3.0, 3: 3.6, 4: 6.2, 5: 13, 6: 24, 7: 40 };

test("buildParlayLegs:五玩法全有赔率 → 各玩法 de-vig 归一,腿带✅赔率+🔶概率", () => {
  const g = buildParlayLegs(mkPred(), JQS);
  for (const mkt of ["胜负平", "让球(-1)", "比分", "半全场", "总进球"]) {
    assert.ok(g.legs.some((l) => l.market === mkt), `缺玩法 ${mkt}`);
  }
  // 胜负平 de-vig 归一(3腿和=1)
  const wld = g.legs.filter((l) => l.market === "胜负平");
  assert.ok(Math.abs(wld.reduce((t, l) => t + l.probMkt, 0) - 1) < 0.01);
  // 模型概率只在胜负平/让球有(其余诚实 null,不编)
  assert.ok(wld.every((l) => l.probModel != null));
  assert.ok(g.legs.filter((l) => l.market === "比分").every((l) => l.probModel === null));
  // 比分候选只留6档,概率基于全集 de-vig(首档 1-1@5 → 1/5/Σ)
  assert.equal(g.legs.filter((l) => l.market === "比分").length, 6);
});

test("buildParlayLegs:缺赔种=该玩法不出腿,绝不兜底;jqs 原始赔率缺=总进球不出腿", () => {
  const p = mkPred({ marketSnapshot: { europeanOdds: { current: { home: 1.62, draw: 3.32, away: 4.75 } } } });
  const g = buildParlayLegs(p, null);
  assert.ok(g.legs.every((l) => l.market === "胜负平"), "只允许有真实赔率的胜负平出腿");
});

test("buildParlayPlan:两场→2串1;每注恰一腿/场(同场单玩法);赔率/概率=乘积;跨档去重", () => {
  const a = buildParlayLegs(mkPred(), JQS);
  const b = buildParlayLegs(mkPred({ fixture: { homeTeam: "丙队", awayTeam: "丁队", sequence: "5002" } }), JQS);
  const plan = buildParlayPlan([a, b]);
  assert.ok(plan.ok);
  const seen = new Set();
  for (const t of plan.tiers) for (const c of t.combos) {
    assert.equal(c.legs.length, 2);
    assert.equal(new Set(c.legs.map((l) => l.seq)).size, 2, "同场不得双腿");
    assert.ok(Math.abs(c.odds - c.legs[0].odds * c.legs[1].odds) < 0.02);
    assert.ok(Math.abs(c.probMkt - c.legs[0].probMkt * c.legs[1].probMkt) < 0.002);
    const k = c.legs.map((l) => `${l.seq}|${l.market}|${l.sel}`).join("&");
    assert.ok(!seen.has(k), "跨档重复组合"); seen.add(k);
  }
  // 最稳档存在且为全空间最高联合概率
  const top = plan.tiers.find((t) => t.tier === "🛡️最稳").combos[0];
  assert.ok(top.probMkt >= plan.tiers.flatMap((t) => t.combos).reduce((m, c) => Math.max(m, c.probMkt), 0) - 1e-9);
  // 爆冷档每腿 de-vig ≤30%
  const cold = plan.tiers.find((t) => t.tier === "💣爆冷");
  if (cold) for (const c of cold.combos) assert.ok(c.legs.every((l) => l.probMkt <= 0.30));
  // EV 诚实:市场口径 EV = probMkt*odds-1 ≈ -(叠乘抽水) 恒负
  for (const t of plan.tiers) for (const c of t.combos) assert.ok(c.evMkt < 0, "de-vig 概率×赔率必小于1(抽水),EV 不可能为正");
});

test("buildParlayPlan:默认每档最多4注;极限高赔档存在且全部≥40倍", () => {
  const a = buildParlayLegs(mkPred(), JQS);
  const b = buildParlayLegs(mkPred({ fixture: { homeTeam: "丙队", awayTeam: "丁队", sequence: "5002" } }), JQS);
  const plan = buildParlayPlan([a, b]);
  for (const t of plan.tiers) assert.ok(t.combos.length <= 4, `${t.tier} 超过4注`);
  const vol = plan.tiers.find((t) => t.tier === "🌋极限高赔");
  assert.ok(vol, "比分6×比分6最高132倍,极限高赔档(≥40)必须存在");
  for (const c of vol.combos) assert.ok(c.odds >= 40);
});

test("buildParlaySheet:'怎么买'合列(每腿带场+玩法+选项+赔率)+100元口径(可中=串赔×100/期望回收恒<100)+腿数动态", async () => {
  const { buildParlaySheet } = await import("../src/today-delivery-lib.js");
  const a = buildParlayLegs(mkPred(), JQS);
  const b = buildParlayLegs(mkPred({ fixture: { homeTeam: "丙队", awayTeam: "丁队", sequence: "5002" } }), JQS);
  const plan = buildParlayPlan([a, b]);
  const sheet = buildParlaySheet({ date: "2026-06-12", plan, jqsFetchedAt: null, advBanner: "" });
  assert.match(sheet.rows[0][0], /全2串1.*100元/);
  const header = sheet.rows.find((r) => r[0] === "档位");
  assert.ok(header.includes("怎么买(一注2腿,全中才中)✅") && header.includes("100元:可中/净赚✅") && header.includes("100元期望回收🔶"));
  const iBuy = header.indexOf("怎么买(一注2腿,全中才中)✅"), iOdds = header.indexOf("串赔率✅"),
    iWin = header.indexOf("100元:可中/净赚✅"), iExp = header.indexOf("100元期望回收🔶");
  let checked = 0;
  for (const r of sheet.rows) {
    if (r[0] === "档位" || header.length !== r.length) continue;
    // 怎么买=单列两腿:①【场】玩法→买「选项」@赔率 换行 ②…
    assert.match(String(r[iBuy]), /①【.+】.+→买「.+」@[\d.]+\n②【.+】.+→买「.+」@[\d.]+/);
    const win = Number(String(r[iWin]).match(/可中(\d+)元/)?.[1]);
    assert.equal(win, Math.round(Number(r[iOdds]) * 100), "可中金额必须=串赔×100");
    assert.ok(parseInt(r[iExp]) < 100, "期望回收必须<100元(抽水诚实)");
    checked++;
  }
  assert.ok(checked >= 8, "组合行须实际被校验");
});

test("buildParlayPlan:💎最优value档=抽水最小;每注带价值/抽水;EV恒负(用未取整概率算,防伪正EV)", () => {
  const a = buildParlayLegs(mkPred(), JQS);
  const b = buildParlayLegs(mkPred({ fixture: { homeTeam: "丙队", awayTeam: "丁队", sequence: "5002" } }), JQS);
  const plan = buildParlayPlan([a, b]);
  const val = plan.tiers.find((t) => t.tier === "💎最优value");
  assert.ok(val, "💎最优value 档必须存在");
  for (const c of val.combos) {
    assert.ok(c.valueScore < 1, "价值<1(抽水必存在)");
    assert.ok(c.evMkt < 0, "EV 恒负");
    assert.ok(c.overround > 1, "combo 抽水>1");
    // 价值=∏(未取整概率×赔率)=1/∏overround,误差在3位小数内
    assert.ok(Math.abs(c.valueScore - 1 / c.overround) < 0.005, "valueScore≈1/∏overround");
  }
  // 💎 档头注价值 ≥ 各档任意注价值(它就是抽水最小的真串;同概率最高注被最稳档先占走时取次优,故用全空间校验)
  const allValues = plan.tiers.flatMap((t) => t.combos).map((c) => c.valueScore);
  const topVal = val.combos[0].valueScore;
  // 抽水最小的真串(odds≥3)价值应在全空间前列(允许被最稳档占走1注)
  const sortedDesc = [...allValues].sort((x, y) => y - x);
  assert.ok(topVal >= sortedDesc[Math.min(1, sortedDesc.length - 1)] - 1e-9, "💎头注价值应为全空间前二");
  // EV 用未取整概率:即便最低抽水组合也严格<0(防 r3(probMkt)×r2(odds) 各自进位虚增到≥1)
  const minVigEv = Math.max(...plan.tiers.flatMap((t) => t.combos).map((c) => c.evMkt));
  assert.ok(minVigEv < 0, "全空间最不亏的注 EV 仍严格<0(诚实:串关无正EV)");
  // 相关性汇总(🔶)存在
  assert.ok(typeof plan.correlationNote === "string" && plan.correlationNote.includes("🔶"));
});

test("buildParlayLegs:每腿带真盘抽水 mktOverround(>1)+未取整概率 probMktRaw", () => {
  const g = buildParlayLegs(mkPred(), JQS);
  for (const l of g.legs) {
    assert.ok(l.mktOverround > 1, `${l.market} 抽水必>1`);
    assert.ok(l.probMktRaw > 0 && l.probMktRaw <= 1);
  }
});

test("buildParlayPlan:仅1场有赔率 → ok:false 如实不出(不硬凑单关)", () => {
  const a = buildParlayLegs(mkPred(), JQS);
  const empty = { match: "x vs y", seq: "5009", legs: [] };
  const plan = buildParlayPlan([a, empty]);
  assert.equal(plan.ok, false);
  assert.match(plan.note, /可串场次不足/);
});
