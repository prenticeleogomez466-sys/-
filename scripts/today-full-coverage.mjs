// 今日"完整覆盖"竞彩交付 —— 输出层唯一出口(2026-06-10 单写者收敛,缺陷#5#7#8#12#16#17#20)。
// 三面同源:xlsx(20列专业版,桌面+稳定子文件夹)+ 手机页(今日足球推荐.html)+ 英文固定URL页(football.html),
// 渲染统一走 src/today-delivery-lib.js;所有旁路写者已改薄壳转发本脚本,绝不再各写各的。
// 用户铁律 2026-06-09:必须把所有赔率/数据补齐覆盖后再生成,关于一场比赛所有数据内容和赔率情况。
//   · 模型层(不改):胜负平/让胜负平/比分/半全场/信心  ← buildDailyRecommendationPackage(真钱管线)
//   · 补全层(只读真实抓取缓存,绝不造假):
//       大小球 = The Odds API totals de-vig;近5场/H2H/攻防画像 = ESPN 跨league真实战绩(coverage 缓存)
// 数据源单一:coverage = D:/football-model-data/coverage/<date>.json(由 fetch-match-coverage.mjs 产)。
import {
  buildDailyRecommendationPackage,
  simpleWldCell, simpleHandicapCell, simpleScoreCell, simpleHalfFullCell,
} from "../src/daily-report.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import {
  resolveDeliveryDate, buildOddsFillCounts, buildDegradeNote, buildOddsCoverageLine,
  buildAuditFoot, buildXlsxSheets, renderMobileHtml, renderEnglishHtml, resolveHtmlWriteTarget,
} from "../src/today-delivery-lib.js";
import { writeFileSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { worldCupContextLine } from "../src/worldcup-context.js";

// 日期:必传合法 YYYY-MM-DD 或缺省=本机 UTC+8 当日;非法 fail-loud 退出(缺陷#20:绝不再默认写死历史日期)。
let date;
try {
  date = resolveDeliveryDate(process.argv.slice(2).find((a) => !a.startsWith("--")));
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
// dry-run 沙箱(F2 验证用):设 TODAY_FULL_OUT_DIR 时产物全落该目录,不碰桌面/webshare 正式目录。
const outBase = process.env.TODAY_FULL_OUT_DIR || null;
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
// 修2026-06-10(审计rank2):coverage 文件缺失不再 crash——补全列诚实标"⚠️未补全(coverage缺)"继续出表。
let cov = null;
try { cov = JSON.parse(readFileSync(`D:/football-model-data/coverage/${date}.json`, "utf8")); }
catch (e) { console.log(`⚠️ coverage缺:D:/football-model-data/coverage/${date}.json 读取失败(${e.code ?? e.message})——近5/H2H/亚盘/欧赔补全列将标"⚠️未补全(coverage缺)"继续出表;可先跑 node scripts/fetch-match-coverage.mjs ${date} 再重出。`); }
const COV_MISS = "⚠️未补全(coverage缺)";
// 对抗证伪层(football-signal-verify 产,只标注不弃赛;无当日文件则该列如实标⚠️未跑、背书句不写——绝不编造审计声明)
let advData = null;
try { advData = JSON.parse(readFileSync(`D:/football-model-data/adversarial/${date}.json`, "utf8")).verdicts || null; } catch { advData = null; }
const advFor = (p) => advData?.[`${p.fixture.homeTeam}|${p.fixture.awayTeam}`] ?? null;

// 竞彩交付 = 竞彩在售(marketType=jingcai)+ 世界杯场(14场/预售,store 标 marketType=shengfucai)。
// 修2026-06-10(审计rank2+13):废 WC_SINGLES 硬编码4场——世界杯场从当日 fixtures store 动态判定
//   (competition 含"世界杯";store 里世界杯场多为 shengfucai,旧 isJc 闸 + 硬名单会全漏新场次)。
// --jconly 语义改(2026-06-10 起,开赛期间):竞彩在售场=含世界杯单场,不再剔除世界杯
//   (旧"剔除预售世界杯"语义只适用 6/9 预售期,6/11 开赛后按旧语义会把主菜全删)。
const isJc = (p) => p.fixture?.marketType === "jingcai";
const isWorldCupGame = (p) => String(p.fixture?.competition ?? "").includes("世界杯");
const JC_ONLY = process.argv.includes("--jconly");
if (JC_ONLY) console.log("--jconly(2026-06-10 新语义):竞彩在售场含世界杯单场,开赛期间不再剔除世界杯。");
const picked = preds.filter((p) => isJc(p) || isWorldCupGame(p));
const byMatch = new Map();
for (const p of picked) {
  const key = `${p.fixture.homeTeam}|${p.fixture.awayTeam}`;
  const prev = byMatch.get(key);
  if (!prev || (isJc(p) && !isJc(prev))) byMatch.set(key, p);
}
const games = [...byMatch.values()].sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));

