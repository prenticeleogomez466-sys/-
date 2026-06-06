// 深度竞彩推荐 v2(2026-06-06)——每玩法给主方向+次方向 + 比分/半全场逐场深度研判
// 数据真实可追溯:四玩法候选=本日生产引擎(国际赛垃圾λ已按永久铁律剔除);形势/重要性=Wikipedia
// J1百年构想联赛首回合赛果(本日抓);赔率变化=500实时。无兜底:缺失(开赛时刻/近况伤停)标缺不臆造。
// 比分/半全场深度研判=据真实情景(死签轮换/定胜负场主队拼劲/必须进球动机)对模型泊松输出做人工校读,
// 诚实标注模型未计入的情景。精确比分物理上限~13%、半全场~30%,深度框架改善解读但不保证命中。
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const live = JSON.parse(readFileSync("D:\\football-model-exports\\_live_simple.json", "utf8"));
const cands = JSON.parse(readFileSync("D:\\football-model-exports\\_cands.json", "utf8"));

// 从"主X%/平Y%/客Z%"取主方向+次方向
function wldTopTwo(probsStr) {
  const m = [...String(probsStr).matchAll(/(主|平|客)\s*([\d.]+)%/g)].map(x => ({ d: { 主: "主胜", 平: "平局", 客: "客胜" }[x[1]], p: +x[2] }));
  m.sort((a, b) => b.p - a.p);
  if (m.length < 2) return "—";
  return `主:${m[0].d}${m[0].p}% / 次:${m[1].d}${m[1].p}%`;
}
// 比分/半全场:取"首选 | 备 次选"→主+次
function topTwo(str, kind) {
  const s = String(str || "");
  const head = s.split("|")[0].trim();                 // 首选(含%)
  const bei = (s.match(/备\s*([^,·|]+)/) || [])[1];      // 第一个备选
  if (!bei) return head || "—";
  return `首选 ${head} / 次选 ${bei.trim()}`;
}

// 形势 + 比分半全场深度研判 + 裁决(tier 1可参考 2谨慎 3弃)
const deep = {
  "川崎前锋 vs 广岛三箭": { tier: 1, ctx: "4名次回合·首回合广岛2-1→川崎累计落后1球",
    sh: "川崎主场必须进球→压上开放,比分2-1/1-0+半全主-主逻辑最顺(动机驱动);留广岛客场反击进球",
    v: "🟡可参考 主胜方向(动机明确)" },
  "加拿大 vs 爱尔兰": { tier: 1, ctx: "世界杯热身·欧赔主队降温10%/客升温",
    sh: "资金弃加拿大→客胜小球;但友谊赛低进球+轮换→平局(1-1)风险高,次选该重视,别只押客胜",
    v: "🟡可参考 客胜方向(资金一致)" },
  "町田泽维亚 vs 名古屋鲸八": { tier: 2, ctx: "3名次回合·2-2→次回合定胜负",
    sh: "市场强推客胜;但定胜负场町田主场会拼,模型0-2(名古屋大胜2球)偏激进→更可能0-1/1-1。缺近况验证",
    v: "🟠谨慎 客胜(市场强但缺验证)" },
  "匈牙利 vs 芬兰": { tier: 2, ctx: "世界杯热身",
    sh: "剔垃圾λ后Elo+市场略主胜,比分1-0/2-0小胜;友谊赛轮换→平局也需防,半全主-主打折",
    v: "🟠谨慎 主胜(友谊打折)" },
  "横滨水手 vs 清水鼓动": { tier: 2, ctx: "8名次回合·1-1→次回合定",
    sh: "横滨主场被市场看衰(客50.7);定胜负场→90分钟平局(1-1,12%)概率被低估,别只看客胜小球",
    v: "🟠抛硬币偏客(缺验证)" },
  "浦和红钻 vs 冈山绿雉": { tier: 3, ctx: "6名次回合·1-1→次回合定",
    sh: "三向胶着(31/27/41);定胜负场1-1(13%)突出,无强信号,比分别赌单一方向",
    v: "🔴弃(胶着无edge)" },
  "鹿岛鹿角 vs 神户胜利船": { tier: 3, ctx: "冠军决赛次回合·首回合神户5-0→累计0-5",
    sh: "⚠️死签:神户已夺冠可能大轮换→模型客胜0-1高估神户,实际鹿岛主场可能不输,比分极不可测,别信",
    v: "🔴弃(死签+轮换噪声)" },
  "柏太阳神 vs 京都不死鸟": { tier: 3, ctx: "10名次回合·首回合柏6-2→累计领先4球",
    sh: "⚠️半全场信号自相矛盾(客-客20% vs 主-主21%几乎相等)=极不确定,柏可松懈轮换,死签别碰",
    v: "🔴弃(近死签)" },
  "斯洛伐克 vs 黑山": { tier: 3, ctx: "世界杯热身(双方均未进世界杯)",
    sh: "最低价值练兵,双方轮换试阵;剔垃圾λ后比分1-0小胜仅参考,强度最不真",
    v: "🔴弃(最低价值热身)" },
};

