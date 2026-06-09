// 今日"完整覆盖"竞彩交付:模型概率 + 真实补全数据(近5/H2H/大小球/攻防画像),三处口径一致。
// 用户铁律 2026-06-09:必须把所有赔率/数据补齐覆盖后再生成,关于一场比赛所有数据内容和赔率情况。
//   · 模型层(不改):胜负平/让胜负平/比分/半全场/信心  ← buildDailyRecommendationPackage(真钱管线)
//   · 补全层(本次新增,只读真实抓取缓存,绝不造假):
//       大小球 = The Odds API totals de-vig(4场WC真补;3场友谊赛无源诚实标墙)
//       近5场/H2H/攻防画像 = ESPN 跨league真实战绩(coverage 缓存)
// 数据源单一:coverage = D:/football-model-data/coverage/<date>.json(由 fetch-match-coverage.mjs 产)。
import {
  buildDailyRecommendationPackage,
  simpleWldCell, simpleHandicapCell, simpleScoreCell, simpleHalfFullCell,
} from "../src/daily-report.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { writeFileSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";

const date = process.argv[2] ?? "2026-06-09";
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
const cov = JSON.parse(readFileSync(`D:/football-model-data/coverage/${date}.json`, "utf8"));

// 竞彩交付 = jingcai + 已开售WC单场(by name)。
const WC_SINGLES = [["墨西哥", "南非"], ["韩国", "捷克"], ["加拿大", "波黑"], ["美国", "巴拉圭"]];
const isJc = (p) => p.fixture?.marketType === "jingcai";
const isWcSingle = (p) => WC_SINGLES.some(([h, a]) => (p.fixture.homeTeam || "").includes(h) && (p.fixture.awayTeam || "").includes(a));
// 世界杯场(预售6/12+):competition含世界杯 或 在WC单场名单(WC单场现也被ingest标jingcai marketType,故不能靠marketType区分)
const isWorldCupGame = (p) => String(p.fixture?.competition ?? "").includes("世界杯") || isWcSingle(p);
// --jconly:只要当天竞彩(即时在售的国际赛场),去掉预售世界杯单场(用户 2026-06-09 指定)
const JC_ONLY = process.argv.includes("--jconly");
const picked = preds.filter((p) => (isJc(p) || isWcSingle(p)) && !(JC_ONLY && isWorldCupGame(p)));
const byMatch = new Map();
for (const p of picked) {
  const key = `${p.fixture.homeTeam}|${p.fixture.awayTeam}`;
  const prev = byMatch.get(key);
  if (!prev || (isJc(p) && !isJc(prev))) byMatch.set(key, p);
}
const games = [...byMatch.values()].sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));

// coverage 按主队中文名匹配
const covFor = (p) => cov.matches.find((m) => (p.fixture.homeTeam || "").includes(m.home.zh) && (p.fixture.awayTeam || "").includes(m.away.zh));

const ko = (p) => { const k = p.fixture?.kickoff; return k && /\d{2}:\d{2}/.test(k) ? k.slice(5, 16) : (k?.slice(5, 10) ?? ""); };
const isWc = (p) => String(p.fixture?.competition ?? "").includes("世界杯") || WC_SINGLES.some(([h, a]) => (p.fixture.homeTeam || "").includes(h) && (p.fixture.awayTeam || "").includes(a));
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
    // 真实赔率(✅500实测 + ESPN/DraftKings亚盘/欧赔补)
    euro: euroStr(s, c?.espnOdds), asian: asianStr(c?.espnOdds), hc: hcStr(p, s),
    ouReal: ouRealStr(s), dist: distStr(s),
    scoreMkt: scoreMktStr(s), hfMkt: hfMktStr(s),
    // ESPN 补全
    homeRec: c ? `${c.home.zh} ${recStr(c.home)}` : "❌未取到",
    awayRec: c ? `${c.away.zh} ${recStr(c.away)}` : "❌未取到",
    homeLast5: c ? last5Str(c.home) : "", awayLast5: c ? last5Str(c.away) : "",
    h2h: h2hStr(c), profile: profileStr(c),
    conf: p.confidence, tier: p.selectionTier?.label ?? "",
  };
});

