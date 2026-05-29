import assert from "node:assert/strict";
import test from "node:test";
import { probeFreeSources, SOURCES } from "../src/free-source-probe.js";

// 按 URL 路由的 mock fetch:FPL 有伤停、ESPN injuries 空、Understat 反爬
function routedFetch(url) {
  const u = String(url);
  if (u.includes("bootstrap-static")) {
    return { ok: true, json: async () => ({ elements: [{ status: "i" }, { status: "a" }, { status: "d" }] }) };
  }
  if (u.includes("/injuries")) return { ok: true, json: async () => ({ injuries: [] }) };
  if (u.includes("scoreboard")) return { ok: true, json: async () => ({ events: [{}, {}] }) };
  if (u.includes("openligadb")) return { ok: true, json: async () => [{}, {}, {}] };
  if (u.includes("thesportsdb")) return { ok: true, json: async () => ({ events: [{}] }) };
  if (u.includes("understat")) return { ok: true, text: async () => "<html>no embedded data</html>" };
  return { ok: false, status: 404 };
}

test("probeFreeSources 正确分类 usable/empty/blocked", async () => {
  const res = await probeFreeSources({ fetch: async (url) => routedFetch(url) });
  const byName = Object.fromEntries(res.results.map((r) => [r.name, r]));
  assert.equal(byName["FPL bootstrap-static"].status, "usable");
  assert.equal(byName["ESPN injuries (eng.1)"].status, "empty");
  assert.equal(byName["Understat (EPL xG)"].status, "blocked");
  assert.ok(res.usableCount >= 1);
});

test("probeFreeSources 网络异常单源降级为 error,不整体崩溃", async () => {
  const res = await probeFreeSources({ fetch: async () => { throw new Error("network down"); } });
  assert.equal(res.usableCount, 0);
  assert.ok(res.results.every((r) => r.status === "error"));
  assert.equal(res.results.length, SOURCES.length);
});
