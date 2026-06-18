// T4 输出层单写者收敛守护测试(2026-06-10 缺陷#5#7#8#12#16#17#20):
//   ① 日期必传/合法:resolveDeliveryDate 非法 throw、缺省=本机UTC+8当日(跨日边界对);脚本层非法参数 exit 1;
//   ② banner 真计数:各赔种分子=真实填充实数(ouFilled 等),降级显著标⚠️不打✅(#8#12);
//   ③ 审计背书:adversarial/<date>.json 缺 → 绝不写"已审计"背书句、证伪列标⚠️未跑(#17,绝不编造审计声明);
//   ④ 三面一致:同一 rows 连出两个日期,xlsx 标题行/手机页/英文页三处日期逐字段一致且互不串日期(#16)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  resolveDeliveryDate, buildOddsFillCounts, buildDegradeNote, buildOddsCoverageLine,
  buildCoverageSubtitle,
  buildAuditFoot, advCellText, buildXlsxSheets, XLSX_HEADERS, renderMobileHtml, renderEnglishHtml,
  resolveHtmlWriteTarget,
} from "../src/today-delivery-lib.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

// ── ① 日期解析 ──
test("resolveDeliveryDate:显式合法日期原样返回", () => {
  assert.equal(resolveDeliveryDate("2026-06-10"), "2026-06-10");
});

test("resolveDeliveryDate:非法日期 fail-loud throw(绝不猜)", () => {
  for (const bad of ["06-10-2026", "20260610", "2026/06/10", "昨天", "2026-6-1"]) {
    assert.throws(() => resolveDeliveryDate(bad), /日期参数非法/);
  }
});

test("resolveDeliveryDate:缺参=本机UTC+8当日(含跨日边界)", () => {
  // UTC 2026-06-10 20:00+08 = 当日
  assert.equal(resolveDeliveryDate(undefined, new Date("2026-06-10T20:00:00+08:00")), "2026-06-10");
  // UTC 17:30 = 北京时间次日 01:30 —— 必须翻日(双重+8h时区坑的反向守护)
  assert.equal(resolveDeliveryDate(undefined, new Date("2026-06-10T17:30:00Z")), "2026-06-11");
});

test("today-full-coverage 脚本:非法日期参数 exit 1 不出表", () => {
  const r = spawnSync(process.execPath, [join(rootDir, "scripts", "today-full-coverage.mjs"), "06-10-2026", "--jconly"], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /日期参数非法/);
});

// ── mock rows(渲染所需全字段;2场:1场各盘全有✅、1场大小球/比分/亚盘缺⚠️) ──
const mkRow = (i, over) => ({
  idx: i, ko: "06-10 23:00", comp: "国际赛", match: `主队${i} vs 客队${i}`,
  wld: "主胜(60%) 平(22%) 客胜(18%)", handicap: "让-1 主胜",
  hcView: "让-1 ‖ 模型:主队过盘55% ‖ 市场de-vig:主队过盘52%",
  hcP: { line: "让-1", model: `主队${i}-1过盘55% · 走盘20% · 客队${i}+1过盘25%`, market: `主队${i}过盘52% · 走盘21% · 客队${i}+1过盘27%`, diverge: false },
  score: "2-0(18%)", scoreSrc: "✅500真盘", halffull: "主胜-主胜(45%)", hfSrc: "✅500真盘",
  euro: "1.5/3.8/6.0 ✅500欧赔", hc: "让-1 1.9/3.5/3.6 ✅500让球", asian: "让-1 主0.95/客0.85 ✅ESPN/DraftKings",
  ouReal: "大2.5球 大58%/小42% ✅500总进球", dist: "2球30% 3球25%",
  scoreMkt: "2-0@6.5 1-0@7.0 ✅500比分", hfMkt: "胜胜@2.1 ✅500半全场",
  homeRec: `主队${i} 3胜1平1负·进8失3`, awayRec: `客队${i} 1胜2平2负·进4失7`,
  homeLast5: "胜2-0(主ABC)", awayLast5: "负0-2(客XYZ)",
  h2h: "2025-10-10 主队2-1(胜)", profile: "主队 场均进1.6失0.6 / 客队 场均进0.8失1.4",
  conf: 72, tier: "二档", drawRate: 0.22, drawAlert: null, adv: null,
  ...over,
});
const fullRow = mkRow(1);
const degradedRow = mkRow(2, {
  ouReal: "⚠️未取到", scoreMkt: "⚠️未取到", asian: "⚠️未取到(亚盘源降级,无免费源)", dist: "",
});
const rows2 = [fullRow, degradedRow];

