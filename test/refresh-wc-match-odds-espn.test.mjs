import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wcCanon, pairKey, parseScoreboardEvent, matchEventToFixture,
  scoreboardStamps, refreshDecision, maxDriftPct, selectSeedCandidates,
} from "../scripts/refresh-wc-match-odds-espn.mjs";

// ── wcCanon:ESPN displayName 与 groups.json 规范名的 4 个已知缺口必须闭合(2026-06-11 实测) ──
test("wcCanon 闭合 ESPN↔groups 队名缺口(South Korea/Bosnia/Cote d'Ivoire/Cabo Verde)", () => {
  assert.equal(wcCanon("South Korea"), wcCanon("Korea Republic"));
  assert.equal(wcCanon("Bosnia-Herzegovina"), wcCanon("Bosnia and Herzegovina"));
  assert.equal(wcCanon("Cote d'Ivoire"), wcCanon("Ivory Coast"));
  assert.equal(wcCanon("Cabo Verde"), wcCanon("Cape Verde"));
  // 既有 canonicalTeamName 已覆盖的不回归
  assert.equal(wcCanon("Türkiye"), wcCanon("Turkiye"));
  assert.equal(wcCanon("DR Congo"), wcCanon("刚果(金)"));
  assert.equal(wcCanon("USA"), wcCanon("United States"));
});

const mkEvent = (id, home, away, date) => ({
  id, date,
  competitions: [{ competitors: [
    { homeAway: "home", team: { displayName: home } },
    { homeAway: "away", team: { displayName: away } },
  ] }],
});

test("parseScoreboardEvent + matchEventToFixture:正向/反向(swap)/不匹配", () => {
  const fixtures = [
    { home: "Korea Republic", away: "Czechia", odds: { home: 2.598, draw: 3.1, away: 2.805 } },
    { home: "Mexico", away: "South Africa", odds: { home: 1.405, draw: 4.325, away: 8.125 } },
  ];
  const ev = parseScoreboardEvent(mkEvent("760414", "South Korea", "Czechia", "2026-06-12T02:00Z"));
  assert.equal(ev.eventId, "760414");
  const m = matchEventToFixture(ev, fixtures);
  assert.equal(m.fixture.home, "Korea Republic");
  assert.equal(m.swap, false);
  // ESPN 主客与我方相反 → swap=true
  const rev = matchEventToFixture(parseScoreboardEvent(mkEvent("x", "South Africa", "Mexico", "2026-06-11T19:00Z")), fixtures);
  assert.equal(rev.fixture.home, "Mexico");
  assert.equal(rev.swap, true);
  // 无关比赛不匹配
  assert.equal(matchEventToFixture(parseScoreboardEvent(mkEvent("y", "France", "Senegal", "")), fixtures), null);
  assert.equal(parseScoreboardEvent({ competitions: [] }), null);
});

test("scoreboardStamps:每个日期出当天+前一天(美东日分组兜底),去重排序,坏日期跳过", () => {
  assert.deepEqual(scoreboardStamps(["2026-06-12", "2026-06-11"]), ["20260610", "20260611", "20260612"]);
  assert.deepEqual(scoreboardStamps(["bogus"]), []);
});

// ── refreshDecision:核心三闸(无赔率不写/已开球不刷/常识闸拦错映射) ──
const FX = { home: "Mexico", away: "South Africa", odds: { home: 1.405, draw: 4.325, away: 8.125 }, collectedAt: "2026-06-10T16:22:24Z" };
const NOW = new Date("2026-06-11T00:30:00Z");
const passGate = () => null;

test("refreshDecision:开球前+有完整赔率+过闸 → refresh,entry 保留我方队名并带来源/事件号", () => {
  const ev = { eventId: "760415", dateIso: "2026-06-11T19:00Z" };
  const d = refreshDecision(FX, ev, { european: { home: 1.417, draw: 4.4, away: 8.5 }, provider: "DraftKings" }, { now: NOW, gate: passGate });
  assert.equal(d.action, "refresh");
  assert.equal(d.entry.home, "Mexico");
  assert.deepEqual(d.entry.odds, { home: 1.417, draw: 4.4, away: 8.5 });
  assert.equal(d.entry.espnEventId, "760415");
  assert.match(d.entry.source, /ESPN core odds \(DraftKings, event 760415\)/);
  assert.equal(d.entry.collectedAt, NOW.toISOString());
});

