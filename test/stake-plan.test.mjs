// 注金分层+战绩行守护(2026-06-12 三裁决):倍率单调、只挂最可信玩法、档位缺不给钱、战绩只读已结算行绝不编。
import test from "node:test";
import assert from "node:assert/strict";
import { stakeMultiplier, buildStakeSuggestion, stakeSummary, STAKE_BASE } from "../src/stake-plan.js";
import { buildRecordLine } from "../src/recap-record-line.js";

test("stakeMultiplier:一档2/二档1/三档1/偏弱0.5/硬币0.5 单调不增;未知档=null", () => {
  const seq = ["🟢一档", "🟢二档", "🟡三档", "🟠偏弱", "⚪硬币档"].map(stakeMultiplier);
  assert.deepEqual(seq, [2, 1, 1, 0.5, 0.5]);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1], "倍率必须单调不增");
  assert.equal(stakeMultiplier(""), null);
  assert.equal(stakeMultiplier(undefined), null);
});

const basePred = (over = {}) => ({
  selectionTier: { label: "🟢一档" },
  pick: { label: "主胜" },
  probabilities: { home: 0.62, draw: 0.22, away: 0.16 },
  handicapPick: { line: -1, handicapWld: { pick: "让球客胜", pickCode: "0", probability: 0.55 } },
  marketSnapshot: { jingcaiHandicap: { line: -1 } },
  ...over,
});

test("buildStakeSuggestion:胜负平概率高→挂胜负平;让球过盘概率更高→挂让球;金额=基础×倍率", () => {
  const s1 = buildStakeSuggestion(basePred());
  assert.equal(s1.market, "胜负平");
  assert.equal(s1.sel, "主胜");
  assert.equal(s1.stake, STAKE_BASE * 2);
  const s2 = buildStakeSuggestion(basePred({ handicapPick: { line: -1, handicapWld: { pick: "让球客胜", pickCode: "0", probability: 0.80 } }, selectionTier: { label: "⚪硬币档" } }));
  assert.equal(s2.market, "让球(-1)");
  assert.equal(s2.sel, "让球客胜");
  assert.equal(s2.stake, STAKE_BASE * 0.5, "硬币档减半(不弃赛)");
});

test("buildStakeSuggestion:档位缺/概率缺=null 不给金额(诚实不兜底)", () => {
  assert.equal(buildStakeSuggestion(basePred({ selectionTier: null })), null);
  assert.equal(buildStakeSuggestion(basePred({ probabilities: {}, pick: null, handicapPick: null })), null);
});

test("stakeSummary:合计=各场之和,null 场不计入", () => {
  const sum = stakeSummary([{ stake: 200 }, null, { stake: 50 }]);
  assert.equal(sum.total, 250);
  assert.equal(sum.n, 2);
  assert.match(sum.note, /合计250元\/2场/);
});

const settledRow = (over = {}) => ({
  date: "2026-06-11", hit: true, actual: "主胜", actualScore: "2-0",
  scorePrimary: "2-0", handicapLine: -1, handicapWldCode: "3", handicapWld: "让球主胜",
  doubleChanceRecommended: true, doubleChanceCodes: ["3", "1"],
  ...over,
});

test("buildRecordLine:只算已结算行;让球按实际比分+线纯算术;双选=actual落在codes内;未结算=诚实空态", () => {
  // 2-0 让-1 → adj=1 → 让球主胜命中;比分命中;双选3∈[3,1]命中
  const r1 = buildRecordLine([settledRow(), { date: "2026-06-12", hit: null, actualScore: "" }], "2026-06-12");
  assert.equal(r1.settledN, 1);
  assert.match(r1.text, /胜负平1\/1·让球1\/1·比分1\/1·双选接住1\/1/);
  // 1-0 让-1 → adj=0 → 让平,推让球主胜=不中;比分2-0≠1-0不中;hit=false
  const r2 = buildRecordLine([settledRow({ hit: false, actual: "客胜", actualScore: "1-0" })], "2026-06-12");
  assert.match(r2.text, /胜负平0\/1·让球0\/1·比分0\/1/);
  // 全 pending → 空态文案,绝不出 0/0 假战绩
  const r3 = buildRecordLine([{ date: "2026-06-12", hit: null }], "2026-06-12");
  assert.equal(r3.settledN, 0);
  assert.match(r3.text, /暂无已结算场/);
  // 让球线缺=该行不进让球分母(不可判≠不中)
  const r4 = buildRecordLine([settledRow({ handicapLine: null })], "2026-06-12");
  assert.match(r4.text, /让球—/);
});

test("buildRecordLine:近7天窗口按业务日过滤,窗外已结算不计入近7天但保留最近结算日", () => {
  const rows = [settledRow({ date: "2026-06-01" }), settledRow({ date: "2026-06-11", hit: false, actual: "客胜", actualScore: "0-1" })];
  const r = buildRecordLine(rows, "2026-06-12");
  assert.equal(r.latest, "2026-06-11");
  assert.match(r.text, /近7天\(1场\)/);
});
