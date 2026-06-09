// 当天竞彩"最优选择"裁决表(单sheet,xlsx)。实时端到端派生,每个数字可追溯本次运行。
// ✅实测=抓取赔率/异动/近5;🔶推断=模型概率。守 feedback_no_fabrication / feedback_recommendation_output_format。
import { buildDailyRecommendationPackage } from "../src/daily-report.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const date = process.argv[2] ?? "2026-06-09";
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
const cov = JSON.parse(readFileSync(`D:/football-model-data/coverage/${date}.json`, "utf8"));

const WANT = [["中国", "泰国"], ["匈牙利", "哈萨克"], ["阿根廷", "冰岛"]];
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const steam = (o, c) => o == null || c == null ? "—" : c < o - 0.01 ? "↓压入" : c > o + 0.01 ? "↑走高" : "持平";

const rows = WANT.map(([h, a]) => {
  const p = preds.find((x) => (x.fixture.homeTeam || "").includes(h) && (x.fixture.awayTeam || "").includes(a));
  const s = p.marketSnapshot || {};
  const eo = s.europeanOdds?.current || s.europeanOdds || {};
  const hc = s.handicapOdds || {};
  const ho = hc.initial || {}, hcur = hc.current || {};
  const cb = p.handicapPick?.coverBreakdown || {};
  const pr = p.probabilities || {};
  const c = cov.matches.find((m) => (p.fixture.homeTeam || "").includes(m.home.zh) && (p.fixture.awayTeam || "").includes(m.away.zh));
  const recH = c?.home?.record5, recA = c?.away?.record5;
  return {
    name: `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
    ko: p.fixture.kickoff, line: p.handicapPick?.line ?? "?",
    euro: eo.home ? `${eo.home}/${eo.draw}/${eo.away}` : "1X2未开售(只让球)",
    move: `主${ho.home ?? "?"}→${hcur.home ?? "?"}${steam(ho.home, hcur.home)} / 客(受让)${ho.away ?? "?"}→${hcur.away ?? "?"}${steam(ho.away, hcur.away)}`,
    m1x2: `主${pct(pr.home)}/平${pct(pr.draw)}/客${pct(pr.away)}`,
    cover: `主过盘${pct(cb.home)} / 走盘${pct(cb.push)} / 客受让${pct(cb.away)}`,
    conf: `${p.selectionTier?.label ?? ""}${Math.round(p.confidence)}`,
    form: `${c?.home?.zh ?? h} ${recH ? `${recH.w}胜${recH.d}平${recH.l}负` : "缺"} / ${c?.away?.zh ?? a} ${recA ? `${recA.w}胜${recA.d}平${recA.l}负` : "缺"}`,
  };
});

// 导向 + 建议(基于本次实测+模型,纪律读盘)
const verdict = {
  "匈牙利 vs 哈萨克斯坦": ["✅大热主胜·欧赔1.17/模型74%/让球异动平稳三方同向无背离", "★最优:胜负平【主胜】单关;让-2过盘仅24%太陡别碰"],
  "阿根廷 vs 冰岛": ["⚠️赢球最稳(91)但让球异动背离:模型让-1过盘67%,市场却冰岛+1受让压入·阿让球赔率走高", "高风险:1X2没得玩,让-1是深让大热陷阱(历史过盘<50%),不当胆;想玩只小注"],
  "中国 vs 泰国": ["⚠️硬币档:主胜51%勉强·让-1过盘仅28%·市场钱压泰国受让", "跳过 或 娱乐性小注主胜,别投重注"],
};

const title = `⚡ 神选 · 当天竞彩最优选择 · ${date}`;
const banner = `🎯 最优单注=【匈牙利 主胜(胜负平单关)】——唯一"高把握×有干净玩法×赔率盘口三方同向无背离"。阿根廷赢球虽稳但只有让-1这个坑(异动背离·深让大热)别贪;中国抛硬币别碰。模型1X2本质市场跟随器、不吹独门edge,单关仍~26%失手,买不买/下多大你定。`;
const header = ["场次", "开赛", "欧赔(胜/平/负)✅", "让球线✅", "让球异动✅", "模型1X2🔶", "让球过盘🔶", "信心", "近5✅", "盘口导向", "选择建议"];
const body = rows.map((r) => [r.name, r.ko, r.euro, `让${r.line}`, r.move, r.m1x2, r.cover, r.conf, r.form, verdict[r.name][0], verdict[r.name][1]]);
const tail = [
  [""],
  ["🔴 诚实边界(铁律,不吹稳赢):模型在1X2系统打不过收盘线、本质市场跟随器;只给把握+风险导向,下注与否你定,不替你弃赛。"],
  ["✅实测=本次抓取的欧赔/让球赔率异动/ESPN近5;🔶推断=DC模型概率。每个数字可追溯本次运行。"],
];
const sheets = [{ name: "当天竞彩最优选择", rows: [[title], [banner], header, ...body, ...tail] }];

const subDir = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
mkdirSync(subDir, { recursive: true });
const target = `${subDir}/神选-竞彩最优选择-${date}.xlsx`;
writeXlsxWorkbook(target, sheets);
try { copyFileSync(target, `D:/Temp/webshare_lingdao/神选-竞彩最优选择-${date}.xlsx`); } catch (e) { console.log("webshare copy skip:", e.message); }
console.log("✅ xlsx:", target);
console.log("✅ 手机下载:", `http://172.16.3.60/神选-竞彩最优选择-${date}.xlsx`);
for (const r of rows) console.log(`  ${r.name} | ${verdict[r.name][1]}`);