// ── ② banner 真计数 + 降级标注 ──
test("buildOddsFillCounts:各赔种分子=真实填充实数(大小球真用上 ouFilled)", () => {
  const c = buildOddsFillCounts(rows2);
  assert.equal(c.total, 2);
  assert.equal(c.euro, 2);
  assert.equal(c.handicap, 2);
  assert.equal(c.score, 1);   // 第2场比分盘⚠️缺
  assert.equal(c.halffull, 2);
  assert.equal(c.ou, 1);      // 第2场大小球⚠️缺 → 分子必须是1不是2
  assert.equal(c.asian, 1);
  const line = buildOddsCoverageLine(c);
  assert.match(line, /大小球1\/2/);
  assert.match(line, /比分1\/2/);
  assert.match(line, /欧赔2\/2/);
});

test("buildDegradeNote:市场输入降级显著标⚠️、全满时为空(#12)", () => {
  const cFull = buildOddsFillCounts([fullRow]);
  assert.equal(buildDegradeNote(cFull, false), "");
  const note = buildDegradeNote(buildOddsFillCounts(rows2), false);
  assert.match(note, /⚠️市场输入降级/);
  assert.match(note, /大小球缺1场/);
  assert.match(note, /比分盘缺1场/);
  assert.match(note, /亚盘\(外盘\)缺1场/);
  // coverage 整层缺也要响
  assert.match(buildDegradeNote(cFull, true), /coverage缺/);
});

// ── ②b 手机页头条覆盖副标题(2026-06-10 审计确认缺陷:头条硬编码"5赔种全覆盖"假声明) ──
test("buildCoverageSubtitle:5赔种全满才许写'全覆盖'(带 n/n 真计数)", () => {
  const sub = buildCoverageSubtitle(buildOddsFillCounts([fullRow]));
  assert.equal(sub, "5赔种全覆盖(1/1真计数核验)");
});

test("buildCoverageSubtitle:任一赔种有缺口 → 禁出'全覆盖'字样,改逐赔种实数", () => {
  const sub = buildCoverageSubtitle(buildOddsFillCounts(rows2));
  assert.doesNotMatch(sub, /全覆盖/);
  assert.equal(sub, "欧赔2/2·让球2/2·比分1/2·半全场2/2·大小球1/2");
});

test("buildCoverageSubtitle:counts 缺/非法 → fail-loud throw(绝不默认自吹全覆盖)", () => {
  for (const bad of [undefined, null, {}, { total: 0 }, { total: NaN }]) {
    assert.throws(() => buildCoverageSubtitle(bad), /counts 缺失\/非法/);
  }
});

test("renderMobileHtml:有赔种缺口 → 头条副标题=逐赔种实数、整页无'全覆盖';降级句进头条 risk 块", () => {
  const counts = buildOddsFillCounts(rows2);
  const degradeNote = buildDegradeNote(counts, false);
  const mobile = renderMobileHtml({ date: "2026-06-10", rows: rows2, riskNote: "", intlN: 2, wcN: 0, auditFoot: "", counts, degradeNote });
  assert.doesNotMatch(mobile, /全覆盖/);
  assert.match(mobile, /欧赔2\/2·让球2\/2·比分1\/2·半全场2\/2·大小球1\/2/);
  assert.match(mobile, /⚠️市场输入降级/);
  assert.match(mobile, /大小球缺1场/);
});

