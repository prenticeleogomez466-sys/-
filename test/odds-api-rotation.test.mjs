// 缺陷#11(2026-06-10):The Odds API 免费层配额治理 —— 多免费 key 轮换 / 世界杯窗口市场分级 /
// 401 优雅降级(主链不再 0x1,外盘缺失如实标注,绝不编数据)。
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listOddsApiKeys,
  isWorldCupWindow,
  oddsApiMarketsForDate,
  oddsApiSportsForDate,
  fetchOddsApiRotating
} from "../src/odds-api-rotation.js";

const res = (status, body = "", headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => body,
  json: async () => JSON.parse(body || "null")
});

describe("listOddsApiKeys 多免费 key 读取", () => {
  it("单 key", () => {
    assert.deepEqual(listOddsApiKeys({ ODDS_API_KEY: "aaa" }), ["aaa"]);
  });
  it("ODDS_API_KEYS 逗号/分号列表 + 编号槽位 + 去重保序", () => {
    const env = { ODDS_API_KEY: "k1", ODDS_API_KEYS: "k2,k3;k1", ODDS_API_KEY_2: "k4", ODDS_API_KEY_9: "k5" };
    assert.deepEqual(listOddsApiKeys(env), ["k1", "k2", "k3", "k4", "k5"]);
  });
  it("全空 → []", () => {
    assert.deepEqual(listOddsApiKeys({}), []);
  });
});

describe("世界杯窗口市场/sport 分级(省配额)", () => {
  it("窗口判定:2026-06-11 ~ 2026-07-19", () => {
    assert.equal(isWorldCupWindow("2026-06-10"), false);
    assert.equal(isWorldCupWindow("2026-06-11"), true);
    assert.equal(isWorldCupWindow("2026-07-19"), true);
    assert.equal(isWorldCupWindow("2026-07-20"), false);
    assert.equal(isWorldCupWindow("乱输入"), false);
  });
  it("窗口内只拉 h2h,totals;窗口外 h2h,spreads;ODDS_API_MARKETS 显式优先", () => {
    assert.equal(oddsApiMarketsForDate("2026-06-15", {}), "h2h,totals");
    assert.equal(oddsApiMarketsForDate("2026-05-01", {}), "h2h,spreads");
    assert.equal(oddsApiMarketsForDate("2026-06-15", { ODDS_API_MARKETS: "h2h" }), "h2h");
  });
  it("窗口内默认只拉世界杯一个 sport(调用 7→1);窗口外保持俱乐部列表;env 显式优先", () => {
    assert.deepEqual(oddsApiSportsForDate("2026-06-15", {}), ["soccer_fifa_world_cup"]);
    assert.ok(oddsApiSportsForDate("2026-05-01", {}).includes("soccer_epl"));
    assert.ok(oddsApiSportsForDate("2026-05-01", {}).length >= 5);
    assert.deepEqual(oddsApiSportsForDate("2026-06-15", { ODDS_API_SPORTS: "soccer_epl, soccer_fifa_world_cup" }), ["soccer_epl", "soccer_fifa_world_cup"]);
  });
});

