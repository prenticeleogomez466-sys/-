// 开赛时刻解析(2026-06-10 结算去毒,缺陷#1#2 共用)。
//
// 背景:fixture.kickoff 在不同来源下有三种形态——
//   ① "HH:mm"(当日时刻,日期取 fixture.date)
//   ② "YYYY-MM-DD"(只有日期,常见于世界杯赛程:业务日 06-07 的场实际 06-12 开赛)
//   ③ "YYYY-MM-DD HH:mm"(完整时刻)
// 旧 isKickoffFuture 只解析 "HH:mm" 并一律用 fixture.date 拼日期 → 形态②的未来场被当成
// "已过期可结算",叠加 backfill 单边锚定错配,造成 42 条未开赛世界杯场被热身赛假赛果结算。
//
// 铁律:不兜底——kickoff 无法解析出可信时刻时返回 null,调用方必须拒绝结算(宁 pending 勿假)。

/**
 * 解析 fixture 的开赛时刻(epoch ms,北京时间口径)。
 * - kickoff 内嵌日期(YYYY-MM-DD)优先于 fixture.date(世界杯赛程 kickoff 才是真比赛日);
 * - 只有日期没有时刻时取该日 23:59:59+08:00 —— 宁可晚判"已开赛"几小时,绝不提前放行结算;
 * - kickoff 为空/完全不可解析 → null(调用方 fail-loud,不得结算)。
 * @returns {number|null}
 */
