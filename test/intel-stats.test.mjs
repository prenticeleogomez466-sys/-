// 情报统计层守护(2026-06-15):统计全✅可追溯/派生🔶注依据/样本缺→null不编;决定性。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScore, formStats, homeAwaySplit, formMomentum, scheduleCongestion,
  attackDefenseProfile, h2hStats, lineupStability, lineupAvailability,
} from "../src/intel-stats.js";

const form = (arr) => ({ list: arr });
const G = (date, ha, vs, r, score) => ({ date, ha, vs, r, score });

test("parseScore: 解析本队-对手,非法→null不猜", () => {
  assert.deepEqual(parseScore("2-0"), { own: 2, opp: 0 });
  assert.deepEqual(parseScore("1:1"), { own: 1, opp: 1 });
  assert.equal(parseScore("待定"), null);
  assert.equal(parseScore(null), null);
});

test("formStats: 多维统计全✅可追溯;无可解析赛果→null", () => {
  assert.equal(formStats(form([])), null);
  assert.equal(formStats(form([G("2026-06-10", "主", "X", "胜", "无")])), null);
  const s = formStats(form([
    G("2026-06-10", "主", "A", "胜", "3-0"),
    G("2026-06-06", "客", "B", "平", "1-1"),
    G("2026-06-02", "主", "C", "负", "0-2"),
    G("2026-05-28", "客", "D", "胜", "2-1"),
  ]));
  assert.equal(s.tag, "✅实测");
  assert.equal(s.n, 4);
  assert.equal(s.w, 2); assert.equal(s.d, 1); assert.equal(s.l, 1);
  assert.equal(s.ppg, Math.round((7 / 4) * 100) / 100);   // (2*3+1)/4=1.75
  assert.equal(s.gfPer, Math.round((6 / 4) * 100) / 100);  // 3+1+0+2=6
  assert.equal(s.gaPer, Math.round((4 / 4) * 100) / 100);  // 0+1+2+1=4
  assert.equal(s.bttsPct, 50);   // 1-1, 2-1 双方进球 =2/4
  assert.equal(s.over25Pct, 50); // 3-0,2-1 ≥3球 =2/4
  assert.equal(s.cleanSheetPct, 25); // 3-0 零封 =1/4
});

test("homeAwaySplit: 主客分组各自战绩;全无→null", () => {
  const sp = homeAwaySplit(form([
    G("d1", "主", "A", "胜", "2-0"), G("d2", "主", "B", "胜", "1-0"), G("d3", "客", "C", "负", "0-1"),
  ]));
  assert.equal(sp.home.w, 2);
  assert.equal(sp.away.l, 1);
  assert.ok(sp.text.includes("主场") && sp.text.includes("客场"));
  assert.equal(homeAwaySplit(form([])), null);
});

test("formMomentum: 连续态+走势=🔶注依据;空→null;决定性", () => {
  const m = formMomentum(form([
    G("2026-06-10", "主", "A", "胜", "2-0"), G("2026-06-06", "客", "B", "胜", "1-0"),
    G("2026-06-02", "主", "C", "胜", "3-1"), G("2026-05-28", "客", "D", "负", "0-1"),
  ]));
  assert.equal(m.tag, "🔶推断");
  assert.equal(m.streak, "3连胜");
  assert.equal(m.unbeaten, 3);
  assert.deepEqual(formMomentum(form([])), null);
  assert.deepEqual(m, formMomentum(form([
    G("2026-06-10", "主", "A", "胜", "2-0"), G("2026-06-06", "客", "B", "胜", "1-0"),
    G("2026-06-02", "主", "C", "胜", "3-1"), G("2026-05-28", "客", "D", "负", "0-1"),
  ])));
});

test("scheduleCongestion: 距今天数+密集旗标(依据真实日期+参照日)", () => {
  const c = scheduleCongestion(form([G("2026-06-13", "主", "A", "胜", "1-0"), G("2026-06-05", "客", "B", "平", "1-1")]), "2026-06-15");
  assert.equal(c.restDays, 2);
  assert.equal(c.congested, true);  // ≤3天
  assert.equal(scheduleCongestion(form([]), "2026-06-15"), null);
});

test("attackDefenseProfile: 火力/防守档(依据场均进失)", () => {
  const p = attackDefenseProfile({ gfPer: 2.3, gaPer: 0.5 });
  assert.ok(p.attack.includes("火力强") && p.defense.includes("铁桶"));
  assert.equal(attackDefenseProfile(null), null);
});

test("h2hStats: 结构化交锋统计;无结构化→null(绝不从文本编)", () => {
  assert.equal(h2hStats(null), null);
  assert.equal(h2hStats([{ note: "上次2-1" }]), null); // 无可解析 score
  const h = h2hStats([{ score: "2-1" }, { score: "0-0" }, { score: "1-3" }]);
  assert.equal(h.n, 3); assert.equal(h.w, 1); assert.equal(h.d, 1); assert.equal(h.l, 1);
  assert.equal(h.avgTotal, Math.round((3 + 0 + 4) / 3 * 100) / 100);
});

test("lineupStability: 铁主力/轮换风险(依据 starts/n)", () => {
  const s = lineupStability({ n: 4, xi: [
    { name: "A", starts: 4 }, { name: "B", starts: 4 }, { name: "C", starts: 2 },
  ] });
  assert.equal(s.tag, "🔶推断");
  assert.equal(s.coreCount, 2);
  assert.equal(s.rotationalCount, 1);
  assert.equal(lineupStability({ n: 0, xi: [] }), null);
});

test("lineupAvailability: 预测XI∩伤停名单(名字匹配,匹配不上不夸大)", () => {
  const a = lineupAvailability(
    [{ name: "Vinicius Junior" }, { name: "Rodrygo" }, { name: "Casemiro" }],
    [{ name: "Casemiro" }, { name: "Unknown Player" }]
  );
  assert.equal(a.missingFromXI, 1);
  assert.ok(a.names.includes("Casemiro"));
  assert.equal(lineupAvailability([], [{ name: "X" }]), null);
});
