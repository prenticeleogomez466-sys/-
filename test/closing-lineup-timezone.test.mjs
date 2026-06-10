// 缺陷#9#10#15 时区根修回归测试(2026-06-10)。
// 背景:capture-closing-live 旧代码按"机器=UTC"手算 +8h,本机已是 UTC+8 → 双重 +8h:
//   17:16 打出明天日期、minsToKickoff 恒差 24h,上线以来 0 次真实捕获;
//   lineup-watch 用 UTC 日历日 + 单业务日文件,跨午夜场永远盯不到;ESPN 按日历日查询双重漏。
// 这里全部用固定 epoch 断言:实现走"epoch 绝对时间 + Intl 显式 Asia/Shanghai",
//   在 UTC 机器与 UTC+8 机器上结果逐位相同(epoch 算术与机器时区无关)。
import test from "node:test";
import assert from "node:assert/strict";
import {
  shanghaiDateOf, isoAddDays, kickoffEpochMsStrict, minutesToKickoff, kickoffTimeFromDomCell, domKickoffCellFor, preservedKickoffTime
} from "../src/kickoff-time.js";
import { nextCaptureState, assessCaptureHealth } from "../src/closing-capture-health.js";
import { mergeFixtureLists, stableFixtureKey } from "../src/fixture-store.js";
import { computeLineupWatch, espnDateWindow, fetchEspnLineupsForFixtures } from "../src/lineup-source.js";

// ───────────── 时区数学:固定 epoch,机器时区无关 ─────────────

test("shanghaiDateOf: 北京 17:16 必须还是今天(旧 bug 双重+8h 打出明天)", () => {
  // 2026-06-10 17:16 北京时间 = 2026-06-10 09:16 UTC
  const epoch = Date.UTC(2026, 5, 10, 9, 16);
  assert.equal(shanghaiDateOf(epoch), "2026-06-10");
  // 旧 bug:机器已是 UTC+8 时再 +8h → 01:16 次日 → "2026-06-11"。绝不允许回归。
  assert.notEqual(shanghaiDateOf(epoch), "2026-06-11");
});

test("shanghaiDateOf: 跨午夜与业务日偏移", () => {
  // 北京 2026-06-11 00:30 = UTC 2026-06-10 16:30 → 上海业务日已是 06-11
  const epoch = Date.UTC(2026, 5, 10, 16, 30);
  assert.equal(shanghaiDateOf(epoch), "2026-06-11");
  assert.equal(shanghaiDateOf(epoch, -1), "2026-06-10"); // 昨天业务日
  // 北京 23:59 仍是当天
  assert.equal(shanghaiDateOf(Date.UTC(2026, 5, 10, 15, 59)), "2026-06-10");
});

test("isoAddDays: 跨月跨年", () => {
  assert.equal(isoAddDays("2026-06-01", -1), "2026-05-31");
  assert.equal(isoAddDays("2026-01-01", -1), "2025-12-31");
  assert.equal(isoAddDays("2026-06-10", 1), "2026-06-11");
});

test("kickoffEpochMsStrict: epoch 是绝对时刻(显式 +08:00,与机器时区无关)", () => {
  const f = { date: "2026-06-10", kickoff: "2026-06-10 19:00" };
  // 19:00+08:00 == 11:00 UTC —— 纯 epoch 断言,UTC 机器与 UTC+8 机器同值
  assert.equal(kickoffEpochMsStrict(f), Date.UTC(2026, 5, 10, 11, 0));
});

test("kickoffEpochMsStrict: 只有日期(无 HH:mm)→ null,绝不猜 23:59 兜底", () => {
  assert.equal(kickoffEpochMsStrict({ date: "2026-06-10", kickoff: "2026-06-12" }), null);
  assert.equal(kickoffEpochMsStrict({ date: "2026-06-10", kickoff: "" }), null);
  assert.equal(kickoffEpochMsStrict({ date: "2026-06-10" }), null);
});

test("minutesToKickoff: 本机 UTC+8 下 17:16 距 19:00 开球 = 104 分钟(旧 bug 差 24h)", () => {
  const now = Date.UTC(2026, 5, 10, 9, 16); // 北京 17:16
  const f = { date: "2026-06-10", kickoff: "2026-06-10 19:00" };
  const mins = minutesToKickoff(f, now);
  assert.equal(mins, 104);
  // 旧 bug 在 UTC+8 机器上算出 104 - 1440 = -1336(恒差 24h,临场窗口永不命中)
  assert.ok(Math.abs(mins - 104) < 1, `不得有 ±24h 偏移,实际=${mins}`);
});