// coverage 按主队中文名匹配(coverage 缺/未抓到该场 → null,补全列诚实标缺)
const covFor = (p) => cov?.matches?.find((m) => (p.fixture.homeTeam || "").includes(m.home.zh) && (p.fixture.awayTeam || "").includes(m.away.zh)) ?? null;

const ko = (p) => { const k = p.fixture?.kickoff; return k && /\d{2}:\d{2}/.test(k) ? k.slice(5, 16) : (k?.slice(5, 10) ?? ""); };
const isWc = isWorldCupGame; // 动态判定(2026-06-10,替代旧 WC_SINGLES 硬名单)
const compTag = (p) => (isWc(p) ? "世界杯·单场" : (p.fixture.competition || "国际赛"));

// 补全层渲染(全真实,缺标缺)
const recStr = (side) => side.record5?.n ? `${side.record5.w}胜${side.record5.d}平${side.record5.l}负·进${side.record5.gf}失${side.record5.ga}` : "❌未取到";
// 比分一律本队视角 gf-ga(胜必然 X>Y,避免"主-客"朝向出现"胜1-2"自相矛盾)+ 对手简称
const last5Str = (side) => side.last5?.length ? side.last5.map((x) => `${x.res}${x.gf}-${x.ga}(${x.homeAway === "home" ? "主" : "客"}${x.oppAbbr})`).join(" ") : "";
// H2H 从当前主队视角 gf-ga(h2h=主队历史筛对手,gf/ga 即主队)
const h2hStr = (c) => c?.h2h?.length ? c.h2h.map((x) => `${x.date} ${c.home.zh}${x.gf}-${x.ga}(${x.res})`).join(" / ") : "近赛季窗口无交锋(ESPN免费源限近赛季)";
const profileStr = (c) => {
  if (!c) return "❌未取到";
  const ap = (s) => s.record5?.n ? `场均进${(s.record5.gf / s.record5.n).toFixed(1)}失${(s.record5.ga / s.record5.n).toFixed(1)}` : "近5缺";
  return `${c.home.zh} ${ap(c.home)} / ${c.away.zh} ${ap(c.away)};真xG缺(FBref·Cloudflare墙)`;
};

// ── 真实赔率提取(全从 500 快照,5赔种;有=✅500真盘 缺=⚠️标缺,绝不用模型冒充市场) ──
const trip = (o) => o ? `${o.home}/${o.draw}/${o.away}` : null;
const euroStr = (s, eo) => { const e = s.europeanOdds; if (e && e.current) { const cur = trip(e.current), ini = trip(e.initial); return `${cur}${ini && ini !== cur ? `(初${ini})` : ""} ✅500欧赔`; } if (eo?.ml) return `竞彩未开售;ESPN/${eo.provider} ${eo.ml.home}/${eo.ml.draw}/${eo.ml.away} ✅`; return "⚠️未开售(竞彩只卖让球)"; };
const hcStr = (p, s) => { const line = s.jingcaiHandicap?.line ?? p.handicapPick?.line; const h = s.handicapOdds; if (!h || !h.current) return `让${line}(赔率⚠️缺)`; const cur = trip(h.current), ini = trip(h.initial); return `让${line} ${cur}${ini && ini !== cur ? `(初${ini})` : ""} ✅500让球`; };
const ouRealStr = (s) => { const t = s.totalGoalsOdds; if (!t || t.over25 == null) return "⚠️未取到"; return `大2.5球 大${Math.round(t.over25 * 100)}%/小${Math.round(t.under25 * 100)}% ✅500总进球`; };
const distStr = (s) => { const d = s.totalGoalsOdds?.dist; if (!d) return ""; return Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, pp]) => `${g}球${Math.round(pp * 100)}%`).join(" "); };
const scoreMktStr = (s) => { const t = s.scoreOdds?.top; return t?.length ? t.slice(0, 5).map((x) => `${x.score}@${x.odds}`).join(" ") + " ✅500比分" : "⚠️未取到"; };
const hfMktStr = (s) => { const t = s.halfFullOdds?.top; return t?.length ? t.slice(0, 4).map((x) => `${x.halfFull}@${x.odds}`).join(" ") + " ✅500半全场" : "⚠️未取到"; };
const asianStr = (eo) => eo?.asian?.line != null
  ? `让${eo.asian.line} 主${eo.asian.homeOdds}/客${eo.asian.awayOdds}${eo.asian.openLine && eo.asian.openLine !== eo.asian.line ? `(开${eo.asian.openLine}→异动)` : ""} ✅${eo.source}`
  : "⚠️未取到(亚盘源降级,无免费源)";
