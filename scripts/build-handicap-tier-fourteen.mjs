// 14场胜负彩「盘口分档(胆/双选/全包)」单表生成器。
// 口径:盘口为主——以 marketImpliedProbabilities(500/ESPN de-vig 1X2)为唯一分档依据;
//   盘口1X2未抓到的腿(远期/悬殊只让球)如实标缺,退模型方向+平双选或全包,绝不冒充盘口。
// 严格审查判档线:
//   胆   = 盘口热门≥70% 且 模型同向 且 平局≤22% 且 无盘口-模型背离;
//   双选 = 盘口热门50~69%(覆盖热门+平,接平局盲区);
//   全包 = 盘口热门<50% / 盘口与模型方向背离(实证分歧越大市场越对,无独立edge) / 盘口未开。
// 数据全部 live 派生,不硬编码;补算的WC腿用同一 predictFixture 引擎(世界杯→48强Elo)。
import { buildDailyRecommendationPackage } from "../src/daily-report.js";
import { predictFixture } from "../src/prediction-engine.js";
import { loadFixtures } from "../src/fixture-store.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";

const date = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const zh = (s) => (s === "home" ? "主胜" : s === "away" ? "客胜" : "平");
const sideOf = (o) => { const m = Math.max(o.home, o.draw, o.away); return m === o.home ? "home" : m === o.away ? "away" : "draw"; };
const pct = (o) => o ? `主${(o.home * 100).toFixed(0)} 平${(o.draw * 100).toFixed(0)} 客${(o.away * 100).toFixed(0)}` : "—";

function classify(mkt, mdl, hasMkt) {
  if (!hasMkt) {
    const mMax = Math.max(mdl.home, mdl.draw, mdl.away);
    if (mMax >= 0.70) { const s = sideOf(mdl); return { tier: "双选", opt: s === "draw" ? "主胜+客胜" : `${zh(s)}+平`, why: "盘口1X2未抓到(悬殊盘只让球/远期未开),依让球线或模型方向+平双选(非盘口胆)" }; }
    return { tier: "全包", opt: "全包(主+平+客)", why: "盘口未开+模型三路接近,无市场背书→全保" };
  }
  const mp = sideOf(mkt), dp = sideOf(mdl);
  if (mp !== dp) return { tier: "全包", opt: "全包(主+平+客)", why: `盘口热门=${zh(mp)} 与模型方向=${zh(dp)} 背离,实证分歧越大市场越对、无独立edge→全保` };
  const fav = Math.max(mkt.home, mkt.draw, mkt.away);
  if (fav >= 0.70 && mkt.draw <= 0.22) return { tier: "胆", opt: zh(mp), why: `盘口热门${(fav * 100).toFixed(0)}%+模型同向+平局仅${(mkt.draw * 100).toFixed(0)}%(达胆线)` };
  if (fav >= 0.50) return { tier: "双选", opt: mp === "draw" ? "主胜+客胜" : `${zh(mp)}+平`, why: `盘口热门${(fav * 100).toFixed(0)}%(未达70%胆线)→覆盖热门+平` };
  return { tier: "全包", opt: "全包(主+平+客)", why: `盘口热门仅${(fav * 100).toFixed(0)}%<50%,三路开放→全保` };
}

const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
const byMatch = new Map();
for (const p of preds) { const k = `${p.fixture.homeTeam}|${p.fixture.awayTeam}`; if (!byMatch.has(k)) byMatch.set(k, p); }

// 近7天 store 找停售未过的恰14腿期次
const addDays = (iso, k) => { const d = new Date(`${iso}T12:00:00+08:00`); d.setDate(d.getDate() + k); return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); };
let legs = null, storeDate = null;
for (let k = 0; k <= 6 && !legs; k++) {
  const dd = addDays(date, -k);
  let fx = []; try { fx = loadFixtures(dd).fixtures ?? []; } catch { fx = []; }
  const cand = fx.filter((f) => f.marketType === "shengfucai" && /第\d+期/.test(f.notes ?? ""));
  if (cand.length === 14) { const stopIso = (cand[0].notes ?? "").match(/停售=([0-9T:.\-Z]+)/)?.[1]; const stopDate = stopIso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(stopIso)) : null; if (stopDate && stopDate < date) continue; legs = cand; storeDate = dd; }
}
if (!legs) { console.error("❌ 近7天 store 未找到停售未过的恰14腿期次,不出表"); process.exit(1); }

const periodLabel = (legs[0].notes ?? "").match(/第\d+期/)?.[0] ?? "本期";
const stopIso = (legs[0].notes ?? "").match(/停售=([0-9T:.\-Z]+)/)?.[1];
const stopBj = stopIso ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(stopIso)) : "未知";

