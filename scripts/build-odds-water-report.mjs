/**
 * 赔率×水位全面实证报告 xlsx 生成器(2026-06-13)
 * 读 data-change-study-5yr.json + odds-water-interaction-5yr.json,
 * 出 桌面\足球分析\<date>\赔率水位与赛果实证全面分析_<date>.xlsx
 * 用法:node scripts/build-odds-water-report.mjs --date 2026-06-13
 */
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const DATE = getArg("date", "2026-06-13");

const exp = getExportDir();
const study = JSON.parse(readFileSync(join(exp, "data-change-study-5yr.json"), "utf8"));
const inter = JSON.parse(readFileSync(join(exp, "odds-water-interaction-5yr.json"), "utf8"));

const HEAD = ["分桶", "样本n", "热门胜率%", "平率%", "冷门率%", "大球率%", "过盘率%", "走盘率%", "备注"];

function rowsFromStudy(title, obj, note = "") {
  const rows = [[title], HEAD];
  for (const [k, v] of Object.entries(obj)) {
    if (k === "n" || typeof v !== "object") continue;
    rows.push([k, v.n, v.热门胜率, v.平率, v.冷门率, v.大球率, v.过盘率 ?? "", v.走盘率 ?? "", ""]);
  }
  if (note) rows.push(["└ 注", note]);
  rows.push([]);
  return rows;
}
function rowsFromInter(title, obj, note = "") {
  const rows = [[title], HEAD];
  const order1 = Object.keys(obj).sort();
  for (const k1 of order1) {
    const inner = obj[k1];
    const order2 = Object.keys(inner).sort();
    for (const k2 of order2) {
      const v = inner[k2];
      const label = k2 === "全部" ? k1 : `${k1} × ${k2}`;
      const warn = v.n < 300 ? "⚠️样本不足仅参考" : "";
      rows.push([label, v.n, v.热门胜率, v.平率, v.冷门率, v.大球率, v.过盘率 ?? "", v.走盘率 ?? "", warn]);
    }
  }
  if (note) rows.push(["└ 注", note]);
  rows.push([]);
  return rows;
}

const banner = `⚡赔率·水位·盘口 与赛果关系 五年全量实证 | ${study.seasons.join("/")} · ${study.leagues}联赛 · ${study.totalMatches}场 | football-data.co.uk 开盘Avg/收盘AvgC 去vig | 生成 ${DATE}`;

const s1 = [
  [banner], [],
  ["结论速览(✅实测=本次33318场重算;🔶推断=由实测派生;来源脚本注明)"],
  ["#", "结论", "关键数字", "标签"],
  ["1", "欧赔开→收漂移是单因子里最强的方向信号:被加注热门胜率显著高于退烧热门", `被加注56.4% vs 稳定51.4% vs 退烧45.5%(差距≈11pp,n=33274)`, "✅实测 study-5yr"],
  ["2", "但按收盘价档位分层后,漂移的残余预测力基本消失——信息已全部进收盘价。同档位内被加注vs退烧胜率几乎一样", "中热档:加注57.2/稳定55.8/退烧57.4;大热档:67.3/69.2/66.1;只在均势档残留(43.0 vs 37.8)", "✅实测 diag-interaction"],
  ["3", "水位升降是四类因子里最弱的,且民间口诀'降水=庄家怕、热门危险'被证伪:降水(钱压热门)热门反而略稳", "降水52.2%胜/过盘45.9 vs 升水50.7%/43.8(差仅1.5-2pp);各线深档内差距均≤3pp", "✅实测 study-5yr+diag"],
  ["4", "让球盘过盘率几乎全程<50%:无论水位怎么动、线怎么动,押热门让球长期输面大", "全部18个分桶里过盘率43.8-48.6%;唯一>50%是中盘(半球~半一)51-53.8%,但扣水位成本后≈打平", "✅实测 diag-interaction"],
  ["5", "亚盘线加深(让得更深)≠让球更稳:热门更常赢(56.5%)但要赢更多才过盘,过盘率仍只有45.3%", "线加深:胜56.5/过盘45.3;线变浅:胜49.6/过盘43.8、走盘率翻倍至10.6%", "✅实测 study-5yr"],
  ["6", "大小球漂移对总进球方向有明显对应,且和胜负联动:看涨进球的场热门更容易大胜", "OU升:大球率58.8%、热门胜57.5%、赢2+球占58.5;OU降:大球45.7%、平局率升至28.2%", "✅实测 study-5yr"],
  ["7", "欧亚同向=最可信:欧赔升概率+亚盘加深 → 热门胜率最高桶", "同向看好58.2%胜(n=5148) vs 双稳50.8%;过盘仍仅46.8%→该信号买胜平负、别追深让", "✅实测 diag-interaction"],
  ["8", "欧亚背离=最强防冷信号:欧赔退烧但亚盘反而加深的场,热门胜率暴跌、冷门率近翻倍", "背离桶热门仅30.8%胜、冷门41.9%(n=344,占比1%罕见但效应巨大)", "✅实测 diag-interaction(n小,作风险旗标不作主推依据)"],
  ["9", "超热档(隐含≥70%)实际兑现率高于隐含——热门长期被市场轻微低估(favorite-longshot bias 方向)", "超热档实际胜率78.8-82.1%;均势档热门只38-43%", "✅实测 diag-interaction"],
  ["10", "深盘(一球~球半)是让球大坑:热门赢面66%但过盘率仅38.4-39.8%、走盘15-18%", "想跟深盘热门→买胜平负或降级买浅一档,别原盘跟让", "✅实测 diag-interaction"],
  ["11", "水位绝对档是诚实指标:同线深下,低水(钱压热门)热门全线单调更稳,'低水=诱盘陷阱'反向论证伪——但优势恰好被低赔付吃掉", "浅盘42.8/40.3/38.0、中盘54.2/52.6/48.6(低/中/高水);最佳格'低水中盘'过盘54.2% vs 0.85水保本线54.05%≈零利润,市场定价精准", "✅实测 diag-interaction;保本线换算🔶推断"],
  ["12", "以上全部是'描述性经验频率'(用了收盘信息,开赛才可知),不构成赛前可下注edge:模型与市场分歧越大、市场越对", "分歧前5%:市场命中62.5% vs 模型51.4;模型pick平均CLV≈-0.069%;同向命中54.2/逆市22.7", "✅实测 2026-05-31 signal-crossval+backtest-clv(脚本在仓库可复跑)"],
  ["13", "生产用法:漂移→朝晚盘阻尼修正(line-movement-signal);分歧→降档置信门(clv-confidence-gate);水位→仅作弱确认不独立驱动;背离→风险旗标", "盘口水位直接映射1X2命中仅43.8%(四路最差),已禁止独立驱动概率", "✅实测+生产代码现状"],
  [],
];

