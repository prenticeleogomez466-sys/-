import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFormation,
  formationPosture,
  normalizeEspnLineup,
  normalizeSofascoreLineup,
  matchEspnEvent
} from "../src/lineup-source.js";
import { collectFusionEvidence, SIGNAL_NAMES } from "../src/signal-fusion-layer.js";

test("parseFormation 解析常见阵型 + 拒绝非法串", () => {
  assert.deepEqual(parseFormation("4-4-2"), { defenders: 4, midfielders: 4, forwards: 2, raw: "4-4-2" });
  assert.deepEqual(parseFormation("3-4-2-1"), { defenders: 3, midfielders: 6, forwards: 1, raw: "3-4-2-1" });
  assert.equal(parseFormation("abc"), null);
  assert.equal(parseFormation(""), null);
  assert.equal(parseFormation(null), null);
  assert.equal(parseFormation("1-1"), null);        // 总人数 <7 不合理
  assert.equal(parseFormation("5-5-5"), null);       // 总人数 >10 不合理
});

test("formationPosture 用无歧义判据(后卫数/真三前锋)", () => {
  const def = formationPosture("5-4-1");
  assert.equal(def.defensive, true);    // 5 后卫
  assert.equal(def.attacking, false);
  const atk = formationPosture("4-3-3");
  assert.equal(atk.attacking, true);    // 3 前锋
  assert.equal(atk.defensive, false);
  // 4-4-2 / 4-2-3-1 都是中性(不再被 forwards<=1 误判成摆防)
  const mid = formationPosture("4-4-2");
  assert.equal(mid.defensive, false);
  assert.equal(mid.attacking, false);
  const balanced = formationPosture("4-2-3-1");
  assert.equal(balanced.defensive, false, "4-2-3-1 不是摆防");
  assert.equal(balanced.attacking, false);
  assert.equal(formationPosture("garbage"), null);
});

test("normalizeEspnLineup 从 rosters 提 formation+首发+confirmed", () => {
  const summary = {
    rosters: [
      {
        homeAway: "home",
        team: { displayName: "Fagiano Okayama" },
        formation: "3-4-2-1",
        roster: Array.from({ length: 11 }, (_, i) => ({
          starter: true,
          athlete: { displayName: `H${i}` },
          position: { abbreviation: i === 0 ? "G" : "M" },
          formationPlace: String(i + 1)
        })).concat([{ starter: false, athlete: { displayName: "Bench" }, position: { abbreviation: "F" } }])
      },
      {
        homeAway: "away",
        team: { displayName: "Urawa Red Diamonds" },
        formation: "4-4-2",
        roster: Array.from({ length: 11 }, (_, i) => ({ starter: true, athlete: { displayName: `A${i}` }, position: { abbreviation: "D" } }))
      }
    ]
  };
  const lu = normalizeEspnLineup(summary);
  assert.equal(lu.source, "espn-summary");
  assert.equal(lu.home.formation, "3-4-2-1");
  assert.equal(lu.home.starterCount, 11);
  assert.equal(lu.home.confirmed, true);
  assert.equal(lu.home.starters[0].name, "H0");
  assert.equal(lu.home.starters[0].position, "G");
  assert.equal(lu.away.formation, "4-4-2");
  assert.equal(lu.confirmed, true);   // 两侧都满 11
});

test("normalizeEspnLineup 不满 11 人 → confirmed:false;无 rosters → null", () => {
  const partial = {
    rosters: [
      { homeAway: "home", team: { displayName: "A" }, formation: "4-4-2", roster: [{ starter: true, athlete: { displayName: "x" } }] },
      { homeAway: "away", team: { displayName: "B" }, formation: "4-4-2", roster: [{ starter: true, athlete: { displayName: "y" } }] }
    ]
  };
  const lu = normalizeEspnLineup(partial);
  assert.equal(lu.confirmed, false);
  assert.equal(lu.home.confirmed, false);
  assert.equal(normalizeEspnLineup({}), null);
  assert.equal(normalizeEspnLineup({ rosters: [{ homeAway: "home" }] }), null);
});

test("normalizeSofascoreLineup 归一浏览器喂入的首发", () => {
  const lineups = {
    confirmed: true,
    home: { formation: "4-2-3-1", players: [
      { player: { name: "GK", position: "G" }, substitute: false },
      { player: { name: "Sub", position: "M" }, substitute: true }
    ] },
    away: { formation: "4-3-3", players: [{ player: { name: "AW", position: "F" }, substitute: false }] }
  };
  const lu = normalizeSofascoreLineup(lineups);
  assert.equal(lu.source, "sofascore-lineups");
  assert.equal(lu.home.formation, "4-2-3-1");
  assert.equal(lu.home.starters.length, 1);   // 排除替补
  assert.equal(lu.home.starters[0].name, "GK");
  assert.equal(normalizeSofascoreLineup(null), null);
});

