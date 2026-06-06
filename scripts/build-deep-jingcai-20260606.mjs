// 深度竞彩推荐(2026-06-06)——四玩法(本日live生产引擎,国际赛垃圾λ已按永久铁律剔除)
// × 深度情报(J1百年构想首回合赛果/累计/重要性=Wikipedia本日抓;国际赛=世界杯热身核实;赔率变化=500实时)
// 合成一张表,按"可参考→谨慎→弃"排序。无兜底:缺失(开赛时刻/近况伤停)标缺不臆造。免费数据打不过收盘线,不保证盈利。
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const live = JSON.parse(readFileSync("D:\\football-model-exports\\_live_simple.json", "utf8"));
const g = (name) => live[name] || {};

// 深度裁决(tier: 1可参考 2谨慎 3弃)+ 形势 + 理由,人工据真实情报合成
const deep = {
  "川崎前锋 vs 广岛三箭": { tier: 1, ctx: "百年构想·4名次回合｜首回合广岛2-1→川崎累计落后1球", verdict: "🟡可参考 主胜方向：川崎主场+累计落后必须进球→动机明确,非纯跟市场。留广岛客场进球爆冷" },
  "加拿大 vs 爱尔兰": { tier: 1, ctx: "世界杯热身｜加拿大东道主备战/爱尔兰未进", verdict: "🟡可参考 客胜(爱尔兰)：欧赔主队降温10%+客队升温6%,资金明确弃加拿大→与客胜47.7%一致。热身打折" },
  "町田泽维亚 vs 名古屋鲸八": { tier: 2, ctx: "百年构想·3名次回合｜首回合2-2→次回合定胜负(真live)", verdict: "🟠谨慎 客胜(名古屋)：市场异常强推客55.7%(模型最高信心53),但町田主场反被看衰=通常含近况/伤停信息,而我无数据独立验证→只跟市场信号、不加码" },
  "匈牙利 vs 芬兰": { tier: 2, ctx: "世界杯热身赛", verdict: "🟠谨慎 主胜：剔垃圾λ后Elo+市场略主胜(主场),但友谊赛轮换试阵、强度不真,信心打折小注" },
  "横滨水手 vs 清水鼓动": { tier: 2, ctx: "百年构想·8名次回合｜首回合1-1→次回合定(真live)", verdict: "🟠抛硬币偏客：真定胜负场,横滨主场被市场看衰(客50.7),但缺近况验证,不重注" },
  "浦和红钻 vs 冈山绿雉": { tier: 3, ctx: "百年构想·6名次回合｜首回合1-1→次回合定", verdict: "🔴弃：三项概率31/27/41胶着,无强信号无edge无验证" },
  "鹿岛鹿角 vs 神户胜利船": { tier: 3, ctx: "百年构想·冠军决赛次回合｜首回合神户5-0→累计鹿岛0-5", verdict: "🔴弃：死签(神户已夺冠锁AFC),神户无欲无求轮换风险高、鹿岛拼荣誉,结果噪声大" },
  "柏太阳神 vs 京都不死鸟": { tier: 3, ctx: "百年构想·10名次回合｜首回合柏6-2→柏累计领先4球", verdict: "🔴弃：近死签,柏可松懈轮换,京都自由发挥,市场已反映(客>主),噪声场" },
  "斯洛伐克 vs 黑山": { tier: 3, ctx: "世界杯热身｜双方均未进世界杯", verdict: "🔴弃：最低价值练兵,双方轮换试阵,剔垃圾后无任何独立edge" },
};

const order = Object.keys(deep).sort((a, b) => deep[a].tier - deep[b].tier);
const HEADER = ["对阵", "赛事·形势", "胜负平", "让胜负平", "比分", "半全场", "信心", "🎯深度裁决"];
const rows = order.map((nm) => {
  const m = g(nm), d = deep[nm];
  return [nm, d.ctx, m.wld || "—", (m.hcp || "—").replace(/（让.*$/, "").trim(), m.score || "—", m.hf || "—", (m.conf || "—").split("·")[0].trim(), d.verdict];
});