test("minutesToKickoff: 世界杯跨午夜凌晨场(kickoff 内嵌真实赛日)", () => {
  // 业务日 06-10 文件里的 06-11 02:00 场;现在北京 06-11 01:40(= UTC 06-10 17:40)→ 还有 20 分钟
  const f = { date: "2026-06-10", kickoff: "2026-06-11 02:00" };
  assert.equal(minutesToKickoff(f, Date.UTC(2026, 5, 10, 17, 40)), 20);
});

test("minutesToKickoff: 无 HH:mm → null(capture 打⚠️跳过,不崩不猜)", () => {
  assert.equal(minutesToKickoff({ date: "2026-06-10", kickoff: "2026-06-12" }, Date.UTC(2026, 5, 10, 9, 0)), null);
});

// ───────────── DOM 开球时刻提取(fixtures 摄入链补 HH:mm)─────────────

test("kickoffTimeFromDomCell: DOM MM-DD 与 XML 赛日一致才采信", () => {
  assert.equal(kickoffTimeFromDomCell("2026-06-12", "06-12 03:00"), "03:00");
  assert.equal(kickoffTimeFromDomCell("2026-06-12", "06-11 22:00"), null); // 日期不一致=可能错场
  assert.equal(kickoffTimeFromDomCell("2026-06-12", ""), null);
  assert.equal(kickoffTimeFromDomCell("2026-06-12", null), null);
  assert.equal(kickoffTimeFromDomCell("2026-06-12", "周四001"), null); // 无时间的垃圾
  assert.equal(kickoffTimeFromDomCell("2026-06-12", "3:05"), "03:05"); // 无日期纯时刻可采,补零
});

test("domKickoffCellFor: 500 DOM 截断长队名(哥斯达黎加→哥斯达)→ 唯一前缀互含才采信", () => {
  const map = { "英格兰|哥斯达": "06-11 04:00", "墨西哥|南非": "06-12 03:00" };
  assert.equal(domKickoffCellFor(map, "英格兰", "哥斯达黎加"), "06-11 04:00"); // 截断容错
  assert.equal(domKickoffCellFor(map, "墨西哥", "南非"), "06-12 03:00");       // 精确命中
  assert.equal(domKickoffCellFor(map, "英格兰", "克罗地亚"), null);             // 不同对手不得错配
  // 精确复合键优先(同 06-09 让球线防碰撞思路)
  const amb = { "阿根廷|冰岛": "06-10 02:00", "阿根廷|冰岛二队": "06-10 06:00" };
  assert.equal(domKickoffCellFor(amb, "阿根廷", "冰岛"), "06-10 02:00");
  // 歧义(无精确键,两候选客队前缀都互含)→ null,绝不猜场
  const amb2 = { "阿根廷|冰岛队A": "06-10 02:00", "阿根廷|冰岛队B": "06-10 06:00" };
  assert.equal(domKickoffCellFor(amb2, "阿根廷", "冰岛"), null);
  assert.equal(domKickoffCellFor(null, "a", "b"), null);
});

// ───────────── 开球时刻不降级(T5:DOM 偶发超时不得抹掉已捕获 HH:mm)─────────────

test("preservedKickoffTime: DOM 失败轮沿用本店同场(编号+主客+赛日全同)先前捕获的 HH:mm", () => {
  const prev = [
    { sequence: "4001", homeTeam: "墨西哥", awayTeam: "南非", source: "500.com-jczq-fallback", kickoff: "2026-06-12 03:00" },
    { sequence: "3201", homeTeam: "葡萄牙", awayTeam: "尼日利亚", source: "500.com-jczq-fallback", kickoff: "2026-06-11 03:45" }
  ];
  assert.equal(preservedKickoffTime(prev, { sequence: "4001", home: "墨西哥", away: "南非", date: "2026-06-12" }), "03:00");
  assert.equal(preservedKickoffTime(prev, { sequence: "3201", home: "葡萄牙", away: "尼日利亚", date: "2026-06-11" }), "03:45");
});

