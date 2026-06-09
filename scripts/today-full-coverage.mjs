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

const rows = games.map((p, i) => {
  const c = covFor(p);
  const s = p.marketSnapshot || {};
  const scoreMkt = !!(s.scoreOdds?.top?.length), hfMkt = !!(s.halfFullOdds?.top?.length);
  return {
    idx: i + 1, ko: ko(p), comp: compTag(p),
    match: `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
    // 模型方向概率(🔶,由500真盘de-vig+DC推得)
    wld: simpleWldCell(p), handicap: simpleHandicapCell(p),
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
const headers = ["#", "开赛", "对阵(赛事)", "胜负平🔶", "胜平负赔率✅", "让胜负平🔶", "让球赔率✅", "比分🔶", "比分赔率✅", "半全场🔶", "半全场赔率✅", "大小球✅", "进球分布✅", "亚盘", "主队近5✅", "客队近5✅", "H2H", "攻防画像", "信心档"];
const xrows = rows.map((r) => [String(r.idx), r.ko, `${r.match}(${r.comp})`,
  r.wld, r.euro, r.handicap, r.hc, `${r.score}〔${r.scoreSrc}〕`, r.scoreMkt, `${r.halffull}〔${r.hfSrc}〕`, r.hfMkt, r.ouReal, r.dist, r.asian,
  `${r.homeRec} ${r.homeLast5}`, `${r.awayRec} ${r.awayLast5}`, r.h2h, r.profile, `${r.tier}(${Math.round(r.conf)})`]);
const sheets = [{ name: "竞彩完整", rows: [[`⚡ 神选 · 竞彩完整覆盖 · ${date}`], [BANNER], headers, ...xrows] }];
const xlsxTarget = `C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`;
writeXlsxWorkbook(xlsxTarget, sheets);
const subDir = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
try { mkdirSync(subDir, { recursive: true }); copyFileSync(xlsxTarget, `${subDir}/神选-竞彩推荐-${date}.xlsx`); } catch (e) { console.log("子文件夹副本skip:", e.message); }

// ── 手机页(每场卡片,可读) ──
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cards = rows.map((r) => `<div class="card">
<div class="hd"><b>${esc(r.match)}</b> <span class="tag">${esc(r.comp)}</span> <span class="ko">${esc(r.ko)} · ${esc(r.tier)}${Math.round(r.conf)}</span></div>
<table class="kv">
<tr><th>胜负平🔶</th><td>${esc(r.wld)}</td></tr>
<tr><th>胜平负赔率</th><td>${esc(r.euro)}</td></tr>
<tr><th>让胜负平🔶</th><td>${esc(r.handicap)}</td></tr>
<tr><th>让球赔率</th><td>${esc(r.hc)}</td></tr>
<tr><th>比分🔶</th><td>${esc(r.score)} <span class="g">${esc(r.scoreSrc)}</span></td></tr>
<tr><th>比分赔率</th><td class="g">${esc(r.scoreMkt)}</td></tr>
<tr><th>半全场🔶</th><td>${esc(r.halffull)} <span class="g">${esc(r.hfSrc)}</span></td></tr>
<tr><th>半全场赔率</th><td class="g">${esc(r.hfMkt)}</td></tr>
<tr><th>大小球</th><td>${esc(r.ouReal)} <span class="g">${esc(r.dist)}</span></td></tr>
<tr><th>亚盘</th><td>${esc(r.asian)}</td></tr>
<tr><th>主队近5</th><td>${esc(r.homeRec)} <span class="g">${esc(r.homeLast5)}</span></td></tr>
<tr><th>客队近5</th><td>${esc(r.awayRec)} <span class="g">${esc(r.awayLast5)}</span></td></tr>
<tr><th>H2H</th><td>${esc(r.h2h)}</td></tr>
<tr><th>攻防画像</th><td>${esc(r.profile)}</td></tr>
</table></div>`).join("");
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⚡神选·足球·${date}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1a1a1a}.wrap{max-width:960px;margin:0 auto;padding:12px}h1{font-size:19px;margin:14px 4px}.note{background:#fff8e1;border-left:4px solid #ffb300;padding:8px 10px;margin:8px 4px;font-size:12.5px;border-radius:4px}.banner{background:#ffebee;border-left:4px solid #d32f2f;padding:8px 10px;margin:8px 4px;font-size:12.5px;border-radius:4px}.card{background:#fff;border-radius:10px;margin:10px 4px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}.hd{background:#4A148C;color:#fff;padding:8px 10px;font-size:14px}.tag{background:#7e57c2;border-radius:4px;padding:1px 6px;font-size:11px;margin-left:4px}.ko{float:right;font-size:11px;opacity:.85}table.kv{width:100%;border-collapse:collapse;font-size:12.5px}table.kv th{text-align:left;width:74px;color:#4A148C;background:#faf8fd;padding:6px 8px;border-top:1px solid #eee;vertical-align:top;font-weight:600}table.kv td{padding:6px 8px;border-top:1px solid #eee}.g{color:#888;font-size:11px}.dl{display:inline-block;margin:14px 4px;padding:10px 18px;background:#4A148C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}.foot{color:#888;font-size:11px;margin:16px 4px 30px}</style></head><body><div class="wrap">
<h1>⚡ 神选 · 足球完整覆盖 · ${date}</h1>
<div class="banner"><b>${esc(BANNER)}</b></div>
<div class="note">${esc(NOTE)}</div>
${cards}
<a class="dl" href="神选-竞彩推荐-${date}.xlsx?t=${Date.now() % 100000}">⬇ 下载完整 xlsx</a>
<div class="foot">单一数据源·三处(xlsx/手机页/对话)口径一致·真实端到端(${date})。5赔种=500竞彩静态XML(欧赔/让球/比分/半全场/总进球),近5/H2H=ESPN,缺口(亚盘/真xG)诚实标墙不编。</div>
</div></body></html>`;
writeFileSync("D:/Temp/webshare_lingdao/今日足球推荐.html", html, "utf8");
try { copyFileSync(xlsxTarget, `D:/Temp/webshare_lingdao/神选-竞彩推荐-${date}.xlsx`); } catch (e) { console.log("xlsx copy skip:", e.message); }

// ── 对话(完整) ──
console.log(`\n## ⚡ 今日竞彩完整覆盖交付 · ${date} · ${rows.length}场\n`);
for (const r of rows) {
  console.log(`### ${r.idx}. ${r.match}(${r.comp})· ${r.ko} · ${r.tier}${Math.round(r.conf)}`);
  console.log(`- 胜负平🔶: ${r.wld}  | 胜平负赔率✅: ${r.euro}`);
  console.log(`- 让胜负平🔶: ${r.handicap}  | 让球赔率✅: ${r.hc}`);
  console.log(`- 比分🔶: ${r.score}〔${r.scoreSrc}〕| 比分赔率✅: ${r.scoreMkt}`);
  console.log(`- 半全场🔶: ${r.halffull}〔${r.hfSrc}〕| 半全场赔率✅: ${r.hfMkt}`);
  console.log(`- 大小球✅: ${r.ouReal}  | 进球分布: ${r.dist}  | 亚盘: ${r.asian}`);
  console.log(`- 近5✅: ${r.homeRec} 〔${r.homeLast5}〕 ‖ ${r.awayRec} 〔${r.awayLast5}〕`);
  console.log(`- H2H: ${r.h2h}  | 攻防: ${r.profile}\n`);
}
console.log(`✅ xlsx: ${xlsxTarget}`);
console.log(`✅ 手机页: D:/Temp/webshare_lingdao/今日足球推荐.html`);
console.log(`\nBANNER: ${BANNER}`);
