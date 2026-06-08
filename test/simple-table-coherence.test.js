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
  const s = String(t);
  // 2026-06-07「明确单一方向」:胜负平/让球/半全场首段即该场方向→取最左出现的方向词判方向
  //   (让球"让球主胜…"、胜负平"客胜…"、半全场"主胜-主胜…"首段均为该场方向)。
  const m = s.match(/(让球主胜|让球客胜|走盘|主胜|客胜|平局)/);
  if (!m) return /平/.test(s) ? "draw" : null;
  const w = m[1];
  if (w === "走盘") return "draw";
  if (w.includes("主胜")) return "home";
  if (w.includes("客胜")) return "away";
  return "draw";
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

  it("胜负平给主选+次选两方向(2026-06-08 规格,客胜场主选=客胜)", () => {
    const p = makePrediction("0"); // away 0.55 > draw 0.25 > home 0.20
    const cell = simpleWldCell(p);
    assert.match(cell, /主选 客胜/); // 主选=最高概率方向=客胜,排首
    assert.match(cell, /次选 平局/); // 次选=剩余两态更高者=平局(用户要主选+次选)
    // 主选排首保证主方向清晰(dirOfText 取首段判方向)
    assert.equal(dirOfText(cell), "away");
  });

  it("比分/半全场支持同向多选推荐(有市场分布时给多个候选,且全部同向)", () => {
    const p = makePrediction("3");
    p.scorePicks = {
      wldConsistent: "2-0", wldConsistentProbability: 0.15,
      marketDistribution: [
        { score: "2-0", probability: 0.15 }, { score: "1-0", probability: 0.14 },
        { score: "2-1", probability: 0.12 }, { score: "0-1", probability: 0.05 }
      ]
    };
    p.halfFullPicks = {
      primary: "主胜-主胜", primaryProbability: 0.45,
      marketDistribution: [
        { halfFull: "主胜-主胜", probability: 0.45 }, { halfFull: "平局-主胜", probability: 0.22 },
        { halfFull: "客胜-客胜", probability: 0.05 }
      ]
    };
    const sc = simpleScoreCell(p);
    assert.match(sc, / \/ /);          // 多选(候选用 / 分隔)
    assert.doesNotMatch(sc, /0-1/);    // 只含同向(主胜 h>a),反向 0-1 不出现
    const hf = simpleHalfFullCell(p);
    assert.match(hf, / \/ /);          // 多选
    assert.match(hf, /平局-主胜/);      // 含"同终场不同上半"的真实候选(终场=主胜)
    assert.doesNotMatch(hf, /客胜-客胜/); // 终场≠主胜的不出现
  });

  // 2026-06-08 规格(用户:四列以「主选+次选」两方向为锚,"有平局就按平局推比分半全场"):
  //   强热门(主胜)次选=平局时,比分多选应=主选向 top + 平局向(1-1),半全场=FT主胜 + 平局-平局;
  //   但绝不出第三方向(客胜向 0-1 / 客胜-客胜)。primary 恒排首保证主方向清晰。
  it("✅主选+次选:次选=平局时比分/半全场带平局向候选,但绝不出第三方向(客胜)", () => {
    const p = makePrediction("3"); // home0.55 > draw0.25 > away0.20 → c1=主胜,c2=平局
    p.scorePicks = {
      wldConsistent: "2-0", primary: "2-0",
      distribution: [
        { score: "2-0", probability: 0.18 }, { score: "1-0", probability: 0.14 },
        { score: "1-1", probability: 0.10 }, { score: "0-1", probability: 0.06 }, { score: "0-2", probability: 0.04 }
      ]
    };
    p.halfFullPicks = {
      primary: "主胜-主胜", primaryProbability: 0.48,
      distribution: [
        { halfFull: "主胜-主胜", probability: 0.48 }, { halfFull: "平局-主胜", probability: 0.20 },
        { halfFull: "平局-平局", probability: 0.10 }, { halfFull: "客胜-客胜", probability: 0.05 }
      ]
    };
    const sc = simpleScoreCell(p);
    assert.equal(dirOfScore(sc), "home", `比分首选应主胜(主选排首),实得 ${sc}`);
    assert.match(sc, /1-1/);              // 次选=平局 → 平局比分入选(有平局按平局推)
    assert.doesNotMatch(sc, /0-1|0-2/);   // 第三方向(客胜)绝不出现
    const hf = simpleHalfFullCell(p);
    assert.equal(dirOfText(hf), "home", `半全场首选应主胜,实得 ${hf}`);
    assert.match(hf, /平局-平局/);          // 次选=平局 → FT平局路径入选
    assert.doesNotMatch(hf, /客胜-客胜/);   // 第三方向(终场客胜)绝不出现
  });
});
