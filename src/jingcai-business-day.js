// 竞彩业务日工具(2026-05-30 新增)
// 背景:500/官方竞彩单按"周X编号"组织(周六001…周六015 = 当日竞彩单)。
//   兜底抓取时若不限业务日,会把次日(周日001…)与跨源重复(XML 的 6001… 与 Playwright 的 周六001 同场)
//   一并灌进当日 fixture,导致 34 场假象(实际官方 15 场)。本工具提供:
//     - jingcaiWeekdayLabel(date):YYYY-MM-DD → 周X(Asia/Shanghai)
//     - sequenceWeekdayPrefix(sequence):从竞彩编号取 周X 前缀(无前缀返回 null)
//   供 prediction-engine 限业务日+去重、recommendation-audit 实质校验共用。

import { canonicalTeamName } from "./team-aliases.js";

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function jingcaiWeekdayLabel(date) {
  if (!date) return null;
  const match = String(date).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  // 锚到上海中午,避免时区把日期推到前后一天
  const d = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAY_LABELS[d.getUTCDay()] ?? null;
}

export function sequenceWeekdayPrefix(sequence) {
  const m = String(sequence ?? "").match(/^周[一二三四五六日]/);
  return m ? m[0] : null;
}

// 把一批 fixture 收敛成"目标业务日的去重竞彩单":
//   1. 限业务日:丢掉竞彩编号 周X 前缀与目标日不符的场次(次日漏入当日);
//   2. 跨源去重:同一场(canonical 队名相同)只留一条,优先官方 周X 编号 over 数字兜底编号(如 6001),
//      Playwright 源再加权(信息更全);存在官方 周X 编号时整批丢数字编号(别名表对队名变体可能未归一,
//      纯 identityKey 去重会漏);
//   3. 14 场胜负彩(shengfucai)及其它一律原样保留。
// 落盘路径与预测读取路径共用此函数,保证"按业务日覆盖式落盘"与读取一致。
export function scopeJingcaiFixtures(date, fixtures) {
  const targetLabel = jingcaiWeekdayLabel(date);
  const jingcai = (fixtures ?? []).filter((f) => f.marketType === "jingcai");
  const others = (fixtures ?? []).filter((f) => f.marketType !== "jingcai");
  let scoped = jingcai.filter((f) => {
    const prefix = sequenceWeekdayPrefix(f.sequence);
    return !targetLabel || !prefix || prefix === targetLabel;
  });
  if (scoped.some((f) => sequenceWeekdayPrefix(f.sequence))) {
    scoped = scoped.filter((f) => sequenceWeekdayPrefix(f.sequence));
  }
  const byKey = new Map();
  for (const f of scoped) {
    const key = `${canonicalTeamName(f.homeTeam)}__${canonicalTeamName(f.awayTeam)}`;
    const existing = byKey.get(key);
    if (!existing || jingcaiFixturePreference(f) > jingcaiFixturePreference(existing)) byKey.set(key, f);
  }
  return [...others, ...byKey.values()];
}

function jingcaiFixturePreference(fixture) {
  let score = sequenceWeekdayPrefix(fixture.sequence) ? 2 : 1;
  if (String(fixture.source ?? "").includes("Playwright")) score += 0.25;
  return score;
}
