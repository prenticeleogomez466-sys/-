import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMorningRecapTrigger, readJson } from "../src/recap-automation-health.js";

describe("recap 健康检查·上午11点窗口触发匹配(isMorningRecapTrigger)", () => {
  it("11:00 整点 → true", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T11:00:00+08:00"]), true);
  });

  it("11:10(实际加固后任务时间)→ true(旧逻辑死磕 T11:00 会误判 false → 整条 recap 假失败)", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T11:10:00+08:00"]), true);
  });

  it("11:15(失败重试/分钟级重排)→ true", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T11:15:00+08:00"]), true);
  });

  it("非数组单值也兼容", () => {
    assert.equal(isMorningRecapTrigger("2026-06-05T11:10:00+08:00"), true);
  });

  it("不在 11 点窗口(10:59 / 12:00)→ false", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T10:59:00+08:00"]), false);
    assert.equal(isMorningRecapTrigger(["2026-06-05T12:00:00+08:00"]), false);
  });

  it("多触发只要有一个在窗口内 → true", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T03:00:00+08:00", "2026-06-05T11:10:00+08:00"]), true);
  });

  it("空/无效输入 → false(不臆断)", () => {
    assert.equal(isMorningRecapTrigger([]), false);
    assert.equal(isMorningRecapTrigger(null), false);
  });
});

describe("readJson 容 UTF-8 BOM(PS Set-Content 历史遗留 BOM 不再让摘要静默丢失)", () => {
  it("带 BOM 的 json 仍能解析出内容(旧逻辑 JSON.parse(utf8) 会抛→null)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recap-bom-"));
    const p = join(dir, "automation-recap-latest.json");
    try {
      writeFileSync(p, "﻿" + JSON.stringify({ ok: false, date: "2026-06-04", failed: 1, total: 8 }), "utf8");
      const j = readJson(p);
      assert.ok(j, "带 BOM 的文件应能读出对象,而非 null");
      assert.equal(j.date, "2026-06-04");
      assert.equal(j.failed, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无 BOM 的 json 正常解析", () => {
    const dir = mkdtempSync(join(tmpdir(), "recap-nobom-"));
    const p = join(dir, "x.json");
    try {
      writeFileSync(p, JSON.stringify({ ok: true }), "utf8");
      assert.equal(readJson(p).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不存在的文件 → null", () => {
    assert.equal(readJson(join(tmpdir(), "no-such-recap-file-zzz.json")), null);
  });
});