export function kickoffEpochMs(fixture) {
  const kickoff = String(fixture?.kickoff ?? "").trim();
  if (!kickoff) return null; // kickoff 不存在 → 不可判定,绝不允许结算
  const embeddedDate = kickoff.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const date = embeddedDate ?? (String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null);
  if (!date) return null;
  const time = kickoff.match(/(\d{1,2}):(\d{2})/);
  const iso = time
    ? `${date}T${time[1].padStart(2, "0")}:${time[2]}:00+08:00`
    : `${date}T23:59:59+08:00`;
  const epoch = new Date(iso).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * 该场是否已开赛。kickoff 缺失/不可解析 → false(绝不结算未知时刻的场)。
 */
export function hasKickedOff(fixture, now = Date.now()) {
  const epoch = kickoffEpochMs(fixture);
  return epoch !== null && epoch <= now;
}

// ───────────────── 时区根修(缺陷#9#10,2026-06-10)─────────────────
// 旧 capture-closing-live 用 `Date.now() + (8*60 - getTimezoneOffset())*60000` 手算上海时间:
// 该式假设"机器是 UTC",在本机(已是 UTC+8,getTimezoneOffset()=-480)上变成双重 +8h →
// 17:16 打出明天日期、minsToKickoff 恒差 24h,上线以来 0 次真实捕获。
// 根修:一律 epoch 绝对时间算术 + Intl 显式 timeZone "Asia/Shanghai",与机器时区彻底解耦
// (UTC 机器与 UTC+8 机器结果逐位相同;上海无夏令时,偏移恒 +08:00)。

/**
 * 上海(北京时间)业务日 YYYY-MM-DD。纯 epoch 输入 + Intl 显式时区,机器时区无关。
 * @param {number} nowMs    epoch 毫秒(默认当前)
 * @param {number} offsetDays 业务日偏移(-1=昨天)。上海无 DST,按 86400000ms/天精确。
 */
export function shanghaiDateOf(nowMs = Date.now(), offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(nowMs + offsetDays * 86400000));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

/** ISO 日期加减天数(UTC 算术,无时区歧义)。无效输入原样返回。 */
export function isoAddDays(isoDate, days) {
  const m = String(isoDate ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(isoDate ?? "");
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

/**
 * 严格开赛时刻(epoch ms):必须有显式 HH:mm 才返回,只有日期 → null。
 * 供临场捕获用——23:59 兜底对结算安全(宁晚判),对"临场窗口"是毒(会在错误时刻假捕获),
 * 铁律:拿不到真实开球时刻就如实返回 null,调用方标⚠️跳过。
 */
export function kickoffEpochMsStrict(fixture) {
  const kickoff = String(fixture?.kickoff ?? "").trim();
  if (!kickoff) return null;
  const time = kickoff.match(/(\d{1,2}):(\d{2})/);
  if (!time) return null;
  const embeddedDate = kickoff.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const date = embeddedDate ?? (String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null);
  if (!date) return null;
  const epoch = new Date(`${date}T${time[1].padStart(2, "0")}:${time[2]}:00+08:00`).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * 距开赛分钟数(可负=已开赛)。kickoff 无显式 HH:mm → null(调用方跳过,不猜)。
 * 纯 epoch 差,UTC 机器与 UTC+8 机器结果相同。
 */
export function minutesToKickoff(fixture, nowMs = Date.now()) {
  const epoch = kickoffEpochMsStrict(fixture);
  if (epoch === null) return null;
  return (epoch - nowMs) / 60000;
}

/**
 * 从 500 jczq DOM 开赛单元格("MM-DD HH:mm")提取 HH:mm,供 fixtures 摄入链补开球时刻。
 * 防错配:DOM 的 MM-DD 必须与 XML 赛日(YYYY-MM-DD)一致才采信;带日期但不一致/无法解析 → null
 * (如实留空,绝不拿可疑时间冒充)。
 */
/**
 * 在 DOM __kickoffs__ 映射({"主队|客队": "MM-DD HH:mm"})里查某场的开球单元格。
 * 500 jczq DOM 会截断长队名(哥斯达黎加→哥斯达)→ 精确复合键会漏;容错规则:
 * 主/客名前缀互含(截断方向不定)且**全表唯一**才采信,有歧义宁可返回 null(绝不猜场)。
 */
export function domKickoffCellFor(map, home, away) {
  if (!map || typeof map !== "object") return null;
  const h = String(home ?? "").trim();
  const a = String(away ?? "").trim();
  if (!h || !a) return null;
  const exact = map[`${h}|${a}`];
  if (exact != null && exact !== "") return exact;
  const affine = (x, y) => x && y && x.length >= 2 && y.length >= 2 && (x.startsWith(y) || y.startsWith(x));
  const hits = [];
  for (const [key, cell] of Object.entries(map)) {
    const [dh, da] = String(key).split("|");
    if (affine(dh, h) && affine(da, a)) hits.push(cell);
  }
  return hits.length === 1 ? hits[0] : null; // 0=没有;≥2=歧义,都不猜
}

/**
 * 沿用本店先前已捕获的开球时刻(HH:mm)——开球时刻不降级(T5,2026-06-10)。
 * 背景:DOM 抓取偶发 net::ERR_TIMED_OUT(同晚实测 2 次里挂 1 次)。ingest 重写 fixtures 时若
 * DOM 失败,旧逻辑把已捕获 HH:mm 的场降级回"只有日期" → 当晚临场收盘捕获全灭。
 * 这是保留先前同场真实捕获值,不是兜底猜测:匹配键=编号+主客队全同,且先前 kickoff 内嵌赛日
 * 与本次 XML 赛日一致才沿用(赛日改期 → 旧时刻不可信,弃);从无捕获 → null,如实留日期。
 * 调用方必须把本函数排在 XML matchtime / DOM 新鲜值之后(拿到新时刻一律以新为准)。
 */
export function preservedKickoffTime(prevFixtures, { sequence, home, away, date } = {}) {
  const seq = String(sequence ?? "").trim();
  const h = String(home ?? "").trim();
  const a = String(away ?? "").trim();
  const d = String(date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  if (!seq || !h || !a || !d) return null;
  for (const f of Array.isArray(prevFixtures) ? prevFixtures : []) {
    if (String(f?.sequence ?? "").trim() !== seq) continue;
    if (String(f?.homeTeam ?? "").trim() !== h || String(f?.awayTeam ?? "").trim() !== a) continue;
    const m = String(f?.kickoff ?? "").trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    if (!m) continue;          // 先前也没有时刻 → 无可沿用
    if (m[1] !== d) continue;  // 赛日改期 → 绝不拿旧时刻冒充
    return m[2];
  }
  return null;
}

export function kickoffTimeFromDomCell(xmlDate, domCell) {
  const cell = String(domCell ?? "").trim();
  if (!cell) return null;
  const time = cell.match(/(\d{1,2}):(\d{2})/);
  if (!time) return null;
  const hhmm = `${time[1].padStart(2, "0")}:${time[2]}`;
  const md = cell.match(/(\d{2})-(\d{2})/);
  if (md) {
    const xmlMd = String(xmlDate ?? "").match(/\d{4}-(\d{2}-\d{2})/)?.[1] ?? null;
    if (!xmlMd || `${md[1]}-${md[2]}` !== xmlMd) return null; // 日期不一致 = 可能错场,弃用
  }
  return hhmm;
}

/**
 * 该场的"真实比赛日"(YYYY-MM-DD):kickoff 内嵌日期优先,否则 fixture.date。
 * 供跨源对阵匹配做 ±N 天日期约束(同名对阵的世界杯小组赛 vs 热身赛不得视为同一场)。
 * @returns {string|null}
 */
export function fixtureMatchDate(fixture) {
  const kickoff = String(fixture?.kickoff ?? "").trim();
  const embedded = kickoff.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (embedded) return embedded;
  return String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

/**
 * 两个 fixture 的真实比赛日相差是否 ≤ maxDays 天。
 * 任一方解析不出日期时返回 true(不引入新的误杀,只在双方都有日期时收紧)。
 */
export function withinDays(left, right, maxDays = 2) {
  const ld = fixtureMatchDate(left);
  const rd = fixtureMatchDate(right);
  if (!ld || !rd) return true;
  const lt = Date.parse(`${ld}T00:00:00Z`);
  const rt = Date.parse(`${rd}T00:00:00Z`);
  if (!Number.isFinite(lt) || !Number.isFinite(rt)) return true;
  return Math.abs(lt - rt) <= maxDays * 86400000;
}
