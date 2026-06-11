// 世界杯引擎路由守护(2026-06-11 融合):用户最高指令「足球大模型=唯一大脑」落地后,
// 0611 铁律「世界杯比赛必须用世界杯模型」由 predictFixture 内建路由结构性保证。
// 本守护拦四处:①世界杯正赛场必走 worldcup-match-model(任何入口);②俱乐部域信号/校准/
// 软重校准/防平 drawLean 对路由场必须全旁路;③引擎概率与 wc-match-model 自主观点逐位一致
// (三处一致的根);④非世界杯场绝不被劫持(俱乐部路径零影响)。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { predictFixture } from "../src/prediction-engine.js";
import { predictWcMatch, wcEngineRoute } from "../src/wc-match-model.js";

const WC_FIXTURE = {
  id: "test-wc-route-1",
  homeTeam: "墨西哥",
  awayTeam: "南非",
  competition: "世界杯",
  kickoff: "2026-06-12 02:00",
  date: "2026-06-11",
  marketType: "jingcai"
};

const CLUB_FIXTURE = {
  id: "test-club-route-1",
  homeTeam: "曼城",
  awayTeam: "利物浦",
  competition: "英超",
  kickoff: "2026-06-12 03:00",
  date: "2026-06-11",
  marketType: "jingcai"
};

describe("世界杯引擎路由(0611铁律:世界杯场必用世界杯模型)", () => {
  it("世界杯正赛场自动路由 worldcup-match-model,单选不防平,域隔离全旁路", () => {
    const p = predictFixture(WC_FIXTURE, [], 0, {});
    assert.equal(p.unpredictable, undefined, "48强Elo齐全的世界杯场必须可预测");
    assert.equal(p.provenance, "worldcup-match-model", "世界杯场 provenance 必须=worldcup-match-model");
    assert.ok(p.wcModel, "世界杯域全景(决定因素/市场对照/比分让球)必须挂载");
    // 俱乐部域全部旁路:不防平、不软重校准、不走俱乐部 isotonic
    assert.equal(p.probabilityAdjustment?.drawLean ?? null, null, "drawLean 防平禁用于世界杯路由场");
    assert.equal(p.probabilityAdjustment?.softCompetitionRecal ?? null, null, "软赛事平局重校准禁二次改写 WC 概率");
    assert.equal(p.probabilityAdjustment?.calibration?.applied ?? false, false, "俱乐部 isotonic 校准域不适用国家队");
  });

  it("引擎概率/方向与 wc-match-model 自主观点逐位一致(三处一致的根)", () => {
    const p = predictFixture(WC_FIXTURE, [], 0, {});
    const direct = predictWcMatch(WC_FIXTURE.homeTeam, WC_FIXTURE.awayTeam, WC_FIXTURE, null, {});
    assert.ok(!direct.error, "直跑 wc-match-model 必须成功");
    assert.equal(p.pick.code, direct.wld.pickCode, "主推方向必须一致");
    for (const k of ["home", "draw", "away"]) {
      assert.ok(Math.abs(p.probabilities[k] - direct.wld.probabilities[k]) < 1e-6, `概率 ${k} 必须逐位一致`);
    }
    // 比分从同一 WC λ 矩阵派生(λ 已含场馆/阶段乘子)
    assert.equal(p.wcModel.score.primary, direct.score.primary, "首选比分必须同矩阵同值");
  });

  it("worldCupRouting:false 显式关闭路由(回测/诊断兼容口)", () => {
    const p = predictFixture(WC_FIXTURE, [], 0, { worldCupRouting: false });
    assert.notEqual(p.provenance, "worldcup-match-model", "显式关闭后不得走世界杯路由");
  });

  it("俱乐部场绝不被劫持:无赔率无DC → 诚实 data-missing,而非 WC 模型", () => {
    const p = predictFixture(CLUB_FIXTURE, [], 0, {});
    assert.equal(p.provenance, "data-missing", "俱乐部场(无先验)必须诚实不预测,绝不误入世界杯域");
    assert.equal(p.unpredictable, true);
  });

  it("wcEngineRoute 边界:非世界杯赛事/窗口外/缺 Elo 一律 null", () => {
    assert.equal(wcEngineRoute(CLUB_FIXTURE), null, "英超不路由");
    assert.equal(wcEngineRoute({ ...WC_FIXTURE, kickoff: "2026-08-01 02:00", date: "2026-08-01" }), null, "7/19 后窗口外不路由");
    assert.equal(wcEngineRoute({ ...WC_FIXTURE, homeTeam: "不存在的队" }), null, "缺 48 强 Elo 先验不路由(标缺不兜底)");
  });
});