const tierCount = { 1: 0, 2: 0, 3: 0 };
order.forEach((n) => tierCount[deep[n].tier]++);
const summary = [
  ["分层", "场次", "说明"],
  [`🟡 可参考(${tierCount[1]})`, order.filter(n => deep[n].tier === 1).map(n => n.split(" vs ")[0]).join("、"), "有真实情景/资金支撑(动机·资金流向),小注;留爆冷"],
  [`🟠 谨慎(${tierCount[2]})`, order.filter(n => deep[n].tier === 2).map(n => n.split(" vs ")[0]).join("、"), "真live场或市场有信号,但缺近况/伤停独立验证,不加码"],
  [`🔴 弃(${tierCount[3]})`, order.filter(n => deep[n].tier === 3).map(n => n.split(" vs ")[0]).join("、"), "两回合死签(领先队轮换噪声)/最低价值热身,不投"],
  ["", "", ""],
  ["⚠️诚实声明", "全部", "无兜底·无不可信值·缺失标缺;开赛时刻多源冲突未采用、近况/伤停免费源空缺;免费数据打不过收盘线,本表价值=死签/动机/资金情景识别,不保证盈利,下注由你定"],
];

const OUT = "D:\\football-model-exports\\深度竞彩_20260606";
mkdirSync(OUT, { recursive: true });
const xlsx = join(OUT, "神选-深度竞彩-2026-06-06.xlsx");
writeXlsxWorkbook(xlsx, [{ name: "深度竞彩", rows: [HEADER, ...rows] }, { name: "分层结论", rows: summary }]);
console.log("✅ xlsx:", xlsx);

const tierColor = { 1: "#06d6a0", 2: "#ffd166", 3: "#ef476f" };
const cards = order.map((nm) => {
  const m = g(nm), d = deep[nm];
  return `<div class="card" style="border-left:5px solid ${tierColor[d.tier]}">
  <div class="hd">${nm}</div><div class="ctx">${d.ctx}</div>
  <div class="g"><span>胜负平</span><b>${m.wld || "—"}</b></div>
  <div class="g"><span>让胜负平</span>${(m.hcp || "—").replace(/（让.*$/, "")}</div>
  <div class="g"><span>比分</span>${m.score || "—"} &nbsp; <span>半全场</span>${m.hf || "—"}</div>
  <div class="g"><span>信心</span>${(m.conf || "—").split("·")[0]}</div>
  <div class="v">${d.verdict}</div></div>`;
}).join("");
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>神选深度竞彩 06-06</title><style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;margin:0;padding:10px;font-size:14px}
h1{color:#f9a825;font-size:18px;margin:4px 0}.sub{color:#aaa;font-size:12px;margin-bottom:10px}
.card{background:#16213e;border-radius:10px;padding:12px;margin-bottom:11px}
.hd{font-weight:bold;font-size:15px;color:#fff}.ctx{color:#f9a825;font-size:11px;margin:3px 0 7px}
.g{margin:3px 0;line-height:1.5}.g span{color:#90caf9;margin-right:4px}.g b{color:#fff}
.v{margin-top:7px;padding:7px;background:#0f3460;border-radius:6px;line-height:1.55}
.note{background:#3a1c1c;border:1px solid #b71c1c;border-radius:8px;padding:10px;font-size:12px;color:#ffcdd2;line-height:1.6}
</style></head><body>
<h1>⚡ 神选 · 深度竞彩 2026-06-06</h1>
<div class="sub">投资级·永久铁律(无兜底/不用不可信缺失数据)·按可参考→谨慎→弃排序 · 今日无官方14场</div>
${cards}
<div class="note">⚠️ 无兜底声明:四玩法=本日生产引擎(国际赛垃圾λ已剔);形势/重要性=Wikipedia J1百年构想联赛(本日抓);赔率变化=500实时。缺失:开赛时刻(多源冲突·未用)、近况/伤停(免费源空缺)=标缺不臆造。免费数据打不过收盘线,本表只给真实情景+市场解读,不保证盈利,下注由你定。</div>
</body></html>`;
writeFileSync("D:\\Temp\\webshare_lingdao\\jingcai0606.html", html, "utf8");
console.log("✅ 手机页: http://172.16.0.240/jingcai0606.html");