test("refreshDecision:core odds 缺三向 → skip 不臆造", () => {
  const d = refreshDecision(FX, { eventId: "1", dateIso: "2026-06-11T19:00Z" }, null, { now: NOW, gate: passGate });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /不臆造/);
});

test("refreshDecision:已开球 → skip(in-play 不混入赛前融合)", () => {
  const d = refreshDecision(FX, { eventId: "1", dateIso: "2026-06-10T19:00Z" },
    { european: { home: 1.5, draw: 4, away: 7 }, provider: "DK" }, { now: NOW, gate: passGate });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /已开球/);
});

test("refreshDecision:常识闸拦截 → skip 并带原因(F1 错映射防再犯)", () => {
  const d = refreshDecision(FX, { eventId: "1", dateIso: "2026-06-11T19:00Z" },
    { european: { home: 8, draw: 4, away: 1.4 }, provider: "DK" },
    { now: NOW, gate: () => "Elo差+180但弱队成热门" });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /常识闸拦截/);
});

test("maxDriftPct:三向取最大百分比漂移,无效腿忽略", () => {
  assert.equal(maxDriftPct({ home: 1.405, draw: 4.325, away: 8.125 }, { home: 1.417, draw: 4.4, away: 8.5 }), 4.6);
  assert.equal(maxDriftPct({ home: 2, draw: 3, away: 4 }, { home: 2, draw: 3, away: 4 }), 0);
  assert.equal(maxDriftPct(null, { home: 2, draw: 3, away: 4 }), 0);
});

// ── selectSeedCandidates(2026-06-20 discovery 缺口修):窗口内+未开球+不在已有 fixtures 才播种,去重 ──
test("selectSeedCandidates:只选窗口内·未开球·不在已有 fixtures 的场,带空格 dateUtc 可解析,去重", () => {
  const now = new Date("2026-06-19T16:00:00Z");
  const matchDate = {
    "1": { homeTeam: "Brazil", awayTeam: "Haiti", dateUtc: "2026-06-20 00:30:00Z" },        // 窗口内·未踢·不在已有 → 播种
    "2": { homeTeam: "Ecuador", awayTeam: "Curaçao", dateUtc: "2026-06-21 00:00:00Z" },      // 窗口内 → 播种
    "3": { homeTeam: "Mexico", awayTeam: "South Africa", dateUtc: "2026-06-20 01:00:00Z" },  // 已在已有 fixtures → 排除
    "4": { homeTeam: "Spain", awayTeam: "Brazil", dateUtc: "2026-06-25 00:00:00Z" },         // 窗口外(>48h)→ 排除
    "5": { homeTeam: "Iran", awayTeam: "New Zealand", dateUtc: "2026-06-19 10:00:00Z" },     // 已开球(早于 now)→ 排除
    "6": { homeTeam: "Brazil", awayTeam: "Haiti", dateUtc: "2026-06-20 00:30:00Z" },         // 与①同对阵 → 去重
  };
  const existing = new Set([pairKey("Mexico", "South Africa")]);
  const got = selectSeedCandidates(matchDate, existing, { now });
  const pairs = got.map((s) => pairKey(s.home, s.away)).sort();
  assert.deepEqual(pairs, [pairKey("Brazil", "Haiti"), pairKey("Ecuador", "Curaçao")].sort());
  assert.equal(got.length, 2, "应恰好2场(去重后),不含已有/窗口外/已开球");
  assert.ok(got.every((s) => s.localDate && /\d{4}-\d{2}-\d{2}/.test(s.localDate)), "localDate 应可被 scoreboard 扫描用");
});