test("preservedKickoffTime: 赛日改期/对阵不同/先前无时刻 → null,绝不拿旧时刻冒充", () => {
  const prev = [
    { sequence: "4001", homeTeam: "墨西哥", awayTeam: "南非", kickoff: "2026-06-12 03:00" },
    { sequence: "4002", homeTeam: "韩国", awayTeam: "捷克", kickoff: "2026-06-12" } // 先前也只有日期
  ];
  // 赛日改期(XML 新赛日 06-13 ≠ 先前捕获 06-12)→ 旧时刻不可信
  assert.equal(preservedKickoffTime(prev, { sequence: "4001", home: "墨西哥", away: "南非", date: "2026-06-13" }), null);
  // 同编号不同对阵(编号复用)→ 不得错配
  assert.equal(preservedKickoffTime(prev, { sequence: "4001", home: "巴西", away: "摩洛哥", date: "2026-06-12" }), null);
  // 先前就没有 HH:mm → 无可沿用
  assert.equal(preservedKickoffTime(prev, { sequence: "4002", home: "韩国", away: "捷克", date: "2026-06-12" }), null);
  // 防御:空/缺参
  assert.equal(preservedKickoffTime(null, { sequence: "4001", home: "墨西哥", away: "南非", date: "2026-06-12" }), null);
  assert.equal(preservedKickoffTime(prev, {}), null);
  assert.equal(preservedKickoffTime(prev), null);
});

// ───────────── 连续24h零捕获红灯 ─────────────

test("capture健康: 24h 内有捕获 → 绿", () => {
  const t0 = Date.UTC(2026, 5, 10, 0, 0);
  let s = nextCaptureState(null, { eligibleCount: 3, frozenCount: 3, nowMs: t0 });
  const h = assessCaptureHealth(s, t0 + 10 * 3600000);
  assert.equal(h.red, false);
});

test("capture健康: 超24h零捕获且期间有应捕获场次 → 红", () => {
  const t0 = Date.UTC(2026, 5, 10, 0, 0);
  let s = nextCaptureState(null, { eligibleCount: 2, frozenCount: 2, nowMs: t0 });       // 最后一次真实捕获
  s = nextCaptureState(s, { eligibleCount: 4, frozenCount: 0, nowMs: t0 + 20 * 3600000 }); // 之后只有应捕获、零捕获
  const h = assessCaptureHealth(s, t0 + 25 * 3600000);
  assert.equal(h.red, true, h.reason);
});

test("capture健康: 超24h但期间无应捕获场次(休赛日)→ 不误报", () => {
  const t0 = Date.UTC(2026, 5, 10, 0, 0);
  let s = nextCaptureState(null, { eligibleCount: 1, frozenCount: 1, nowMs: t0 });
  s = nextCaptureState(s, { eligibleCount: 0, frozenCount: 0, nowMs: t0 + 30 * 3600000 }); // 休赛,无临场场次
  const h = assessCaptureHealth(s, t0 + 30 * 3600000);
  assert.equal(h.red, false, h.reason);
});

test("capture健康: 从未捕获过(状态新建)→ 满24h+有应捕获即红", () => {
  const t0 = Date.UTC(2026, 5, 10, 0, 0);
  let s = nextCaptureState(null, { eligibleCount: 2, frozenCount: 0, nowMs: t0 });
  assert.equal(assessCaptureHealth(s, t0 + 1 * 3600000).red, false); // 刚建,未满24h
  s = nextCaptureState(s, { eligibleCount: 2, frozenCount: 0, nowMs: t0 + 25 * 3600000 });
  assert.equal(assessCaptureHealth(s, t0 + 25 * 3600000).red, true);
});

// ───────────── 双业务日 fixtures 合并(跨午夜盯防)─────────────

test("mergeFixtureLists: 同场跨业务日文件 id 不同,按稳定键(真实赛日+主客)去重", () => {
  const today = [
    { id: "jc500-2026-06-10-4001-墨西哥-南非", date: "2026-06-10", kickoff: "2026-06-12 03:00", homeTeam: "墨西哥", awayTeam: "南非" },
    { id: "jc500-2026-06-10-3201-葡萄牙-尼日利亚", date: "2026-06-10", kickoff: "2026-06-11 02:00", homeTeam: "葡萄牙", awayTeam: "尼日利亚" }
  ];
  const yesterday = [
    { id: "jc-2026-06-09-4001-墨西哥-南非", date: "2026-06-09", kickoff: "2026-06-12 03:00", homeTeam: "墨西哥", awayTeam: "南非" }, // 同场,不同 id
    { id: "jc-2026-06-09-2201-中国-泰国", date: "2026-06-09", kickoff: "2026-06-09 19:00", homeTeam: "中国", awayTeam: "泰国" }      // 昨日独有
  ];
  const merged = mergeFixtureLists(today, yesterday);
  assert.equal(merged.length, 3);
  // 重复场保留今天文件版本(调用方把新业务日放前)
  assert.ok(merged.some((f) => f.id === "jc500-2026-06-10-4001-墨西哥-南非"));
  assert.ok(!merged.some((f) => f.id === "jc-2026-06-09-4001-墨西哥-南非"));
  assert.ok(merged.some((f) => f.homeTeam === "中国")); // 昨日独有的场被合并盯到
});

