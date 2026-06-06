import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  simpleWldCell,
  simpleHandicapCell,
  simpleScoreCell,
  simpleHalfFullCell
} from "../src/daily-report.js";

// 极简竞彩表的四列(胜负平/让胜负平/比分/半全场)必须永远同向——这是用户硬规则
// feedback_jingcai_simple_table 的核心。四个 cell builder 全部从 pick.code 一条主线派生
// (scorePicks.wldConsistent / halfFullPicks.primary / coherentHandicapView),本测试把
// "同向"钉成回归不变量:谁日后把某列改成读别的字段、方向漂了,立刻红。

// 从一个 cell 文本里判定它表达的方向:home / away / draw / null
//   胜负平格现为"主选 X% / 副选 Y%"双向→只取主选那段判方向(主选=与比分/半全场同源)。
function dirOfText(t) {
  let s = String(t);
  const mainSeg = s.match(/主选\s*(主胜|平局|客胜)/);
  if (mainSeg) s = mainSeg[1];
  if (s.includes("主胜")) return "home";
  if (s.includes("客胜")) return "away";
  if (s.includes("平局") || s.includes("走盘") || /(^|[^胜])平([^负]|$)/.test(s)) return "draw";
  return null;
}
// 比分 "2-1" → 主胜;"0-1" → 客胜;"1-1" → 平
function dirOfScore(t) {
  const m = String(t).match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  return h > a ? "home" : h < a ? "away" : "draw";
}

function makePrediction(code) {
  const dirWord = code === "3" ? "主胜" : code === "1" ? "平局" : "客胜";
  const score = code === "3" ? "2-1" : code === "1" ? "1-1" : "0-1";
  const probs = code === "3"
    ? { home: 0.55, draw: 0.25, away: 0.20 }
    : code === "1"
      ? { home: 0.30, draw: 0.40, away: 0.30 }
      : { home: 0.20, draw: 0.25, away: 0.55 };
  const hwld = code === "3"
    ? { home: 0.60, push: 0.25, away: 0.15 }
    : code === "1"
      ? { home: 0.30, push: 0.45, away: 0.25 }
      : { home: 0.15, push: 0.25, away: 0.60 };
  return {
    pick: { code, label: dirWord },
    probabilities: probs,
    doubleChance: null,
    jingcaiLetqiu: null,
    handicapPick: { line: code === "1" ? 0 : (code === "3" ? -1 : 1), direction: dirWord, handicapWld: { probabilities: hwld } },
    scorePicks: { wldConsistent: score, wldConsistentProbability: 0.14 },
    halfFullPicks: { primary: `${dirWord}-${dirWord}`, primaryProbability: 0.3 }
  };
}

describe("极简表四列方向一致性不变量(simple-table-coherence)", () => {
  for (const [code, name] of [["3", "主胜"], ["1", "平局"], ["0", "客胜"]]) {
    it(`${name}(code=${code}):胜负平/让胜负平/比分/半全场 四列同向`, () => {
      const p = makePrediction(code);
      const wld = dirOfText(simpleWldCell(p));
      const han = dirOfText(simpleHandicapCell(p));
      const sco = dirOfScore(simpleScoreCell(p));
      const hf = dirOfText(simpleHalfFullCell(p));
      const expected = code === "3" ? "home" : code === "1" ? "draw" : "away";
      assert.equal(wld, expected, `胜负平方向应为 ${expected},实得 ${wld}`);
      assert.equal(han, expected, `让胜负平方向应为 ${expected},实得 ${han}`);
      assert.equal(sco, expected, `比分方向应为 ${expected},实得 ${sco}`);
      assert.equal(hf, expected, `半全场方向应为 ${expected},实得 ${hf}`);
    });
  }

  it("⛔ 未开售(本场只让球)→ 胜负平列给真实性闸,不冒充干净方向", () => {
    const p = makePrediction("3");
    p.jingcaiLetqiu = { sfcSold: false };
    assert.match(simpleWldCell(p), /未开售/);
  });

  it("中低档双选升级(doubleChance.recommended)→ 胜负平显示双选但仍含主推方向", () => {
    const p = makePrediction("0");
    p.doubleChance = { recommended: true, pick: "平局/客胜", shortCode: "X2" };
    const cell = simpleWldCell(p);
    assert.match(cell, /双选/);
    assert.match(cell, /客胜/); // 主推方向仍在,和比分/半全场同向
  });
});