const sheets = [
  { name: "结论速览", rows: s1 },
  { name: "单因子·开收漂移四桶", rows: [
    [banner], [],
    ...rowsFromStudy("① 1X2 欧赔热门 开→收 漂移 → 赛果", study["①_1X2热门开收漂移"], "被加注=收盘隐含概率比开盘高>2pp;另:被加注热门赢时2+球占55.6% vs 退烧49.0%"),
    ...rowsFromStudy("② 亚盘热门方水位 开→收 移动 → 赛果/过盘", study["②_亚盘热门水位移动→过盘"], "升水阈值=欧式水位变化>±0.03"),
    ...rowsFromStudy("③ 大小球 开→收 漂移 → 大球率", study["③_大小球开收漂移→大球"]),
    ...rowsFromStudy("④ 亚盘让球线 开→收 加深/变浅 → 过盘", study["④_亚盘线开收移动→过盘"], "加深=收盘|线|比开盘大0.05以上"),
  ]},
  { name: "A欧赔档位×漂移", rows: [[banner], [], ...rowsFromInter("A. 欧赔热门档位(收盘隐含概率) × 开收漂移", inter["A_欧赔档位×开收漂移"], "档位按收盘热门去vig隐含概率;同档内漂移效应≈消失=收盘价已吸收全部信息")] },
  { name: "B线深×水位移动", rows: [[banner], [], ...rowsFromInter("B. 亚盘线深 × 热门方水位移动", inter["B_亚盘线深×水位移动"], "中盘(0.5/0.75)无整数走盘故走盘率0;0.75线半输半赢按净方向二分")] },
  { name: "C水位档×线深", rows: [[banner], [], ...rowsFromInter("C. 收盘水位绝对档(欧式折中式) × 线深 → 过盘", inter["C_收盘水位档×线深→过盘"], "football-data水位为欧式小数(≈1.90),中式水位≈欧式-1")] },
  { name: "D欧亚联动", rows: [[banner], [], ...rowsFromInter("D. 欧赔漂移 × 亚盘线移动 同向/背离", inter["D_欧亚联动同向背离"], "③欧看好亚退让 n=4 ⚠️无统计意义")] },
  { name: "可下注性裁决", rows: [
    [banner], [],
    ["信号→能不能用来赢钱(历史回测裁决汇总)"],
    ["信号", "描述性效应", "可下注edge", "裁决", "证据来源"],
    ["欧赔开收漂移", "强(11pp)", "无(收盘才可知;赛前快照漂移CLV≈0)", "只作朝晚盘阻尼修正+置信分层", "✅scripts/signal-crossval-backtest.mjs 2026-05-31"],
    ["亚盘水位升降", "极弱(1.5-2pp)", "无(1X2映射命中43.8%,四路最差)", "禁止独立驱动,仅多公司一致时作弱确认", "✅同上+run-asian-water-backtest.mjs"],
    ["亚盘线移动", "中(胜率7pp,过盘无差)", "无(过盘率全程<50%)", "作热门强弱画像,不作让球盘买点", "✅本次diag+study"],
    ["大小球漂移", "中(13pp大球率)", "无(打不过收盘线,差1.9%)", "情景画像:OU降→平局风险升", "✅ou25-crossval-backtest.mjs"],
    ["欧亚背离", "强(冷门率近翻倍)", "未测(n=344太薄,无法独立回测)", "作防冷风险旗标,降档不弃赛", "✅本次diag;🔶应用方式为推断"],
    ["模型逆市场", "负效应", "负(CLV-0.814%,命中27.9%)", "clv-confidence-gate强制降档(已生产)", "✅backtest-clv.mjs 13783场"],
    [],
    ["铁律对照:以上结论符合'开盘赔率已编码一切公开信息,免费数据打不过有效市场'(reference_signal_backtest_findings);真KPI=CLV与校准,不是命中率。"],
  ]},
];

const outDir = join(process.env.USERPROFILE, "Desktop", "足球分析", DATE);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `赔率水位与赛果实证全面分析_${DATE}.xlsx`);
writeXlsxWorkbook(outPath, sheets);
console.log(`[report] XLSX → ${outPath}`);

// 手机网页下载(英文固定URL)
try {
  const webDir = "D:\\Temp\\webshare_lingdao";
  const webPath = join(webDir, "odds-water-study.xlsx");
  copyFileSync(outPath, webPath);
  console.log(`[report] WEB → http://172.16.3.60/odds-water-study.xlsx?v=${DATE.replace(/-/g, "")}`);
} catch (e) { console.log(`[report] web copy skip: ${e.message}`); }