// 透明让球视图:模型过盘 + 市场de-vig 两套数(带队名),分歧大按铁律标"市场更准·谨慎"。
// 修2026-06-09:旧 simpleHandicapCell 头条用市场de-vig却配模型"把握"标签,阿根廷出"40%·把握低"与模型67%自相矛盾。
const hcParts = (p, s) => {
  const line = s.jingcaiHandicap?.line ?? p.handicapPick?.line;
  const home = p.fixture.homeTeam, away = p.fixture.awayTeam, absL = Math.abs(line);
  const cb = p.handicapPick?.coverBreakdown || {};
  const hc = s.handicapOdds?.current;
  const model = cb.home != null
    ? `${home}${line}过盘${Math.round(cb.home * 100)}% · 走盘${Math.round(cb.push * 100)}% · ${away}+${absL}过盘${Math.round(cb.away * 100)}%`
    : "缺";
  let market = "缺", mkHome = null;
  if (hc) { const ss = 1 / hc.home + 1 / hc.draw + 1 / hc.away; mkHome = (1 / hc.home) / ss; market = `${home}过盘${Math.round((1 / hc.home) / ss * 100)}% · 走盘${Math.round((1 / hc.draw) / ss * 100)}% · ${away}+${absL}过盘${Math.round((1 / hc.away) / ss * 100)}%`; }
  const diverge = (cb.home != null && mkHome != null && Math.abs(cb.home - mkHome) > 0.15);
  return { line: `让${line}`, model, market, diverge };
};
const hcViewStr = (p, s) => { const h = hcParts(p, s); return `${h.line} ‖ 模型:${h.model} ‖ 市场de-vig:${h.market}${h.diverge ? " ⚠️模型与市场分歧大(市场更准·谨慎)" : ""}`; };

