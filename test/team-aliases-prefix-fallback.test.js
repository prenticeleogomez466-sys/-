import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalTeamName } from "../src/team-aliases.js";

// team-aliases 的 fallbackCanonical:ESPN/英文源把队名写成「俱乐部前缀 + 队名」
// (FC Groningen / VfL Wolfsburg / 1. FC Köln),整串查不到时剥前缀重查,
// **只有剥后命中已知 canonical 才采用,否则原样返回**(绝不臆造,防错配写错赛果)。
// 本测试锁定:① 前缀剥离能把英文全名收敛到正确 canonical;② 未知/歧义/过短一律不乱映射。

describe("team-aliases 俱乐部前缀剥离兜底(fallbackCanonical)", () => {
  it("英文俱乐部前缀(FC/VfL/1.FC)剥离后收敛到正确 canonical", () => {
    assert.equal(canonicalTeamName("FC Groningen"), "格罗宁根");
    assert.equal(canonicalTeamName("VfL Wolfsburg"), "沃尔夫斯堡");
    assert.equal(canonicalTeamName("1. FC Köln"), "科隆");
  });

  it("城市后缀全名(Ajax Amsterdam / Sparta Rotterdam)经显式别名收敛", () => {
    assert.equal(canonicalTeamName("Ajax Amsterdam"), "阿贾克斯");
    assert.equal(canonicalTeamName("Sparta Rotterdam"), "鹿特丹斯巴达");
  });

  it("沙特短变体两侧收敛同一 canonical(ESPN 核实)", () => {
    assert.equal(canonicalTeamName("利雅胜利"), "利雅得胜利");
    assert.equal(canonicalTeamName("利雅新月"), "利雅得新月");
    assert.equal(canonicalTeamName("Damac"), "达马克");
  });

  it("未知队名剥前缀也命中不到 → 原样返回,绝不臆造(no fabrication)", () => {
    assert.equal(canonicalTeamName("fcunknownxyzzz"), "fcunknownxyzzz");
  });

  it("歧义裸名(tokyo 可指东京FC/东京绿茵/东京V)→ 不自动映射到任一具体队", () => {
    assert.equal(canonicalTeamName("tokyo"), "tokyo");
  });

  it("过短串(sv)→ 不触发剥离(长度护栏),原样返回", () => {
    assert.equal(canonicalTeamName("sv"), "sv");
  });

  it("东京FC 各变体一致收敛、不分裂(变体分裂回归守护)", () => {
    const c = canonicalTeamName("东京FC");
    assert.equal(canonicalTeamName("fctokyo"), c);
    assert.equal(canonicalTeamName("FC Tokyo"), c);
  });
});