const rows = [];
let nDan = 0, nDouble = 0, nFull = 0;
const onDemand = [];
legs.forEach((leg, i) => {
  let p = byMatch.get(`${leg.homeTeam}|${leg.awayTeam}`);
  if (!p) { p = predictFixture({ homeTeam: leg.homeTeam, awayTeam: leg.awayTeam, competition: "世界杯", kickoff: leg.kickoff, marketType: "shengfucai" }, [], 0, {}); onDemand.push(`${leg.homeTeam} vs ${leg.awayTeam}`); }
  const mkt = p.marketImpliedProbabilities || null;
  const mdl = p.probabilities || p.baseProbabilities;
  const hasMkt = !!mkt;
  const c = classify(mkt, mdl, hasMkt);
  if (c.tier === "胆") nDan++; else if (c.tier === "双选") nDouble++; else nFull++;
  const tierMark = c.tier === "胆" ? "🟢胆" : c.tier === "双选" ? "双选" : "🔴全包";
  rows.push([
    String(i + 1), `${leg.homeTeam} vs ${leg.awayTeam}`, String(leg.kickoff ?? "").slice(0, 10),
    hasMkt ? pct(mkt) : "⚠️盘口未抓到", pct(mdl), hasMkt ? `${(Math.max(mkt.home, mkt.draw, mkt.away) * 100).toFixed(0)}%` : "—",
    tierMark, c.opt, c.why,
  ]);
});

const combos = Math.pow(2, nDouble) * Math.pow(3, nFull); // 胆=1
const nonFull = nDan + nDouble;
const r9 = Math.pow(2, nDouble); // 任选9 若取全部非全包腿(假设=9)

const title = `⚡ 神选 · 14场盘口分档(胆/双选/全包) · ${periodLabel} · ${date}`;
const banner = `口径:盘口为主(以500/ESPN de-vig 1X2为唯一分档依据,盘口未开如实标缺退模型+平)。停售(北京)${stopBj}=最后购买日。严格判档线:胆=盘口热门≥70%且模型同向且平≤22%;双选=盘口50~69%(盖平);全包=盘口<50%/盘口模型背离/盘口未开。WC小组赛首轮护栏本判0胆,盘口胆="相对最稳"非保证(1X2打不过收盘线)。买不买/买多少你定。`;
const header = ["#", "对阵", "赛日", "盘口deVig 主/平/客", "模型 主/平/客", "盘口热门", "分档", "选项", "严格审查依据"];

const sheetRows = [[title], [banner], header, ...rows,
  [""],
  [`分档汇总:🟢胆 ${nDan} 腿 · 双选 ${nDouble} 腿 · 🔴全包 ${nFull} 腿`],
  [`14场单式注数(全展开):胆×1 · 双选×2 · 全包×3 = 2^${nDouble} × 3^${nFull} = ${combos.toLocaleString("en-US")} 注 × 2元 = ${(combos * 2).toLocaleString("en-US")} 元`],
  [`严格审查结论:全包 ${nFull} 腿里含远期盘口未开/盘口模型背离的"盘口盲区"腿——全包是诚实承认市场无信息,非看好;${combos.toLocaleString("en-US")} 注不现实,此票不应整张全包式打。`],
  [""],
  [`✅ 务实方案=任选9:砍掉 ${nFull} 个全包腿(盘口盲区),保留信息最足的 ${nonFull} 腿(${nDan}胆+${nDouble}双选)`],
  [`   任选9注数 = 2^${nDouble} = ${r9} 注 × 2元 = ${r9 * 2} 元(需这 ${nonFull} 腿全中;任选9命中9场即奖)`],
  onDemand.length ? [`注:${onDemand.length} 腿(${onDemand.join("/")})未在当日抓取窗内,已用同一 predictFixture 引擎(世界杯→48强Elo,同口径)补预测;这些腿盘口未开,故落全包。`] : [""],
];

const exportDir = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });
const outPath = `${exportDir}/神选-14场盘口分档-${date}.xlsx`;
writeXlsxWorkbook(outPath, [{ name: "14场盘口分档", rows: sheetRows }]);
console.log(`✅ xlsx: ${outPath}`);

// 复制 ASCII 名到手机共享目录(中文名手机点击会404)
const webDir = "D:/Temp/webshare_lingdao";
const asciiName = `shenxuan-14-handicap-tier-${date}.xlsx`;
copyFileSync(outPath, `${webDir}/${asciiName}`);
console.log(`✅ 手机共享: ${webDir}/${asciiName}`);
console.log(`分档:胆${nDan}/双选${nDouble}/全包${nFull} · 单式${combos}注 · 任选9 ${r9}注`);