const rows = games.map((p, i) => {
  const c = covFor(p);
  const s = p.marketSnapshot || {};
  const scoreMkt = !!(s.scoreOdds?.top?.length), hfMkt = !!(s.halfFullOdds?.top?.length);
  return {
    idx: i + 1, ko: ko(p), comp: compTag(p),
    match: `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
    // 模型方向概率(🔶,由500真盘de-vig+DC推得)
    wld: simpleWldCell(p), handicap: simpleHandicapCell(p), hcView: hcViewStr(p, s), hcP: hcParts(p, s),
    score: simpleScoreCell(p), halffull: simpleHalfFullCell(p),
    scoreSrc: scoreMkt ? "✅500真盘" : "🔶DC", hfSrc: hfMkt ? "✅500真盘" : "🔶DC",
    // 真实赔率(✅500实测 + ESPN/DraftKings亚盘/欧赔补;coverage 缺 → 诚实标缺不编)
    euro: (s.europeanOdds?.current || cov) ? euroStr(s, c?.espnOdds) : COV_MISS,
    asian: cov ? asianStr(c?.espnOdds) : COV_MISS, hc: hcStr(p, s),
    ouReal: ouRealStr(s), dist: distStr(s),
    scoreMkt: scoreMktStr(s), hfMkt: hfMktStr(s),
    // ESPN 补全(coverage 文件缺 → ⚠️未补全;文件在但该场没抓到 → ❌未取到)
    homeRec: c ? `${c.home.zh} ${recStr(c.home)}` : (cov ? "❌未取到" : COV_MISS),
    awayRec: c ? `${c.away.zh} ${recStr(c.away)}` : (cov ? "❌未取到" : COV_MISS),
    homeLast5: c ? last5Str(c.home) : "", awayLast5: c ? last5Str(c.away) : "",
    h2h: c ? h2hStr(c) : (cov ? "❌未取到" : COV_MISS),
    profile: c ? profileStr(c) : (cov ? "❌未取到" : COV_MISS),
    conf: p.confidence, tier: p.selectionTier?.label ?? "",
    // 🏆赛会行(2026-06-10 自检②回补:单写者收敛时丢了 wcLine——世界杯场带超算 出线/夺冠%;
    //   非世界杯/无超算json → ""自动休眠,数据源=exports/worldcup-supercomputer.json 真实超算产物)
    wcLine: isWc(p) ? worldCupContextLine(p.fixture.homeTeam, p.fixture.awayTeam, p.fixture.competition) : "",
    // 情景研判一行(自检⑥:scenario-synthesizer 现成 headline,逐场不同,不重算不编造)
    scen: p.scenario?.headline ?? "",
    // 平局画像(2026-06-10 审计rank13:读现成 scenario.dims.draw / experienceContext 字段,不重算;
    //   世界杯场 experienceContext 落全局经验26%不报警,scenario 情景层才有本场平局维度)
    drawRate: p.scenario?.dims?.draw?.prob ?? p.experienceContext?.historicalDrawRate ?? null,
    drawAlert: p.experienceContext?.drawAlert
      ?? ((Number(p.scenario?.dims?.draw?.prob) >= 0.28 && p.pick?.code !== "1") ? (p.scenario.dims.draw.note ?? "平局风险偏高") : null),
    adv: advFor(p),
  };
});

// ── banner / note 派生(真实数据) ──
const wcN = rows.filter((r) => /世界杯/.test(r.comp)).length, intlN = rows.length - wcN;
const coinRows = rows.filter((r) => /硬币/.test(r.tier));
const handicapOnly = rows.filter((r) => /未开售/.test(r.wld));
let riskNote = "";
if (coinRows.length) riskNote += `最高风险=${coinRows.map((r) => r.match).join("/")}(硬币档·势均易平),强烈建议不单押。`;
if (handicapOnly.length) riskNote += `${handicapOnly.map((r) => r.match.split(" vs ")[0]).join("/")}=悬殊盘只卖让球,信心反映"赢球方向"非"让球过盘",勿当胆。`;
// 平局画像提示(2026-06-10 审计rank13):drawAlert=现成字段(experienceContext.drawAlert 或
//   scenario.dims.draw 平局≥28%且主推非平),只拼提示不重算。
const drawHeavy = rows.filter((r) => r.drawAlert);
if (drawHeavy.length) riskNote += `平局画像风险:${drawHeavy.map((r) => `${r.match}(平${Number.isFinite(r.drawRate) ? Math.round(r.drawRate * 100) + "%" : "⚠️缺"})`).join("/")} 平局维度偏高,主推非平建议双选兼顾。`;
const advKilled = rows.filter((r) => r.adv && /证伪/.test(r.adv.label));
if (advKilled.length) riskNote += `🔴三视角对抗证伪:${advKilled.length}/${rows.length}场被一致证伪(EV全负·模型本质市场跟随器无独立edge),点开看每场致命点;证伪只标注不替你弃赛,买不买你定。`;
// 缺陷#8修(2026-06-10):banner 分子=各赔种真实填充实数(欧赔/让球/比分/半全场/大小球/亚盘逐项),
//   绝不写"n/n 全覆盖";任一赔种降级即 banner 显著⚠️(缺陷#12)。
const counts = buildOddsFillCounts(rows);
const degradeNote = buildDegradeNote(counts, !cov);
const covNote = cov ? "近5场/H2H/攻防=ESPN真实战绩" : `近5场/H2H/攻防=⚠️未补全(coverage缺,先跑 fetch-match-coverage)`;
const BANNER = `🔴 完整覆盖交付(${date}):${rows.length}场=${intlN}国际赛+${wcN}世界杯单场。赔率覆盖(逐赔种实数):${buildOddsCoverageLine(counts)};${covNote}。${degradeNote}真缺口:国家队真xG(FBref Cloudflare墙)、老H2H(ESPN限近赛季),已⚠️标不编。${riskNote}模型概率由真盘de-vig派生,1X2系统打不过收盘线、本质市场跟随器,买不买你定。`;
// 审计背书(缺陷#17修):全部从本次 rows + adversarial/<date>.json 动态生成;无当日审计文件 → 不写"已审计"背书句。
const auditFoot = buildAuditFoot({ rows, advData });

// ── xlsx(20列专业版,经 xlsx-writer:深紫FF4A148C表头/banner跨列合并/内容感知行高/冻结筛选) ──
const sheets = buildXlsxSheets({ date, rows, banner: BANNER, advDataPresent: !!(advData && Object.keys(advData).length) });
if (outBase) mkdirSync(outBase, { recursive: true });
const xlsxTarget = outBase ? `${outBase}/神选-竞彩推荐-${date}.xlsx` : `C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`;
writeXlsxWorkbook(xlsxTarget, sheets);

// ── 手机页(核心7列表 + 点行展开该场全部细节;用户 2026-06-09 选定"一打开全部看得见") ──
// 固定文件名防回退(2026-06-10):webshare 现页若已是更新日期(并行会话先交付了明日表),
// 重出旧日期绝不顶掉 —— 改写日期命名副本 足球推荐-<date>.html / football-<date>.html,固定URL保最新。
const readIfExists = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const html = renderMobileHtml({ date, rows, riskNote, intlN, wcN, auditFoot });
let htmlTarget = outBase ? `${outBase}/今日足球推荐.html` : "D:/Temp/webshare_lingdao/今日足球推荐.html";
if (!outBase) {
  const mob = resolveHtmlWriteTarget({
    existingHtml: readIfExists(htmlTarget), date, canonicalPath: htmlTarget,
    datedPath: `D:/Temp/webshare_lingdao/足球推荐-${date}.html`, dateRe: /神选·竞彩·(\d{4}-\d{2}-\d{2})/,
  });
  if (mob.preservedNewer) console.log(`⚠️ 固定手机页已是更新日期(${mob.preservedNewer})的交付,不顶掉;本次 ${date} 写日期副本:${mob.path}`);
  htmlTarget = mob.path;
}
writeFileSync(htmlTarget, html, "utf8");

// ── 英文固定URL页 football.html(缺陷#16:三面同源同日期,不再停在旧日期) ──
const enHtml = renderEnglishHtml({ date, rows, riskNote, intlN, wcN, banner: BANNER, auditFoot });
let enTarget = outBase ? `${outBase}/football.html` : "D:/Temp/webshare_lingdao/football.html";
if (!outBase) {
  const en = resolveHtmlWriteTarget({
    existingHtml: readIfExists(enTarget), date, canonicalPath: enTarget,
    datedPath: `D:/Temp/webshare_lingdao/football-${date}.html`, dateRe: /神选·足球·(\d{4}-\d{2}-\d{2})/,
  });
  if (en.preservedNewer) console.log(`⚠️ 固定英文页已是更新日期(${en.preservedNewer})的交付,不顶掉;本次 ${date} 写日期副本:${en.path}`);
  enTarget = en.path;
}
writeFileSync(enTarget, enHtml, "utf8");

// ── 副本落位:桌面稳定子文件夹(16:01清exports根,持久产物只认这里)+ webshare 下载副本 ──
if (!outBase) {
  const subDir = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
  try {
    mkdirSync(subDir, { recursive: true });
    copyFileSync(xlsxTarget, `${subDir}/神选-竞彩推荐-${date}.xlsx`);
    writeFileSync(`${subDir}/今日足球推荐.html`, html, "utf8");
  } catch (e) { console.log("子文件夹副本skip:", e.message); }
  try { copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/神选-竞彩推荐-${date}.xlsx`); copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/jingcai-${date}.xlsx`); } catch (e) { console.log("xlsx copy skip:", e.message); }
}

// ── 对话(完整) ──
console.log(`\n## ⚡ 今日竞彩完整覆盖交付 · ${date} · ${rows.length}场\n`);
for (const r of rows) {
  console.log(`### ${r.idx}. ${r.match}(${r.comp})· ${r.ko} · ${r.tier}${Math.round(r.conf)}`);
  if (r.wcLine) console.log(`  🏆 赛会: ${r.wcLine}`);
  if (r.scen) console.log(`  🎬 情景: ${r.scen}`);
  console.log(`  ① 胜负平🔶: ${r.wld}`);
  console.log(`     胜平负赔率✅: ${r.euro}`);
  console.log(`  ② 竞彩让球🔶: ${r.hcView}`);
  console.log(`     竞彩让球赔率✅: ${r.hc}`);
  console.log(`     博彩亚盘✅: ${r.asian}`);
  console.log(`  ③ 比分🔶: ${r.score}〔${r.scoreSrc}〕| 赔率✅: ${r.scoreMkt}`);
  console.log(`     半全场🔶: ${r.halffull}〔${r.hfSrc}〕| 赔率✅: ${r.hfMkt}`);
  console.log(`     大小球✅: ${r.ouReal} | 进球分布: ${r.dist}`);
  console.log(`  ④ 近5✅: ${r.homeRec} 〔${r.homeLast5}〕 ‖ ${r.awayRec} 〔${r.awayLast5}〕`);
  console.log(`     H2H: ${r.h2h} | 攻防: ${r.profile}`);
  if (r.adv) console.log(`  🔴 对抗证伪: ${r.adv.label}${r.adv.ev != null ? ` EV=${r.adv.ev}` : ""} — ${r.adv.kill}`);
  console.log("");
}
console.log(`✅ xlsx: ${xlsxTarget}`);
console.log(`✅ 手机页: ${htmlTarget}`);
console.log(`✅ 英文页: ${enTarget}`);
console.log(`\nBANNER: ${BANNER}`);