// ── banner / note 派生(真实数据) ──
const wcN = rows.filter((r) => /世界杯/.test(r.comp)).length, intlN = rows.length - wcN;
const coinRows = rows.filter((r) => /硬币/.test(r.tier));
const handicapOnly = rows.filter((r) => /未开售/.test(r.wld));
const ouFilled = rows.filter((r) => /大2\.5球/.test(r.ouReal)).length;
let riskNote = "";
if (coinRows.length) riskNote += `最高风险=${coinRows.map((r) => r.match).join("/")}(硬币档·势均易平),强烈建议不单押。`;
if (handicapOnly.length) riskNote += `${handicapOnly.map((r) => r.match.split(" vs ")[0]).join("/")}=悬殊盘只卖让球,信心反映"赢球方向"非"让球过盘",勿当胆。`;
const BANNER = `🔴 完整覆盖交付(${date}):${rows.length}场=${intlN}国际赛+${wcN}世界杯单场。赔率全补:胜平负/让球/比分/半全场/大小球(总进球)=500竞彩真盘${rows.length}/${rows.length}场,亚盘+欧赔(竞彩未开售场)=ESPN/DraftKings真盘补齐;近5场/H2H/攻防=ESPN真实战绩。真缺口仅:国家队真xG(FBref Cloudflare墙)、老H2H(ESPN限近赛季),已⚠️标不编。${riskNote}模型概率由真盘de-vig派生,1X2系统打不过收盘线、本质市场跟随器,买不买你定。`;
const NOTE = `✅ 赔率全覆盖:①500竞彩静态XML(spf/nspf/bf/bqc/jqs)=胜平负欧赔+让球+比分+半全场+大小球(总进球),比分/半全场为市场de-vig非模型估算;②ESPN/DraftKings=亚盘(pointSpread含让球线+水位+开盘异动)+竞彩未开售场的欧赔(moneyline)。近5场/H2H/攻防=ESPN真实战绩。⚠️真缺:国家队真xG(FBref Cloudflare墙,用近5进失球代理)、老H2H(ESPN仅近赛季窗口)。`;

// ── xlsx(完整列) ──
const headers = ["#", "开赛", "对阵(赛事)", "胜负平🔶", "胜平负赔率✅", "竞彩让球(模型过盘vs市场)", "竞彩让球赔率✅", "博彩亚盘✅", "比分🔶", "比分赔率✅", "半全场🔶", "半全场赔率✅", "大小球✅", "进球分布✅", "主队近5✅", "客队近5✅", "H2H", "攻防画像", "信心档"];
const xrows = rows.map((r) => [String(r.idx), r.ko, `${r.match}(${r.comp})`,
  r.wld, r.euro, r.hcView, r.hc, r.asian, `${r.score}〔${r.scoreSrc}〕`, r.scoreMkt, `${r.halffull}〔${r.hfSrc}〕`, r.hfMkt, r.ouReal, r.dist,
  `${r.homeRec} ${r.homeLast5}`, `${r.awayRec} ${r.awayLast5}`, r.h2h, r.profile, `${r.tier}(${Math.round(r.conf)})`]);
const sheets = [{ name: "竞彩完整", rows: [[`⚡ 神选 · 竞彩完整覆盖 · ${date}`], [BANNER], headers, ...xrows] }];
const xlsxTarget = `C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`;
writeXlsxWorkbook(xlsxTarget, sheets);
const subDir = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
try { mkdirSync(subDir, { recursive: true }); copyFileSync(xlsxTarget, `${subDir}/神选-竞彩推荐-${date}.xlsx`); } catch (e) { console.log("子文件夹副本skip:", e.message); }

