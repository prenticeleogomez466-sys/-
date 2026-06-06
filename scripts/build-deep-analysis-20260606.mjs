// 无兜底针对性深度分析(2026-06-06)——用户投真钱·永久铁律最高指令下手工合成
// 数据全部真实可追溯:①首回合赛果/累计/赛事重要性=Wikipedia「J1 100 Year Vision League」(本session抓)
// ②市场赔率/初赔→即时变化=500.com(本session jingcai-daily live)③模型概率=本session生产prediction-engine
// (国际赛垃圾λ已按铁律剔除)④国际赛性质=FIFA/搜索核实(世界杯热身)。缺失项(精确开赛时刻/近期状态/伤停)
// 一律标"未取到/缺"不臆造。
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "D:\\football-model-exports\\深度分析_20260606";
mkdirSync(OUT_DIR, { recursive: true });

// 真实合成数据(每条都可追溯,见文件头)
const rows = [
  // [序, 对阵, 赛事·重要性, 形势(首回合→累计), 市场方向+变化, 模型读数, 针对性研判(理由), 信心/可投]
  ["6201", "鹿岛鹿角 vs 神户胜利船",
   "J1百年构想·冠军决赛次回合｜重要性:对神户极高(夺冠+AFC精英席),对鹿岛已无意义",
   "首回合 神户5-0鹿岛 → 累计鹿岛0-5,需净胜6球=不可能",
   "市场客胜(神户)48.7%/平25/主26.4;欧赔未动",
   "DC:神户攻防略优(防0.79);本场odds+DC",
   "🔴死签弃:累计已定(神户夺冠锁定),神户无欲无求、主力轮换风险高;鹿岛主场拼荣誉但无独立近况验证。市场/模型都没把神户轮换price进去→噪声场",
   "不投(死签+轮换噪声)"],
  ["6205", "柏太阳神 vs 京都不死鸟",
   "J1百年构想·10名排位次回合｜重要性:低(争最终排位)",
   "首回合 柏客场6-2京都 → 累计柏领先4球,京都需净胜4球=极难",
   "市场客胜(京都)41.5%>主(柏)33.8;欧赔未动",
   "本场odds+DC,两队接近",
   "🔴近死签弃:柏累计大幅领先、本场可松懈轮换,京都自由发挥→市场已反映(客胜>主胜)。死签性质=结果噪声大,缺近况验证",
   "不投(近死签)"],
  ["6206", "川崎前锋 vs 广岛三箭",
   "J1百年构想·4名排位次回合｜重要性:中(争第4+排位)",
   "首回合 广岛2-1川崎(广岛主场胜) → 累计川崎落后1球,主场需扳≥1",
   "市场主胜(川崎)48.7%最高;欧赔未动",
   "DC:广岛攻1.04/客场λ1.56偏高;本场odds+DC",
   "🟡相对可信:川崎主场+累计落后必须进球→进攻动机明确,主胜方向有真实情景支撑(动机驱动,非纯市场)。但广岛客场进球能力强,留爆冷",
   "可小注 主胜方向(动机支撑)"],
  ["6202", "町田泽维亚 vs 名古屋鲸八",
   "J1百年构想·3名排位次回合｜重要性:中(町田东区3/名古屋西区3,争季军)",
   "首回合 名古屋2-2町田 → 累计平,町田主场次回合定胜负=真live",
   "市场强推客胜(名古屋)55.7%;odds-only(模型无视角);欧赔未动",
   "DC对此场不可用(odds-only)",
   "🟡偏客但谨慎:真live定胜负场,但市场异常强推客队55.7%(町田主场反被看衰)——通常意味名古屋近况好/町田有伤停,然我无近期状态/伤停数据独立验证→不臆断、只标市场信号明确",
   "可跟客胜但缺验证(谨慎)"],
  ["6204", "横滨水手 vs 清水鼓动",
   "J1百年构想·8名排位次回合｜重要性:低-中",
   "首回合 清水1-1横滨 → 累计平,横滨主场次回合定=真live",
   "市场客胜(清水)50.7%;欧赔未动",
   "DC:清水客场λ偏高;odds+DC",
   "🟠偏客:真live场,但横滨主场被市场看衰(客胜50.7),缺近况独立验证。与町田同型(主场被看衰)",
   "抛硬币偏客(缺验证)"],
  ["6203", "浦和红钻 vs 冈山绿雉",
   "J1百年构想·6名排位次回合｜重要性:低",
   "首回合 冈山1-1浦和 → 累计平,浦和主场次回合定=真live",
   "市场客胜(冈山)41.5%>主(浦和)31.2;欧赔未动",
   "DC:浦和攻0.89偏弱;odds+DC",
   "🟠最接近抛硬币:三项概率分散(31/27/41),浦和主场小幅被看衰,无强信号、无近况验证",
   "弃(三向胶着无edge)"],
  ["5203", "匈牙利 vs 芬兰",
   "世界杯热身友谊赛｜重要性:低(练兵试阵,均未进世界杯主线)",
   "无两回合(单场友谊)",
   "市场+国家队Elo 主胜(匈牙利)41.5%;欧赔主队降温4%(略退)",
   "⚠️DC垃圾λ(总5.7球)已按铁律剔除→改用odds(0.78)+国家队Elo(0.22),λ回归正常",
   "🟠谨慎:剔垃圾后主胜略占优(主场+Elo),但友谊赛轮换试阵、强度不真、爆冷常态→信心不夸大",
   "可小注主胜但友谊赛打折"],
  ["5204", "加拿大 vs 爱尔兰",
   "世界杯热身友谊赛｜重要性:中(加拿大是世界杯东道主、认真备战;爱尔兰未进)",
   "无两回合(单场友谊)",
   "市场客胜(爱尔兰)47.7%>主(加拿大)27;欧赔主队降温10%(明显退烧)、客队升温6%",
   "本场odds+DC(λ总4.2尚在阈内,未剔)",
   "🟡资金信号:欧赔主队大幅降温10%+客队升温=资金弃加拿大跟爱尔兰,与客胜47.7一致。但东道主主场练兵可能藏实力→留意",
   "可跟客胜方向(资金一致)"],
  ["5202", "斯洛伐克 vs 黑山",
   "世界杯热身友谊赛｜重要性:极低(两队均未进世界杯,纯练兵无意义)",
   "无两回合(单场友谊)",
   "市场主胜(斯洛伐克)略优;欧赔平局升温/客队降温",
   "⚠️DC垃圾λ(斯洛伐克进5.75球)已按铁律剔除→改odds/Elo主导",
   "🔴弃:无意义热身、双方均轮换试阵、强度最不真,剔垃圾后无任何独立edge",
   "不投(最低价值热身)"],
];