test("matchEspnEvent 主客两侧都匹配才返回 event id", () => {
  const events = [
    {
      id: "evt-1",
      competitions: [{ competitors: [
        { homeAway: "home", team: { displayName: "Fagiano Okayama" } },
        { homeAway: "away", team: { displayName: "Urawa Red Diamonds" } }
      ] }]
    }
  ];
  assert.equal(matchEspnEvent(events, { homeTeam: "Fagiano Okayama", awayTeam: "Urawa Red Diamonds" }), "evt-1");
  // 主客顺序反了 → 不匹配(防误配)
  assert.equal(matchEspnEvent(events, { homeTeam: "Urawa Red Diamonds", awayTeam: "Fagiano Okayama" }), null);
  assert.equal(matchEspnEvent([], { homeTeam: "A", awayTeam: "B" }), null);
});

test("lineup 信号默认休眠(回测无增益),无数据→对应 dormant 理由", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const fx = { id: "f1", homeTeam: "甲", awayTeam: "乙", competition: "日职" };

  // 有 formation 但默认关 → dormant: disabled-backtest-no-gain
  const advDef = { fixtures: [{ fixtureId: "f1", data: { lineups: { home: { formation: "5-4-1" }, away: { formation: "5-3-2" } } } }] };
  const off = collectFusionEvidence(prior, fx, advDef, {});
  assert.equal(off.evidence.find((e) => e.name === "lineup"), undefined, "默认不 fire");
  assert.equal(off.dormant.find((d) => d.name === "lineup")?.dormant, "disabled-backtest-no-gain-2026-05-31");

  // 无 formation → dormant: no-lineup-formations
  const none = collectFusionEvidence(prior, fx, { fixtures: [] }, {});
  assert.equal(none.dormant.find((d) => d.name === "lineup")?.dormant, "no-lineup-formations");
});

test("lineup 信号显式开启时按布阵姿态 fire(能力保留、回测可复现)", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const fx = { id: "f1", homeTeam: "甲", awayTeam: "乙", competition: "日职" };
  const ctx = { enableLineupPosture: true };

  const advDef = { fixtures: [{ fixtureId: "f1", data: { lineups: { home: { formation: "5-4-1" }, away: { formation: "5-3-2" } } } }] };
  const def = collectFusionEvidence(prior, fx, advDef, ctx).evidence.find((e) => e.name === "lineup");
  assert.ok(def, "开启后双摆防应 fire");
  assert.ok(def.ratio.draw > 1, "平局 LR 应 >1");

  const advAtk = { fixtures: [{ fixtureId: "f1", data: { lineups: { home: { formation: "4-3-3" }, away: { formation: "3-4-3" } } } }] };
  const atk = collectFusionEvidence(prior, fx, advAtk, ctx).evidence.find((e) => e.name === "lineup");
  assert.ok(atk, "开启后双压上应 fire");
  assert.ok(atk.ratio.draw < 1, "平局 LR 应 <1");

  // 一攻一守 → neutral-posture(开启状态下)
  const advMixed = { fixtures: [{ fixtureId: "f1", data: { lineups: { home: { formation: "4-3-3" }, away: { formation: "5-4-1" } } } }] };
  const mixed = collectFusionEvidence(prior, fx, advMixed, ctx);
  assert.equal(mixed.evidence.find((e) => e.name === "lineup"), undefined);
  assert.equal(mixed.dormant.find((d) => d.name === "lineup")?.dormant, "neutral-posture");
});

test("lineup 已登记进 SIGNAL_NAMES 且无重复", () => {
  assert.ok(SIGNAL_NAMES.includes("lineup"));
  assert.equal(new Set(SIGNAL_NAMES).size, SIGNAL_NAMES.length);
});

test("有市场先验时 lineup 被 gateFusionOff 关闭(disabledSignals 全关)", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const fx = { id: "f1", homeTeam: "甲", awayTeam: "乙", competition: "日职" };
  const advDef = { fixtures: [{ fixtureId: "f1", data: { lineups: { home: { formation: "5-4-1" }, away: { formation: "5-3-2" } } } }] };
  const gated = collectFusionEvidence(prior, fx, advDef, {}, { disabledSignals: SIGNAL_NAMES });
  assert.equal(gated.evidence.find((e) => e.name === "lineup"), undefined);
  assert.equal(gated.dormant.find((d) => d.name === "lineup")?.dormant, "disabled");
});