const order = Object.keys(deep).sort((a, b) => deep[a].tier - deep[b].tier);
const HEADER = ["对阵", "赛事·形势", "胜负平(主/次)", "比分(首选/次选)", "半全场(首选/次选)", "🎯比分·半全场深度研判", "裁决"];
const rows = order.map((nm) => {
  const c = cands[nm] || {}, l = live[nm] || {}, d = deep[nm];
  const wld = c.probs ? wldTopTwo(c.probs) : (l.wld || "—");
  return [nm, d.ctx, wld, topTwo(c.score, "score") || (l.score || "—"), topTwo(c.hf, "hf") || (l.hf || "—"), d.sh, d.v];
});

const summary = [
  ["分层", "场次", "说明"],
  ["🟡 可参考", order.filter(n => deep[n].tier === 1).map(n => n.split(" vs ")[0]).join("、"), "有真实情景/资金支撑,小注;比分/半全场已据动机深度校读"],
  ["🟠 谨慎", order.filter(n => deep[n].tier === 2).map(n => n.split(" vs ")[0]).join("、"), "有市场信号但缺近况/伤停验证;比分注意定胜负场平局风险"],
  ["🔴 弃", order.filter(n => deep[n].tier === 3).map(n => n.split(" vs ")[0]).join("、"), "死签(领先队轮换噪声)/最低价值热身;模型比分未计轮换,不可信"],
  ["", "", ""],
  ["⚠️诚实", "全部", "无兜底·缺失标缺(开赛时刻多源冲突/近况伤停免费源空缺均未采用);精确比分物理上限~13%、半全场~30%,深度框架改善解读不保证命中;免费数据打不过收盘线,下注由你定"],
];

const OUT = "D:\\football-model-exports\\深度竞彩_20260606";
mkdirSync(OUT, { recursive: true });
const xlsx = join(OUT, "神选-深度竞彩-2026-06-06.xlsx");
writeXlsxWorkbook(xlsx, [{ name: "深度竞彩", rows: [HEADER, ...rows] }, { name: "分层结论", rows: summary }]);
console.log("✅ xlsx:", xlsx);

const tc = { 1: "#06d6a0", 2: "#ffd166", 3: "#ef476f" };
const cardHtml = order.map((nm) => {
  const c = cands[nm] || {}, l = live[nm] || {}, d = deep[nm];
  const wld = c.probs ? wldTopTwo(c.probs) : (l.wld || "—");
  return `<div class="card" style="border-left:5px solid ${tc[d.tier]}">
  <div class="hd">${nm}</div><div class="ctx">${d.ctx}</div>
  <div class="g"><span>胜负平</span>${wld}</div>
  <div class="g"><span>比分</span>${topTwo(c.score, "score")}</div>
  <div class="g"><span>半全场</span>${topTwo(c.hf, "hf")}</div>
  <div class="sh">🎯 ${d.sh}</div>
  <div class="v">${d.v}</div></div>`;
}).join("");
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>神选深度竞彩 06-06</title><style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;margin:0;padding:10px;font-size:14px}
h1{color:#f9a825;font-size:18px;margin:4px 0}.sub{color:#aaa;font-size:12px;margin-bottom:10px}
.card{background:#16213e;border-radius:10px;padding:12px;margin-bottom:11px}
.hd{font-weight:bold;font-size:15px;color:#fff}.ctx{color:#f9a825;font-size:11px;margin:3px 0 7px}
.g{margin:4px 0;line-height:1.5}.g span{color:#90caf9;margin-right:6px;font-weight:bold}
.sh{margin-top:7px;padding:7px;background:#0f3460;border-radius:6px;line-height:1.55;font-size:13px}
.v{margin-top:5px;font-weight:bold;color:#06d6a0}
.note{background:#3a1c1c;border:1px solid #b71c1c;border-radius:8px;padding:10px;font-size:12px;color:#ffcdd2;line-height:1.6}
</style></head><body>
<h1>⚡ 神选 · 深度竞彩 2026-06-06</h1>
<div class="sub">投资级·永久铁律(无兜底)·每玩法主+次方向·比分半全场逐场深度校读·按可参考→弃排序·今日无14场</div>
${cardHtml}
<div class="note">⚠️ 比分/半全场深度研判=据真实情景(死签轮换/定胜负场主队拼劲/必须进球动机)对模型泊松做人工校读,诚实标注模型未计入项。缺失:开赛时刻(多源冲突)、近况/伤停(免费源空缺)=标缺不臆造。精确比分上限~13%、半全场~30%,深度改善解读不保证命中。免费数据打不过收盘线,下注由你定。</div>
</body></html>`;
writeFileSync("D:\\Temp\\webshare_lingdao\\jingcai0606.html", html, "utf8");
console.log("✅ 手机页: http://172.16.0.240/jingcai0606.html");