test("renderMobileHtml:5赔种全满 → 头条才写'全覆盖'且带真计数;缺 counts 直接 throw", () => {
  const counts = buildOddsFillCounts([fullRow]);
  const mobile = renderMobileHtml({ date: "2026-06-10", rows: [fullRow], riskNote: "", intlN: 1, wcN: 0, auditFoot: "", counts, degradeNote: "" });
  assert.match(mobile, /5赔种全覆盖\(1\/1真计数核验\)/);
  assert.throws(() => renderMobileHtml({ date: "2026-06-10", rows: rows2, riskNote: "", intlN: 2, wcN: 0, auditFoot: "" }), /counts 缺失\/非法/);
});

// ── ③ 审计背书动态生成(缺当日 adversarial 文件 → 不写"已审计"句) ──
test("buildAuditFoot:无 adversarial 当日文件 → 不写已审计背书、如实标未跑(#17)", () => {
  const foot = buildAuditFoot({ rows: rows2, advData: null });
  assert.doesNotMatch(foot, /已审计/);
  assert.doesNotMatch(foot, /已核/);
  assert.match(foot, /对抗证伪未跑/);
  // 让球线清单仍从本次 rows 真实派生(不硬编码历史队名)
  assert.match(foot, /主队1-1/);
});

test("buildAuditFoot:有 adversarial → 背书写真实审计场数", () => {
  const advRows = [mkRow(1, { adv: { label: "🔴证伪", ev: -0.05, kill: "负EV大热跟随" } }), mkRow(2)];
  const foot = buildAuditFoot({ rows: advRows, advData: { "主队1|客队1": {} } });
  assert.match(foot, /三视角对抗证伪已审计1\/2场/);
  assert.doesNotMatch(foot, /未跑/);
});

test("advCellText:缺当日审计文件 → 证伪列标⚠️未跑,绝不编造结论", () => {
  assert.match(advCellText(mkRow(1), false), /⚠️未跑/);
  assert.equal(advCellText(mkRow(1), true), "—(该场未审计)");
  assert.match(advCellText(mkRow(1, { adv: { label: "🔴证伪", ev: -0.05, kill: "负EV" } }), true), /🔴证伪 EV=-0.05/);
});

// ── ④ 三面日期一致(连出两个日期逐字段断言,互不串) ──
test("三面同源:xlsx标题/手机页/英文页日期一致,双日期互不污染(#16)", () => {
  const dates = ["2026-06-10", "2026-06-11"];
  const outputs = dates.map((date) => {
    const banner = `🔴 完整覆盖交付(${date}):测试banner`;
    const auditFoot = buildAuditFoot({ rows: rows2, advData: null });
    const sheets = buildXlsxSheets({ date, rows: rows2, banner, advDataPresent: false });
    const mobile = renderMobileHtml({ date, rows: rows2, riskNote: "", intlN: 2, wcN: 0, auditFoot, counts: buildOddsFillCounts(rows2), degradeNote: "" });
    const english = renderEnglishHtml({ date, rows: rows2, riskNote: "", intlN: 2, wcN: 0, banner, auditFoot });
    return { date, sheets, mobile, english };
  });
  for (const [i, o] of outputs.entries()) {
    const other = outputs[1 - i].date;
    // xlsx:标题行 + banner 行都是本日期;28列专业版列数不缩水(2026-06-18 +🎯综合研判列;2026-06-12 +💰建议注金列)
    assert.equal(o.sheets[0].rows[0][0], `⚡ 神选 · 竞彩完整覆盖 · ${o.date}`);
    assert.match(o.sheets[0].rows[1][0], new RegExp(o.date));
    assert.equal(XLSX_HEADERS.length, 28);
    assert.equal(o.sheets[0].rows[2].length, 28);
    assert.match(o.sheets[0].rows[2][26], /对抗证伪/);
    assert.match(o.sheets[0].rows[2][27], /综合研判/);
    assert.match(o.sheets[0].rows[2][5], /世界杯模型/);
    assert.match(o.sheets[0].rows[2][8], /真实裁决/);
    assert.match(o.sheets[0].rows[2][24], /建议注金/);
    assert.match(o.sheets[0].rows[2][25], /串关/);
    // 手机页:标题 + 下载链接 + 落款日期均=本日期
    assert.match(o.mobile, new RegExp(`<title>神选·竞彩·${o.date}</title>`));
    assert.match(o.mobile, new RegExp(`jingcai-${o.date}\\.xlsx`));
    assert.match(o.mobile, new RegExp(`真实端到端\\(${o.date}\\)`));
    // 英文固定URL页:标题=本日期
    assert.match(o.english, new RegExp(`⚡神选·足球·${o.date}`));
    assert.match(o.english, new RegExp(`jingcai-${o.date}\\.xlsx`));
    // 互不串日期(xlsx 串行化后整体检查)
    const all = JSON.stringify(o.sheets) + o.mobile + o.english;
    assert.ok(!all.includes(other), `${o.date} 的三面输出里混入了 ${other}`);
  }
});