test("stableFixtureKey: kickoff 内嵌真实赛日优先于业务日", () => {
  const a = { date: "2026-06-09", kickoff: "2026-06-12 03:00", homeTeam: "墨西哥", awayTeam: "南非" };
  const b = { date: "2026-06-10", kickoff: "2026-06-12 03:00", homeTeam: "墨西哥", awayTeam: "南非" };
  assert.equal(stableFixtureKey(a), stableFixtureKey(b));
});

// ───────────── 首发去重跨业务日 ─────────────

test("computeLineupWatch: 昨天业务日已上报的场今天再次出现不重复触发(extraSeenDates)", () => {
  const state = { "2026-06-09": ["2026-06-12|墨西哥|南非"] };
  const ids = ["2026-06-12|墨西哥|南非", "2026-06-11|葡萄牙|尼日利亚"];
  const r = computeLineupWatch(state, "2026-06-10", ids, { extraSeenDates: ["2026-06-09"] });
  assert.deepEqual(r.fresh, ["2026-06-11|葡萄牙|尼日利亚"]); // 昨天报过的不再 fresh
  assert.equal(r.shouldTrigger, true);
  // 昨天键不被改写,今天键只记今天新增
  assert.deepEqual(r.nextState["2026-06-09"], ["2026-06-12|墨西哥|南非"]);
  assert.deepEqual(r.nextState["2026-06-10"], ["2026-06-11|葡萄牙|尼日利亚"]);
});

test("computeLineupWatch: 不带 extraSeenDates 保持旧行为(向后兼容)", () => {
  const state = { "2026-06-10": ["a"] };
  const r = computeLineupWatch(state, "2026-06-10", ["a", "b"]);
  assert.deepEqual(r.fresh, ["b"]);
});

// ───────────── ESPN 跨 UTC 日扩窗 ─────────────

test("espnDateWindow: 日历日 ±1 天(北京凌晨场按 UTC 落前一天,单日查询必漏)", () => {
  assert.deepEqual(espnDateWindow("2026-06-10"), ["20260609", "20260610", "20260611"]);
  assert.deepEqual(espnDateWindow("2026-06-01"), ["20260531", "20260601", "20260602"]); // 跨月
  assert.deepEqual(espnDateWindow("2026-06-10", 0), ["20260610"]);
});

test("fetchEspnLineupsForFixtures: 事件在 UTC 前一天也能匹配到首发(±1 天合并+去重)", async () => {
  // 北京 2026-06-11 02:00 开球 = UTC 2026-06-10 18:00 → ESPN scoreboard 挂在 20260610;
  // 业务日若为 06-11,只查 20260611 必漏 —— 扩窗后必须命中。
  const fixture = { id: "fx-1", homeTeam: "TeamAlpha", awayTeam: "TeamBeta" };
  const event = {
    id: "evt-9",
    competitions: [{ competitors: [
      { homeAway: "home", team: { displayName: "TeamAlpha" } },
      { homeAway: "away", team: { displayName: "TeamBeta" } }
    ] }]
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/scoreboard?dates=")) {
      const d = url.match(/dates=(\d{8})/)[1];
      // 事件只挂在 20260610(UTC 日),20260611/20260612 返回空
      return { ok: true, json: async () => ({ events: d === "20260610" ? [event] : [] }) };
    }
    if (url.includes("summary?event=evt-9")) {
      const roster = (team) => ({
        homeAway: team === "TeamAlpha" ? "home" : "away",
        team: { displayName: team },
        formation: "4-3-3",
        roster: Array.from({ length: 11 }, (_, i) => ({ starter: true, athlete: { displayName: `${team}-${i}` }, position: { abbreviation: "M" } }))
      });
      return { ok: true, json: async () => ({ rosters: [roster("TeamAlpha"), roster("TeamBeta")] }) };
    }
    return { ok: false, status: 404 };
  };
  const res = await fetchEspnLineupsForFixtures("2026-06-11", [fixture], { fetch: fetchImpl, leagues: ["usa.1"] });
  assert.equal(res.count, 1);
  assert.ok(res.fixtureData["fx-1"], "UTC 前一天的事件必须被匹配到");
  assert.equal(res.fixtureData["fx-1"].providerEventId, "evt-9");
  // scoreboard 查了 3 个日参(±1 天)
  const sbDates = calls.filter((u) => u.includes("/scoreboard?")).map((u) => u.match(/dates=(\d{8})/)[1]).sort();
  assert.deepEqual(sbDates, ["20260610", "20260611", "20260612"]);
});
