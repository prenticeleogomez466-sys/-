// 缺陷#18(2026-06-10):①daily-with-fallback 成功出表必须投递微信(此前只有
// daily-evolution 的 marketCheck.ok 分支会投,fallback 出表日 outbox 停更);
// ②outbox 新鲜度健康检查(落后业务日 >1 天且已出新推荐表 → error 级显著告警)。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessOutboxFreshness } from "../src/wechat-channel.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("assessOutboxFreshness outbox 新鲜度", () => {
  it("滞后 0/1 天 = 健康(容忍一天合法无可推之盘)", () => {
    assert.equal(assessOutboxFreshness({ outboxDate: "2026-06-10", businessDate: "2026-06-10" }).ok, true);
    const lag1 = assessOutboxFreshness({ outboxDate: "2026-06-09", businessDate: "2026-06-10" });
    assert.equal(lag1.ok, true);
    assert.equal(lag1.lagDays, 1);
  });
  it("复现 06-10 实况:outbox 停在 06-08 而 06-10 已出推荐表 → error 级显著告警", () => {
    const out = assessOutboxFreshness({ outboxDate: "2026-06-08", businessDate: "2026-06-10", latestReportDate: "2026-06-10" });
    assert.equal(out.ok, false);
    assert.equal(out.level, "error");
    assert.equal(out.lagDays, 2);
    assert.match(out.detail, /停更/);
    assert.match(out.detail, /未投递/);
  });
  it("滞后 >1 天但期间确实没出过新表 → warning(连续无盘如实标注,不冤枉投递链)", () => {
    const out = assessOutboxFreshness({ outboxDate: "2026-06-08", businessDate: "2026-06-11", latestReportDate: "2026-06-08" });
    assert.equal(out.ok, false);
    assert.equal(out.level, "warning");
  });
  it("从未投递过 / 日期不可解析 → warning,不崩", () => {
    assert.equal(assessOutboxFreshness({}).ok, false);
    assert.equal(assessOutboxFreshness({ outboxDate: "垃圾", businessDate: "2026-06-10" }).level, "warning");
  });
  it("outbox payload 带时间戳(ISO)也能按日对齐", () => {
    const out = assessOutboxFreshness({ outboxDate: "2026-06-08T03:21:07Z", businessDate: "2026-06-10", latestReportDate: "2026-06-09" });
    assert.equal(out.level, "error");
    assert.equal(out.lagDays, 2);
  });
});

describe("daily-with-fallback 投递接线回归守护(缺陷#18 防再犯)", () => {
  const source = readFileSync(join(rootDir, "scripts", "daily-with-fallback.mjs"), "utf8");
  it("脚本必须引入 deliverDailyReportToWechat", () => {
    assert.match(source, /deliverDailyReportToWechat/, "fallback 脚本必须接微信投递,缺陷#18 禁止回退");
  });
  it("fallback-500 分支与竞彩补救分支都必须投递(status.wechat 赋值 ≥2 处)", () => {
    const hits = source.match(/status\.wechat = await deliverWechatSafely\(pkg\)/g) ?? [];
    assert.ok(hits.length >= 2, `两条成功出表路径都要投递,当前只有 ${hits.length} 处`);
  });
  it("投递失败不得掩盖/不得打崩已出表事实(deliverWechatSafely 含 try/catch)", () => {
    assert.match(source, /async function deliverWechatSafely[\s\S]*?catch/);
  });
});

describe("wechat 健康检查必须包含 outbox 新鲜度项", () => {
  it("buildWechatChannelHealth 源码接入 assessOutboxFreshness", () => {
    const channel = readFileSync(join(rootDir, "src", "wechat-channel.js"), "utf8");
    assert.match(channel, /name: "outbox 新鲜度"/);
    assert.match(channel, /assessOutboxFreshness\(\{ outboxDate/);
  });
});