// ── ⑤ 固定文件名防回退(并行交付保护):现页更新日期 → 重出旧日期写日期副本,绝不顶掉 ──
test("resolveHtmlWriteTarget:固定页已是更新日期 → 改写日期副本不顶掉", () => {
  const newer = renderMobileHtml({ date: "2026-06-11", rows: rows2, riskNote: "", intlN: 2, wcN: 0, auditFoot: "", counts: buildOddsFillCounts(rows2), degradeNote: "" });
  const r = resolveHtmlWriteTarget({
    existingHtml: newer, date: "2026-06-10",
    canonicalPath: "D:/Temp/webshare_lingdao/今日足球推荐.html",
    datedPath: "D:/Temp/webshare_lingdao/足球推荐-2026-06-10.html",
    dateRe: /神选·竞彩·(\d{4}-\d{2}-\d{2})/,
  });
  assert.equal(r.path, "D:/Temp/webshare_lingdao/足球推荐-2026-06-10.html");
  assert.equal(r.preservedNewer, "2026-06-11");
});

test("resolveHtmlWriteTarget:现页缺/无日期/同日期/更旧 → 照常写固定文件名", () => {
  const canonicalPath = "C", datedPath = "D", dateRe = /神选·竞彩·(\d{4}-\d{2}-\d{2})/;
  for (const existingHtml of [null, "", "无日期页面", "<title>神选·竞彩·2026-06-10</title>", "<title>神选·竞彩·2026-06-09</title>"]) {
    const r = resolveHtmlWriteTarget({ existingHtml, date: "2026-06-10", canonicalPath, datedPath, dateRe });
    assert.equal(r.path, "C", `existing=${JSON.stringify(existingHtml)} 应写固定文件名`);
    assert.equal(r.preservedNewer, null);
  }
});

// 手机页缺审计时不得自吹"已核"(旧硬编码"中-1/匈-2/阿-2+多agent审计已核"回归守护)
test("手机页/英文页:无当日审计 → 页脚不得出现历史写死背书", () => {
  const auditFoot = buildAuditFoot({ rows: rows2, advData: null });
  const mobile = renderMobileHtml({ date: "2026-06-10", rows: rows2, riskNote: "", intlN: 2, wcN: 0, auditFoot, counts: buildOddsFillCounts(rows2), degradeNote: "" });
  assert.doesNotMatch(mobile, /中-1\/匈-2\/阿-2/);
  assert.doesNotMatch(mobile, /多agent审计已核/);
  assert.match(mobile, /对抗证伪未跑/);
});
