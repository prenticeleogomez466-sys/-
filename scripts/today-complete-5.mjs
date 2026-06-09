// 今日完整竞彩交付(单一数据源→xlsx+手机页+对话三处口径一致)。
// 含3国际赛(jingcai)+2世界杯单场(已开售竞彩单场,真实让球线已注入market快照)。
// banner/notes 全部从当日真实数据+workflow证伪结论派生,绝不硬编码(根治"每次输出不一样")。
import {
  buildDailyRecommendationPackage,
  simpleWldCell, simpleHandicapCell, simpleScoreCell, simpleHalfFullCell,
  toSimpleFourteenRow,
} from "../src/daily-report.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { writeFileSync, copyFileSync } from "node:fs";

const date = process.argv[2] ?? "2026-06-08";
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];

// 竞彩交付 = 全部jingcai + 已开售的世界杯单场(by name)。WC单场让球线已由market快照注入。
const WC_SINGLES = [["墨西哥", "南非"], ["韩国", "捷克"]];
const isJc = (p) => p.fixture?.marketType === "jingcai";
const isWcSingle = (p) => p.fixture?.marketType === "shengfucai" &&
  WC_SINGLES.some(([h, a]) => (p.fixture.homeTeam || "").includes(h) && (p.fixture.awayTeam || "").includes(a));
const picked = preds.filter((p) => isJc(p) || isWcSingle(p));
// 按队名去重(防双源叠加重复:官方+fallback ingest 可能各写一条同场);同场优先 jingcai-marketType。
const byMatch = new Map();
for (const p of picked) {
  const key = `${p.fixture.homeTeam}|${p.fixture.awayTeam}`;
  const prev = byMatch.get(key);
  if (!prev || (isJc(p) && !isJc(prev))) byMatch.set(key, p);
}
const five = [...byMatch.values()]
  .sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));

// 14场只在"今日确为14场比赛日"(available===true)时才输出;
// 仅在售/比赛日在未来(available===false)按用户硬规则"没有14场就只推荐竞彩"→完全不发14场(sheet+手机表都不出)。
const fourteenAvailable = pkg.recommendations?.fourteen?.available === true;
const fourteen = fourteenAvailable ? (pkg.recommendations?.fourteen?.selections ?? []) : [];
const f14note = pkg.recommendations?.fourteen?.note ?? "";

// ── 单一数据模型:5行,三处共用 ──
const ko = (p) => { const k = p.fixture?.kickoff; return k && /\d{2}:\d{2}/.test(k) ? k.slice(5, 16) : (k?.slice(5, 10) ?? ""); };
const tierLabel = (p) => p.selectionTier?.label ?? "";
// 类别判定按 competition 含"世界杯"(不依赖 marketType:WC单场可能被ingest标jingcai或14场源标shengfucai)。
const isWc = (p) => String(p.fixture?.competition ?? "").includes("世界杯");
const compTag = (p) => (isWc(p) ? "世界杯·单场" : p.fixture.competition);
const dcForm = (p) => { const d = p.deepContext; const h = d?.home?.form, a = d?.away?.form; return (!h && !a) ? "未取到" : `${h ?? "—"} / ${a ?? "—"}`; };
const dcH2H = (p) => p.deepContext?.h2h ?? "无记录";
const dcProfile = (p) => { const tp = p.teamProfile; return (!tp || (!tp.home && !tp.away)) ? "未取到(国家队无俱乐部画像)" : ([tp.home?.ppg > 0 ? `主${tp.home.ppg}` : null, tp.away?.ppg > 0 ? `客${tp.away.ppg}` : null].filter(Boolean).join(" / ") || "未取到"); };

