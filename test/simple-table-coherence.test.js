import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  simpleWldCell,
  simpleHandicapCell,
  simpleScoreCell,
  simpleHalfFullCell
} from "../src/daily-report.js";
import { coherentHandicapView, validatePredictionConsistency } from "../src/prediction-engine.js";

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

// 深让盘 favorite 翻转(handicap-favorite-flip-label-fix-3,2026-06-08):
//   韩国vs捷克式深盘——1X2 主推主胜(让1球的强热门),但让球盘上"让球主胜过盘"只 15%,
//   真实最高过盘方向是"让球客胜"53%(赢球未必赢盘=让球玩法语义)。旧显示硬跟 wld 主推→误显"让球主胜15%"。
//   修后:仅当对侧过盘概率≥0.50 且严格>本侧(wld锚侧)时,让球主选改取真实最高过盘方向并注明"深盘与1X2背离属正常"。
//   注意:这是上面"四列同向不变量"的**显式例外**——makePrediction 平衡场对侧过盘均<0.50 不触发翻转,
//   故上面 3 档同向用例不受影响、仍验同向;此处单独验翻转场让球列可与 1X2 背离(深盘语义,非冲突)。
describe("深让盘favorite翻转·让球列可与1X2背离(handicap-favorite-flip-label-fix-3)", () => {
  function makeKoreaStyle() {
    return {
      pick: { code: "3", label: "主胜" },
      probabilities: { home: 0.55, draw: 0.25, away: 0.20 },
      jingcaiLetqiu: { line: -1, probabilities: { home: 0.15, draw: 0.32, away: 0.53 }, pick: { code: "0", label: "客胜" }, sfcSold: true },
      handicapPick: { line: -1, direction: "主胜", directionCode: "3", handicapWld: { probabilities: { home: 0.15, push: 0.32, away: 0.53 } } },
      scorePicks: { wldConsistent: "2-1" },
      halfFullPicks: { primary: "主胜-主胜" }
    };
  }

  it("韩国式深盘favorite翻转:wld主推主胜但让球客胜过盘53%→主选改取客胜方向+背离注明", () => {
    const p = makeKoreaStyle();
    const v = coherentHandicapView(p);
    assert.match(v.headline, /让球客胜/, `headline 应含让球客胜,实得 ${v.headline}`);
    assert.match(v.headline, /53%/, `headline 应含 53%,实得 ${v.headline}`);
    assert.doesNotMatch(v.headline, /让球主胜\s*15%/, "不应仍显示让球主胜15%");
    const blob = `${v.headline} ${v.detail}`;
    assert.match(blob, /背离|赢球未必赢盘/, `应注明背离/赢球未必赢盘,实得 ${blob}`);
    assert.equal(v.multi, true);

    const cell = simpleHandicapCell(p);
    assert.match(cell, /让球客胜/, `极简格主选应=让球客胜,实得 ${cell}`);
    assert.match(cell, /53%/, `极简格应含 53%,实得 ${cell}`);
    // 次选改为 wld 锚的主胜(15%),不再主次同为客胜
    assert.match(cell, /次选 让球主胜/, `极简格次选应=让球主胜(wld锚),实得 ${cell}`);
    assert.match(cell, /15%/, `极简格次选应含 15%,实得 ${cell}`);

    // handicapPick.direction 未被改动(锚 wld,validator 靠它)
    assert.equal(p.handicapPick.direction, "主胜");
    assert.deepEqual(validatePredictionConsistency(p), []);
  });

  it("荷兰/法国式borderline深盘:本侧34-46%、对侧<0.50→不触发翻转,保持现wld锚行为", () => {
    const p = {
      pick: { code: "3", label: "主胜" },
      probabilities: { home: 0.60, draw: 0.22, away: 0.18 },
      jingcaiLetqiu: { line: -2, probabilities: { home: 0.40, draw: 0.27, away: 0.33 }, pick: { code: "3", label: "主胜" }, sfcSold: true },
      handicapPick: { line: -2, direction: "主胜", directionCode: "3", handicapWld: { probabilities: { home: 0.40, push: 0.27, away: 0.33 } } },
      scorePicks: { wldConsistent: "2-0" },
      halfFullPicks: { primary: "主胜-主胜" }
    };
    const v = coherentHandicapView(p);
    assert.match(v.headline, /让球主胜/, `borderline 应保持 wld 锚=让球主胜,实得 ${v.headline}`);
    assert.match(v.headline, /40%/);
    const blob = `${v.headline} ${v.detail}`;
    assert.doesNotMatch(blob, /背离|赢球未必赢盘/, "borderline 不应注明背离");
    assert.match(v.detail, /把握低/, "本侧<0.5 走把握低分支");
    assert.match(simpleHandicapCell(p), /主选 让球主胜/);
  });

  it("对侧恰好0.50边界且严格大于本侧→触发翻转(阈值闭区间≥0.50验证)", () => {
    const p = makeKoreaStyle();
    p.jingcaiLetqiu.probabilities = { home: 0.20, draw: 0.30, away: 0.50 };
    p.handicapPick.handicapWld.probabilities = { home: 0.20, push: 0.30, away: 0.50 };
    const v = coherentHandicapView(p);
    assert.match(v.headline, /让球客胜/, `对侧=0.50 应翻转,实得 ${v.headline}`);
    assert.match(v.headline, /50%/);
  });

  it("对侧≥0.50但=本侧(并列不严格大于)→不翻转(防并列误翻)", () => {
    const p = makeKoreaStyle();
    // 本侧 home=0.50,对侧 away=0.50,并列不严格大于
    p.jingcaiLetqiu.probabilities = { home: 0.50, draw: 0.00, away: 0.50 };
    p.handicapPick.handicapWld.probabilities = { home: 0.50, push: 0.00, away: 0.50 };
    const v = coherentHandicapView(p);
    assert.match(v.headline, /让球主胜/, `并列不应翻转,保持 wld 锚=让球主胜,实得 ${v.headline}`);
    const blob = `${v.headline} ${v.detail}`;
    assert.doesNotMatch(blob, /背离/, "并列不翻转,不注明背离");
  });

  it("push为wld主推(side=push)场→翻转逻辑不介入,走盘分支不变", () => {
    const p = makeKoreaStyle();
    p.pick = { code: "1", label: "平局" };
    p.jingcaiLetqiu.probabilities = { home: 0.15, draw: 0.55, away: 0.30 };
    p.handicapPick.handicapWld.probabilities = { home: 0.15, push: 0.55, away: 0.30 };
    const v = coherentHandicapView(p);
    assert.match(v.headline, /走盘/, `side=push 应走走盘分支,实得 ${v.headline}`);
    const blob = `${v.headline} ${v.detail}`;
    assert.doesNotMatch(blob, /背离/, "走盘场不触发翻转背离");
  });
});
