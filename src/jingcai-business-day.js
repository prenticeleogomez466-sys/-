// 竞彩业务日工具(2026-05-30 新增)
// 背景:500/官方竞彩单按"周X编号"组织(周六001…周六015 = 当日竞彩单)。
//   兜底抓取时若不限业务日,会把次日(周日001…)与跨源重复(XML 的 6001… 与 Playwright 的 周六001 同场)
//   一并灌进当日 fixture,导致 34 场假象(实际官方 15 场)。本工具提供:
//     - jingcaiWeekdayLabel(date):YYYY-MM-DD → 周X(Asia/Shanghai)
//     - sequenceWeekdayPrefix(sequence):从竞彩编号取 周X 前缀(无前缀返回 null)
//   供 prediction-engine 限业务日+去重、recommendation-audit 实质校验共用。

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