const HEADER = ["序", "对阵", "赛事·重要性", "形势(首回合→累计)", "市场方向+赔率变化", "模型读数", "🎯针对性研判(理由)", "可投性裁决"];
const note = ["", "⚠️数据诚实声明", "所有内容无兜底:首回合赛果/重要性=Wikipedia J1百年构想联赛(本日抓);赔率/变化=500.com实时;模型概率=本日生产引擎(国际赛垃圾λ已按永久铁律剔除);国际赛性质=搜索核实。缺失:精确开赛时刻=多源冲突不可信故未采用、近期状态/伤停=免费源空缺,均标缺不臆造。诚实上限:免费数据打不过收盘线,本表价值=死签/轮换/动机情景识别+市场资金解读,非保证盈利。", "", "", "", "", ""];

const sheets = [
  { name: "深度分析", rows: [HEADER, ...rows, note] },
  { name: "核心结论", rows: [
    ["类别", "场次", "结论"],
    ["🔴 死签/低价值·弃", "鹿岛v神户 / 柏v京都 / 斯洛伐克v黑山", "累计已定的两回合死签(领先队轮换噪声)+ 最低价值热身赛。不投"],
    ["🟡 相对可信·可小注", "川崎v广岛(主胜·动机) / 加拿大v爱尔兰(客胜·资金) / 匈牙利v芬兰(主胜·友谊打折)", "有真实情景/资金支撑,但均留爆冷,小注"],
    ["🟠 抛硬币·缺验证", "町田v名古屋 / 横滨v清水 / 浦和v冈山", "真live定胜负场,但市场信号需近况/伤停验证而我无数据,不臆断"],
    ["", "", ""],
    ["诚实声明", "全部", "无兜底·无不可信值·缺失标缺;免费数据系统性打不过收盘线,不保证盈利,只给真实情景+市场解读,下注由你定"],
  ]},
];

const xlsxPath = join(OUT_DIR, "神选-深度分析-2026-06-06.xlsx");
writeXlsxWorkbook(xlsxPath, sheets);
console.log("✅ 深度分析xlsx:", xlsxPath);

// 手机页(简洁)
const cardHtml = rows.map(r => `
<div class="card">
  <div class="hd">${r[0]} · ${r[1]}</div>
  <div class="rk">${r[2]}</div>
  <div class="row"><b>形势</b> ${r[3]}</div>
  <div class="row"><b>市场</b> ${r[4]}</div>
  <div class="row"><b>模型</b> ${r[5]}</div>
  <div class="judge">${r[6]}</div>
  <div class="verdict">▶ ${r[7]}</div>
</div>`).join("");
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>神选深度分析 2026-06-06</title><style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;margin:0;padding:10px;font-size:14px}
h1{color:#f9a825;font-size:18px}.sub{color:#aaa;font-size:12px;margin-bottom:10px}
.card{background:#16213e;border:1px solid #4a148c;border-radius:10px;padding:12px;margin-bottom:12px}
.hd{font-weight:bold;font-size:15px;color:#fff;margin-bottom:4px}
.rk{color:#f9a825;font-size:12px;margin-bottom:6px}
.row{margin:4px 0;line-height:1.5}.row b{color:#90caf9}
.judge{margin-top:8px;padding:8px;background:#0f3460;border-radius:6px;line-height:1.6}
.verdict{margin-top:6px;font-weight:bold;color:#06d6a0}
.note{background:#3a1c1c;border:1px solid #b71c1c;border-radius:8px;padding:10px;font-size:12px;color:#ffcdd2;line-height:1.6;margin-top:10px}
</style></head><body>
<h1>⚡ 神选 · 无兜底深度分析</h1>
<div class="sub">2026-06-06 · 投资级·永久铁律(绝不兜底/绝不用不可信缺失数据)</div>
${cardHtml}
<div class="note">⚠️ 数据诚实声明:首回合赛果/重要性=Wikipedia J1百年构想联赛(本日抓)·赔率变化=500.com实时·模型=本日生产引擎(国际赛垃圾λ已剔除)。缺失项:精确开赛时刻(多源冲突·未采用)、近期状态/伤停(免费源空缺)=标缺不臆造。免费数据打不过收盘线,本表只给真实情景+市场解读,不保证盈利,下注由你定。</div>
</body></html>`;
const htmlPath = "D:\\Temp\\webshare_lingdao\\深度分析.html";
writeFileSync(htmlPath, html, "utf8");
console.log("✅ 手机页:", htmlPath, "→ http://172.16.0.240/深度分析.html");