// ── 手机页(核心7列表 + 点行展开该场全部细节;用户 2026-06-09 选定"一打开全部看得见") ──
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tierColor = (t) => /一档|二档/.test(t) ? "#2e7d32" : /三档/.test(t) ? "#f9a825" : /硬币/.test(t) ? "#6b7280" : "#ea580c";
// 核心列短值(从已算显示串解析,避免重复逻辑)
const wldS = (s) => { if (/未开售/.test(s)) return "未开售"; const m = s.match(/(主胜|平局|客胜)\((\d+)%\)/); return m ? `${m[1][0]}${m[2]}%` : "—"; };
const scoreS = (s) => { const m = String(s).match(/(\d+)-(\d+)/); return m ? m[0] : "—"; };
const hfS = (s) => { const m = String(s).match(/(主胜|平局|客胜)-(主胜|平局|客胜)/); return m ? `${m[1][0]}-${m[2][0]}` : "—"; };
const ouS = (s) => { const m = String(s).match(/大(\d+)%/); return m ? `大${m[1]}` : "—"; };
const detail = (r) => `<div class="drow"><b>胜负平</b>${esc(r.wld)}<span class="g"> · 欧赔 ${esc(r.euro)}</span></div>` +
  `<div class="drow"><b>让球${esc(r.hcP.line)}</b>模型 ${esc(r.hcP.model)}<br><span class="ind">市场 ${esc(r.hcP.market)}${r.hcP.diverge ? ` <span class="w2">⚠️以市场为准</span>` : ""}</span></div>` +
  `<div class="drow"><b>让球赔率</b>${esc(r.hc)}<br><b>博彩亚盘</b>${esc(r.asian)}</div>` +
  `<div class="drow"><b>比分</b>${esc(r.score)}<span class="g"> · 赔率 ${esc(r.scoreMkt)}</span></div>` +
  `<div class="drow"><b>半全场</b>${esc(r.halffull)}<span class="g"> · 赔率 ${esc(r.hfMkt)}</span></div>` +
  `<div class="drow"><b>大小球</b>${esc(r.ouReal)}<span class="g"> · 进球分布 ${esc(r.dist)}</span></div>` +
  `<div class="drow"><b>近5</b>${esc(r.homeRec)} <span class="g">${esc(r.homeLast5)}</span><br><span class="ind">${esc(r.awayRec)} <span class="g">${esc(r.awayLast5)}</span></span></div>` +
  `<div class="drow"><b>H2H</b>${esc(r.h2h)}</div>` +
  `<div class="drow"><b>攻防</b>${esc(r.profile)}</div>`;