describe("fetchOddsApiRotating 轮换语义", () => {
  it("第一个 key 401 → 自动切第二个 key 成功,带配额头", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return String(url).includes("apiKey=bad") ? res(401, "quota exceeded") : res(200, "[]", { "x-requests-remaining": "123", "x-requests-used": "377" });
    };
    const out = await fetchOddsApiRotating((key) => `https://x.test/odds?apiKey=${key}`, { fetch: fetchImpl, env: { ODDS_API_KEY: "bad", ODDS_API_KEY_2: "good" } });
    assert.equal(out.ok, true);
    assert.equal(out.keyIndex, 1);
    assert.equal(out.remaining, "123");
    assert.equal(calls.length, 2);
    assert.equal(out.attempts.length, 1);
    assert.equal(out.attempts[0].status, 401);
  });
  it("429 同样轮换", async () => {
    const fetchImpl = async (url) => (String(url).includes("apiKey=k1") ? res(429, "rate limited") : res(200, "[]"));
    const out = await fetchOddsApiRotating((key) => `https://x.test/?apiKey=${key}`, { fetch: fetchImpl, env: { ODDS_API_KEYS: "k1,k2" } });
    assert.equal(out.ok, true);
    assert.equal(out.keyIndex, 1);
  });
  it("全部 key 401 → quotaExhausted,error 写明外盘缺失/不编数据", async () => {
    const out = await fetchOddsApiRotating(() => "https://x.test/", { fetch: async () => res(401, "out of quota"), env: { ODDS_API_KEYS: "k1,k2,k3" } });
    assert.equal(out.ok, false);
    assert.equal(out.quotaExhausted, true);
    assert.equal(out.attempts.length, 3);
    assert.match(out.error, /配额耗尽/);
    assert.match(out.error, /绝不编数据/);
  });
  it("非配额错误(422)不轮换,直接失败(换 key 无意义不白烧)", async () => {
    let calls = 0;
    const out = await fetchOddsApiRotating(() => "https://x.test/", { fetch: async () => { calls++; return res(422, "unknown sport"); }, env: { ODDS_API_KEYS: "k1,k2" } });
    assert.equal(out.ok, false);
    assert.equal(out.quotaExhausted, undefined);
    assert.equal(out.status, 422);
    assert.equal(calls, 1);
  });
  it("无 key → noKey 提示如何免费配多 key", async () => {
    const out = await fetchOddsApiRotating(() => "https://x.test/", { fetch: async () => res(200, "[]"), env: {} });
    assert.equal(out.ok, false);
    assert.equal(out.noKey, true);
    assert.match(out.error, /ODDS_API_KEYS/);
  });
  it("网络错误与 key 无关 → 不轮换直接失败", async () => {
    let calls = 0;
    const out = await fetchOddsApiRotating(() => "https://x.test/", { fetch: async () => { calls++; throw new Error("ETIMEDOUT"); }, env: { ODDS_API_KEYS: "k1,k2" } });
    assert.equal(out.ok, false);
    assert.equal(calls, 1);
    assert.match(out.error, /网络错误/);
  });
});

describe("crawlMarketData:Odds API 401 优雅降级(主链不再 0x1)", () => {
  let dataDir, exportDir;
  const saved = {};
  const setEnv = (key, value) => { saved[key] = process.env[key]; process.env[key] = value; };
  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "fm-data-"));
    exportDir = mkdtempSync(join(tmpdir(), "fm-export-"));
    setEnv("FOOTBALL_DATA_DIR", dataDir);
    setEnv("FOOTBALL_EXPORT_DIR", exportDir);
    setEnv("ODDS_API_KEY", "exhausted-key");
    // 其余源全关,只测 The Odds API 分支的降级语义。
    for (const key of ["ODDS_API_IO_KEY", "API_FOOTBALL_KEY", "ODDS_JSON_URL", "ODDS_CSV_URL"]) { saved[key] = process.env[key]; delete process.env[key]; }
    for (const key of ["SINA_SFC_ODDS_ENABLED", "ODDS1X2_ODDS_ENABLED", "SGODDS_ODDS_ENABLED", "BETEXPLORER_ODDS_ENABLED", "LIAOGOU_ODDS_ENABLED", "FIVEHUNDRED_JC_ASIAN_ENABLED", "FIVEHUNDRED_SFC_ASIAN_ENABLED", "NOWSCORE_ODDS_ENABLED", "CUBEGOAL_ODDS_ENABLED", "ESPN_ODDS_ENABLED", "ODDS_STABILITY_CACHE_ENABLED", "ODDS_INCOMPLETE_RESCUE_ENABLED"]) setEnv(key, "0");
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  });
  it("配额 401 不抛、不崩主链,sources 如实标注外盘缺失", async () => {
    const { crawlMarketData } = await import("../src/odds-crawler.js");
    const result = await crawlMarketData("2099-01-01", { fetch: async () => res(401, "quota exceeded") });
    const oddsApi = result.sources.find((source) => source.name === "The Odds API");
    assert.ok(oddsApi, "必须记录 The Odds API 源条目");
    assert.equal(oddsApi.ok, false);
    assert.match(oddsApi.error, /外盘缺失/);
    assert.equal(oddsApi.fetched, 0);
  });
});
