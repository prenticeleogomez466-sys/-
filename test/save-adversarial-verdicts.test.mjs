import { test } from "node:test";
import assert from "node:assert/strict";
import { voteLabel, matchToKey, toDeliveryFormat } from "../scripts/save-adversarial-verdicts.mjs";

// 对抗证伪 workflow产出 → 交付消费端格式 转换守护(2026-06-18 永久化,杜绝手工转出错=返厂)。

test("voteLabel:0/1票不含'证伪'二字,2/3票才含(消费端 advKilled /证伪/ 只圈2+票)", () => {
  assert.ok(!/证伪/.test(voteLabel(0)), "0票=稳健,不得含证伪");
  assert.ok(!/证伪/.test(voteLabel(1)), "1票=存疑,不得含证伪(否则单视角被误判killed)");
  assert.ok(/证伪/.test(voteLabel(2)), "2票必须含证伪");
  assert.ok(/证伪/.test(voteLabel(3)), "3票必须含证伪");
});

test("matchToKey:'主 vs 客' → '主|客';只切第一个 vs;队名含空格安全", () => {
  assert.equal(matchToKey("葡萄牙 vs 刚果(金)"), "葡萄牙|刚果(金)");
  assert.equal(matchToKey("AC奥卢 vs 玛丽港"), "AC奥卢|玛丽港");
  // 极端:客队名里也含 " vs "(理论上不会,但守护只切首个)
  assert.equal(matchToKey("A vs B vs C"), "A|B vs C");
  // 2026-06-18 加固:workflow 实测用 " 对 " 分隔,必须也切对
  assert.equal(matchToKey("AC奥卢 对 玛丽港"), "AC奥卢|玛丽港");
  assert.equal(matchToKey("巴西 对 海地"), "巴西|海地");
  // 已是键名(含"|")→ 幂等原样返回
  assert.equal(matchToKey("瑞士|波黑"), "瑞士|波黑");
});

test("toDeliveryFormat:rows → verdicts 按 主|客 键,字段齐全", () => {
  const wf = {
    summary: { date: "2026-06-18", totalForDate: 2, clean: 1, oneVote: 0, twoVote: 1, threeVote: 0 },
    rows: [
      { match: "瑞士 vs 波黑", competition: "世界杯", direction: "主胜", prob: 0.62, confidence: 70, risk: "中", modelTier: "一档", ev: -0.03, refuteVotes: 2, maxSeverity: 2, lensVerdicts: ["[市场效率] ✗ 逆市", "[样本过拟合] ✗ 薄样本", "[回测一致] ✓ ok"] },
      { match: "AC奥卢 vs 玛丽港", competition: "芬兰超级联赛", direction: "主胜", prob: 0.55, confidence: 60, risk: "低", modelTier: "二档", ev: 0.01, refuteVotes: 0, maxSeverity: 0, lensVerdicts: ["[市场效率] ✓", "[样本过拟合] ✓", "[回测一致] ✓"] },
    ],
  };
  const out = toDeliveryFormat(wf);
  assert.equal(out.date, "2026-06-18");
  assert.equal(out.totalVerdicts, 2);
  const v = out.verdicts["瑞士|波黑"];
  assert.ok(v, "瑞士|波黑 键必须在");
  assert.ok(/证伪/.test(v.label), "2票应含证伪标签");
  assert.equal(v.refuteVotes, 2);
  assert.equal(v.ev, -0.03);
  assert.equal(v.competition, "世界杯");
  assert.ok(v.kill.includes("市场效率"), "kill 应含三视角理由");
  // clean 注不含证伪,消费端不会误杀
  assert.ok(!/证伪/.test(out.verdicts["AC奥卢|玛丽港"].label));
});

test("ev 非有限 → null(守 no-fallback,不编 0)", () => {
  const wf = { summary: { date: "2026-06-18" }, rows: [{ match: "A vs B", refuteVotes: 1, lensVerdicts: [] }] };
  const out = toDeliveryFormat(wf);
  assert.equal(out.verdicts["A|B"].ev, null);
});

test("缺 rows 数组 → fail-loud throw(绝不写空文件冒充已证伪)", () => {
  assert.throws(() => toDeliveryFormat({ summary: {} }), /缺 rows/);
  assert.throws(() => toDeliveryFormat(null), /缺 rows/);
});