const trs = rows.map((r) => `<tr class="r" onclick="tg(this)"><td class="m">${esc(r.match)} <span class="ar">▾</span><i>${esc(r.ko)} · ${esc(r.comp)}</i></td><td><span class="b" style="background:${tierColor(r.tier)}">${Math.round(r.conf)}</span></td><td>${esc(wldS(r.wld))}</td><td>${esc(r.hcP.line)}</td><td>${esc(scoreS(r.score))}</td><td>${esc(hfS(r.halffull))}</td><td>${esc(ouS(r.ouReal))}</td></tr><tr class="d"><td colspan="7">${detail(r)}</td></tr>`).join("");
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>神选·竞彩·${date}</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,"Microsoft YaHei",system-ui,sans-serif;margin:0;background:#eef1f5;color:#1c2530;-webkit-text-size-adjust:100%}.wrap{max-width:720px;margin:0 auto;padding:14px 10px 40px}
.top{background:linear-gradient(135deg,#4A148C,#7b1fa2);color:#fff;border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 6px 18px rgba(74,20,140,.28)}.top h1{font-size:18px;margin:0 0 3px;font-weight:700}.top .sub{font-size:12px;opacity:.88}.legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.legend span{font-size:11px;background:rgba(255,255,255,.18);padding:3px 9px;border-radius:20px}
.risk{background:#fff;border-left:4px solid #d32f2f;border-radius:10px;padding:10px 13px;margin-bottom:12px;font-size:12.5px;line-height:1.55;box-shadow:0 1px 5px rgba(0,0,0,.06)}
.hint{font-size:11.5px;color:#8a93a0;margin:0 4px 8px}
table.core{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(20,30,50,.08);font-size:13px}
table.core th{background:#4A148C;color:#fff;padding:10px 4px;font-weight:600;font-size:11.5px;text-align:center}table.core th:first-child{text-align:left;padding-left:12px}
.core .r{cursor:pointer;border-top:1px solid #eef0f3}.core .r td{padding:11px 4px;text-align:center;color:#1c2530;font-weight:600}
.core .r td.m{text-align:left;padding-left:12px;color:#2a1a4a}.core .r td.m i{display:block;font-style:normal;font-weight:400;color:#9097a3;font-size:10.5px;margin-top:2px}.core .r td.m .ar{color:#9333ea;font-size:11px}
.b{display:inline-block;min-width:26px;color:#fff;font-weight:700;font-size:12px;padding:3px 8px;border-radius:12px}
.core .d{display:none}.core .d.open{display:table-row}.core .d>td{padding:8px 13px 12px;background:#faf9fc}
.drow{padding:6px 0;font-size:12px;line-height:1.6;border-top:1px solid #efeaf6;color:#37404d}.drow:first-child{border-top:none}.drow b{color:#7e22ce;font-weight:700;margin-right:6px}.drow .g{color:#9aa6b4}.drow .ind{display:inline-block;margin-top:2px}.drow .w2{color:#d97706;font-weight:600}
.dl{display:block;text-align:center;margin:18px 2px 6px;padding:14px;background:#4A148C;color:#fff;border-radius:13px;text-decoration:none;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(74,20,140,.28)}
.foot{color:#9aa3af;font-size:11px;margin:12px 6px 0;line-height:1.55}</style></head><body><div class="wrap">
<div class="top"><h1>⚡ 神选 · 竞彩推荐</h1><div class="sub">${date} · ${rows.length}场${intlN ? ` 国际赛${intlN}` : ""}${wcN ? ` 世界杯${wcN}` : ""} · 5赔种全覆盖</div><div class="legend"><span>✅ 实测真盘</span><span>🔶 模型推断</span><span>⚠️ 缺口标缺不编</span></div></div>
<div class="risk">${esc(riskNote || "模型只给信心+风险参考,买不买你定。")}</div>
<div class="hint">👇 点任意一行 = 展开该场全部赔率/近5/H2H/攻防</div>
<table class="core"><thead><tr><th>对阵 ▾</th><th>信心</th><th>胜负平</th><th>让球</th><th>比分</th><th>半全</th><th>大小</th></tr></thead><tbody>${trs}</tbody></table>
<a class="dl" href="jingcai-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx(19列全字段)</a>
<div class="foot">真实端到端(${date})。5赔种=500竞彩XML(欧赔/让球/比分/半全场/总进球de-vig),亚盘+未开售场欧赔=ESPN/DraftKings,近5/H2H=ESPN。让球过盘=模型与市场两套数·分歧大以市场为准。缺口(国家队真xG/老H2H)诚实标。多agent审计已核让球线(中-1/匈-2/阿-2)。</div>
<script>function tg(r){r.nextElementSibling.classList.toggle('open');var a=r.querySelector('.ar');if(a)a.textContent=r.nextElementSibling.classList.contains('open')?'▴':'▾';}</script>
</div></body></html>`;
writeFileSync("D:/Temp/webshare_lingdao/今日足球推荐.html", html, "utf8");
try { copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/神选-竞彩推荐-${date}.xlsx`); copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/jingcai-${date}.xlsx`); } catch (e) { console.log("xlsx copy skip:", e.message); }

// ── 对话(完整) ──
console.log(`\n## ⚡ 今日竞彩完整覆盖交付 · ${date} · ${rows.length}场\n`);
for (const r of rows) {
  console.log(`### ${r.idx}. ${r.match}(${r.comp})· ${r.ko} · ${r.tier}${Math.round(r.conf)}`);
  console.log(`  ① 胜负平🔶: ${r.wld}`);
  console.log(`     胜平负赔率✅: ${r.euro}`);
  console.log(`  ② 竞彩让球🔶: ${r.hcView}`);
  console.log(`     竞彩让球赔率✅: ${r.hc}`);
  console.log(`     博彩亚盘✅: ${r.asian}`);
  console.log(`  ③ 比分🔶: ${r.score}〔${r.scoreSrc}〕| 赔率✅: ${r.scoreMkt}`);
  console.log(`     半全场🔶: ${r.halffull}〔${r.hfSrc}〕| 赔率✅: ${r.hfMkt}`);
  console.log(`     大小球✅: ${r.ouReal} | 进球分布: ${r.dist}`);
  console.log(`  ④ 近5✅: ${r.homeRec} 〔${r.homeLast5}〕 ‖ ${r.awayRec} 〔${r.awayLast5}〕`);
  console.log(`     H2H: ${r.h2h} | 攻防: ${r.profile}\n`);
}
console.log(`✅ xlsx: ${xlsxTarget}`);
console.log(`✅ 手机页: D:/Temp/webshare_lingdao/今日足球推荐.html`);
console.log(`\nBANNER: ${BANNER}`);
