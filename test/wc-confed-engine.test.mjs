import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { predictFixture } from "../src/prediction-engine.js";
import { teamPrior } from "../src/world-cup-priors.js";

// ─────────────────────────────────────────────────────────────────────────────
// 洲际 Elo 校正接入 prediction-engine national-elo 分支(2026-06-10)守护测试。
// 回测裁决(D:\Temp\wc-precheck\backtest-confed-homeadv.mjs,49291 场 intl-results):
//   A 洲际校正 PASS:严格 OOS 后 40% n=2589 命中 +1.08pp CI[+0.12,+2.09]、
//     Brier −0.0083 CI[−0.0131,−0.0036],双指标 CI 不含 0。
//   B 中立场 homeAdv 35→0 FAIL(CI 全含 0)→ 不落地,本测试同时守护 homeAdv 仍为默认 35。
// 对阵取 2026-06-11(揭幕日)真实赛程:墨西哥vs南非、韩国vs捷克(match-dates.json)。
// ─────────────────────────────────────────────────────────────────────────────

// team-priors.json 缺失的环境(如裸 CI)诚实跳过,不静默假绿。
const hasPriors = Boolean(teamPrior("韩国")?.en && teamPrior("捷克")?.en);

// 两队 Elo 故意取相等:隔离洲际校正对 supremacy/λ 的影响(无校正时只剩 homeAdv=35)。
const ELO = { elo: { "韩国": 1750, "捷克": 1750, "法国": 1750, "墨西哥": 1700, "南非": 1700, "中国": 1500, "泰国": 1500 } };

function wcFixture(home, away) {
  return {
    id: `wc-${home}-${away}`,
    date: "2026-06-11",
    kickoff: "2026-06-11 19:00",
    competition: "世界杯",
    homeTeam: home,
    awayTeam: away,
    marketType: "jingcai",
    sequence: "001",
    tags: [],
  };
}

describe("世界杯洲际 Elo 校正(national-elo 分支)", { skip: hasPriors ? false : "team-priors.json 缺失,无法验证洲际校正" }, () => {
  it("揭幕日真实对阵 韩国(AFC)vs捷克(UEFA):confedAdj=−100 进 λ 且审计可追溯", () => {
    const p = predictFixture(wcFixture("韩国", "捷克"), [], 0, { nationalElo: ELO });
    assert.ok(p.nationalElo, "应走 national-elo 分支");
    // AFC(−80) − UEFA(+20) = −100,落进 nationalEloUsed 审计轨迹
    assert.equal(p.nationalElo.confedAdj, -100);
    // eloDiff 含校正:(1750−100) − 1750 = −100
    assert.equal(p.nationalElo.eloDiff, -100);
    // supremacy = (−100 + homeAdv 35)/170 = −0.38 —— 同时守护 B 裁决:homeAdv 保持 35(归零方案 FAIL 不采用,
    // 若有人误把 homeAdv 改 0,此处会算出 −0.59 而非 −0.38,测试翻红)。
    assert.equal(p.nationalElo.supremacy, -0.38);
    // 方向断言:等 Elo 下校正后捷克(被低估的 UEFA)概率应高于韩国
    assert.ok(p.probabilities.away > p.probabilities.home, "校正应把方向推向 UEFA 一侧");
  });

  it("同等 Elo 的同洲对照(法国vs捷克 UEFA 内战):confedAdj=0,主队仍享 homeAdv", () => {
    const p = predictFixture(wcFixture("法国", "捷克"), [], 0, { nationalElo: ELO });
    assert.ok(p.nationalElo);
    assert.equal(p.nationalElo.confedAdj, 0);
    assert.equal(p.nationalElo.supremacy, 0.21); // 35/170,与改动前完全一致
    // 交叉验证校正方向:同 Elo 下,韩国(主)对捷克的主胜率 < 法国(主)对捷克的主胜率
    const pk = predictFixture(wcFixture("韩国", "捷克"), [], 0, { nationalElo: ELO });
    assert.ok(pk.probabilities.home < p.probabilities.home, "AFC 主队应被 haircut");
  });

  it("揭幕战真实对阵 墨西哥(CONCACAF −60)vs南非(CAF −60):同 delta 对消 confedAdj=0", () => {
    const p = predictFixture(wcFixture("墨西哥", "南非"), [], 0, { nationalElo: ELO });
    assert.ok(p.nationalElo);
    assert.equal(p.nationalElo.confedAdj, 0);
  });

  it("非 48 强国家队(中国vs泰国):teamPrior 查无 → confedAdj=0,普通国家队路径零影响", () => {
    assert.equal(teamPrior("中国"), null);
    const p = predictFixture(wcFixture("中国", "泰国"), [], 0, { nationalElo: ELO });
    assert.ok(p.nationalElo);
    assert.equal(p.nationalElo.confedAdj, 0);
    assert.equal(p.nationalElo.supremacy, 0.21); // 与改动前行为完全一致
  });
});