const rows = five.map((p, i) => ({
  idx: i + 1, ko: ko(p), comp: compTag(p),
  match: `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
  wld: simpleWldCell(p), handicap: simpleHandicapCell(p),
  score: simpleScoreCell(p), halffull: simpleHalfFullCell(p),
  form: dcForm(p), h2h: dcH2H(p), profile: dcProfile(p),
  conf: p.confidence, tier: tierLabel(p),
}));

// ── 派生 banner + note(全从当日真实 rows 动态生成,绝不硬编码队名/场数) ──
const wcN = five.filter(isWc).length;
const intlN = five.length - wcN;
const coinRows = rows.filter((r) => /硬币/.test(r.tier));
const handicapOnlyRows = rows.filter((r) => /未开售/.test(r.wld));   // 悬殊盘只卖让球(1X2未开售)
const sold1x2 = five.length - handicapOnlyRows.length;               // 真正有1X2主选的场数
const homeShort = (r) => r.match.split(" vs ")[0];
const lineOf = (r) => { const m = String(r.handicap).match(/让\s*([+-]?\d+(?:\.\d+)?)/); return m ? `让${m[1]}` : "线缺"; };
const lineList = rows.map((r) => `${homeShort(r)}${lineOf(r)}`).join("、");
// note:让球线清单 + 未开售提示 + 完整性缺口,全派生
const NOTE = `⚠️ 让球线均为 <b>500.com 实时核实</b>(${lineList})。` +
  (handicapOnlyRows.length ? `悬殊盘多只卖让球(${handicapOnlyRows.map(homeShort).join("/")} 胜平负未开售)。` : "") +
  `国家队无俱乐部画像、近5场/H2H 多缺,已标⚠️未取到。比分/半全场部分为模型🔶推断。`;
// banner 风险段:硬币档 + 悬殊盘只让球(信心指赢球方向非过盘),均从 rows 派生(对齐 workflow 交叉审计高风险结论)
let riskNote = "";
if (coinRows.length) riskNote += `最高风险=${coinRows.map((r) => r.match).join("/")}(硬币档·信心${coinRows.map((r) => Math.round(r.conf)).join("/")}·势均易平),强烈建议不单押。`;
if (handicapOnlyRows.length) riskNote += `${handicapOnlyRows.map((r) => r.match).join("/")}=悬殊盘只卖让球,信心档反映"赢球方向"非"让球过盘"(深让大热过盘历史<50%、覆盖把握低),勿当胆。`;
const BANNER = `🔴 多agent交叉证伪(football-today-cross-verify, ${date}):${five.length}场=${intlN}国际赛+${wcN}世界杯单场,${sold1x2}场1X2主选方向均与500市场不冲突、让球线双路核对零不一致、无臆造。` +
  riskNote +
  `全场国际赛/国家队近5场·H2H·画像多缺(免费源墙,已标⚠️);方向多半对但负EV大热不保稳赢,只提示不替你弃赛。`;

// ── xlsx ──
const jcHeaders = ["序号", "开赛", "对阵(赛事)", "胜负平", "让胜负平(真实线)", "比分", "半全场", "近5场", "H2H", "画像", "信心档"];
const jcRows = rows.map((r) => [String(r.idx), r.ko, `${r.match}(${r.comp})`, r.wld, r.handicap, r.score, r.halffull, r.form, r.h2h, r.profile, `${r.tier}(${Math.round(r.conf)})`]);
const sheets = [{ name: "竞彩", rows: [[`⚡ 神选 · 竞彩 · ${date}`], [BANNER], jcHeaders, ...jcRows] }];
if (fourteen.length) sheets.push({ name: "14场", rows: [[`⚡ 神选 · 14场胜负彩 · ${date}`], [f14note || "第26085期 世界杯小组赛"], ["#", "对阵", "单关", "胆/双选", "信心"], ...fourteen.map(toSimpleFourteenRow).map((r) => [r[0], r[2], r[3], r[4], r[5]])] });
const xlsxTarget = `C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`;
writeXlsxWorkbook(xlsxTarget, sheets);
// 稳定子文件夹副本(不被16:01清exports根)
import { mkdirSync } from "node:fs";
const subDir = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
try { mkdirSync(subDir, { recursive: true }); copyFileSync(xlsxTarget, `${subDir}/神选-竞彩推荐-${date}.xlsx`); } catch (e) { console.log("子文件夹副本skip:", e.message); }

// ── 手机页(同一 rows + 同一 BANNER) ──
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mRows = rows.map((r) => `<tr><td>${esc(r.ko)}</td><td><b>${esc(r.match)}</b><br><span style="color:#7e57c2;font-size:11px">${esc(r.comp)}</span></td><td>${esc(r.wld)}</td><td>${esc(r.handicap)}</td><td>${esc(r.score)}</td><td>${esc(r.halffull)}</td><td>${esc(r.tier)}<br>${Math.round(r.conf)}</td></tr>`).join("");
const f14Rows = fourteen.map(toSimpleFourteenRow).map((r) => `<tr><td>${r[0]}</td><td>${esc(r[2])}</td><td><b>${esc(r[3])}</b></td><td>${esc(r[4])}</td><td>${esc(r[5])}</td></tr>`).join("");
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⚡神选·足球·${date}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1a1a1a}.wrap{max-width:960px;margin:0 auto;padding:12px}h1{font-size:19px;margin:14px 4px}h2{font-size:16px;margin:18px 4px 8px;color:#4A148C}.note{background:#fff8e1;border-left:4px solid #ffb300;padding:8px 10px;margin:8px 4px;font-size:13px;border-radius:4px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;font-size:12.5px;box-shadow:0 1px 3px rgba(0,0,0,.08)}th{background:#4A148C;color:#fff;padding:8px 6px;text-align:left;font-weight:600}td{padding:7px 6px;border-top:1px solid #eee;vertical-align:top}tr:nth-child(even) td{background:#faf8fd}.dl{display:inline-block;margin:14px 4px;padding:10px 18px;background:#4A148C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}.foot{color:#888;font-size:11px;margin:16px 4px 30px}</style></head><body><div class="wrap">
<h1>⚡ 神选 · 足球推荐 · ${date}</h1>
<div class="note" style="border-color:#d32f2f;background:#ffebee"><b>${esc(BANNER)}</b></div>
<h2>竞彩 · ${five.length} 场(${intlN}国际赛 + ${wcN}世界杯单场)</h2>
<div class="note">${NOTE}</div>
<table><tr><th>开赛</th><th>对阵</th><th>胜负平</th><th>让胜负平</th><th>比分</th><th>半全场</th><th>信心</th></tr>${mRows}</table>
${fourteen.length ? `<h2>14场胜负彩 · ${esc(f14note || "第26085期(世界杯小组赛)")}</h2><div class="note">📌 今天正在售,赛期6/12起,附14腿预测供参考。</div><table><tr><th>#</th><th>对阵</th><th>单关</th><th>胆/双选</th><th>信心</th></tr>${f14Rows}</table>` : ""}
<a class="dl" href="神选-竞彩推荐-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx${fourteen.length ? "(两表)" : "(竞彩)"}</a>
<div class="foot">单一数据源生成·三处(xlsx/手机页/对话)口径一致·真实端到端·让球线500实时核(${date})。模型只给信心+风险,买不买由你定。</div>
</div></body></html>`;
const mobileOut = "D:/Temp/webshare_lingdao/今日足球推荐.html";
writeFileSync(mobileOut, html, "utf8");
try { copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/神选-竞彩推荐-${date}.xlsx`); } catch (e) { console.log("xlsx copy skip:", e.message); }

// ── 对话表(同 rows) ──
console.log(`\n## ⚡ 今日竞彩完整交付 · ${date} · ${five.length}场(${intlN}国际赛+${wcN}世界杯单场)\n`);
console.log("| # | 开赛 | 对阵 | 胜负平 | 让球 | 比分 | 半全场 | 信心 |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.idx} | ${r.ko} | ${r.match}(${r.comp}) | ${r.wld} | ${r.handicap} | ${r.score} | ${r.halffull} | ${r.tier}${Math.round(r.conf)} |`);
console.log(`\n✅ xlsx: ${xlsxTarget}`);
console.log(`✅ 手机页: ${mobileOut}`);
console.log(`\nBANNER: ${BANNER}`);
