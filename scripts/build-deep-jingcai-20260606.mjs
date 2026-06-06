// 综合深度竞彩(2026-06-06 v3)——按比赛时间排序·全面真实因素·美化排版
// 真实数据全部本session抓取可追溯:开赛时间/近5状态/H2H=ESPN(jpn.1 scoreboard+team schedule+summary);
// 淘汰赛形势/重要性=Wikipedia J1百年构想联赛;阵容=ESPN实时roster;四玩法候选=本日生产引擎(垃圾λ已剔);
// 市场赔率=500实时。永久铁律:无兜底,缺失(未出阵容/拿不到风格)标缺不臆造。
// 综合研判=人工据上述真实因素校读模型,form/H2H纠正了纯市场倾向。诚实:精确比分~13%/半全场~30%上限,
// 免费数据打不过收盘线,不保证盈利。3场国际赛已开赛(00:30/01:45/07:30)不可投,本表只列6场可投日职。
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const cands = JSON.parse(readFileSync("D:\\football-model-exports\\_cands.json", "utf8"));
const wldTop2 = (s) => { const m = [...String(s).matchAll(/(主|平|客)\s*([\d.]+)%/g)].map(x => ({ d: { 主: "主胜", 平: "平", 客: "客胜" }[x[1]], p: +x[2] })); m.sort((a, b) => b.p - a.p); return m.length < 2 ? "—" : `${m[0].d}${m[0].p}% / ${m[1].d}${m[1].p}%`; };
const sc2 = (s) => { const h = String(s || "").split("|")[0].trim(); const b = (String(s).match(/备\s*([^,·|]+)/) || [])[1]; return b ? `${h} / ${b.trim()}` : (h || "—"); };

// 6场日职(按北京开赛时间排序),全部真实数据 + 综合研判 + 裁决(tier 1可参考 2谨慎 3观望)
const M = [
  { t: "13:00", nm: "鹿岛鹿角 vs 神户胜利船", cd: "鹿岛鹿角 vs 神户胜利船",
    ctx: "冠军决赛次回合·累计鹿岛0-5(神户已晋级锁定)", form: "鹿岛 胜胜胜胜平(4胜1平·火热) / 神户 胜胜负胜平",
    h2h: "近3次 5-0(首回合异常) · 0-0 · 1-0(鹿岛历史不怵神户)", lineup: "✅神户摆全主力(大迫+武藤+酒井+权田,4-3-3);鹿岛4-4-2亦全主力",
    judge: "死签但鹿岛主场火热(4胜1平)+H2H历史0-0/1-0不输神户→市场客胜48.7%高估神户;神户全主力要面子,单场实际接近,别盲跟高客胜", tier: 2, v: "🟠谨慎:鹿岛受让/平局被低估,客胜别重注" },
  { t: "14:00", nm: "町田泽维亚 vs 名古屋鲸八", cd: "町田泽维亚 vs 名古屋鲸八",
    ctx: "3名次回合·累计2-2(次回合定胜负·真live)", form: "町田 胜胜平平胜(4场不败·好) / 名古屋 胜平负平胜(一般)",
    h2h: "近3次 2-2 · 3-1 · 1-2(互有胜负)", lineup: "未出(赛前1h)",
    judge: "市场强推客胜55.7%,但町田主场+近4场不败状态明显好于名古屋→市场客胜与町田状态相左,可疑;别盲跟客,町田主场不败可期", tier: 2, v: "🟠存疑:市场看客,町田状态实占优,谨慎" },
  { t: "15:00", nm: "浦和红钻 vs 冈山绿雉", cd: "浦和红钻 vs 冈山绿雉",
    ctx: "6名次回合·累计1-1(次回合定)", form: "浦和 胜负胜平胜(好) / 冈山 胜平负平平(一般)",
    h2h: "近3次 1-1 · 0-1 · 1-0(接近,冈山赢过浦和)", lineup: "未出",
    judge: "浦和主场+近况略好,但H2H冈山客场赢过(0-1)不怵;市场略偏客41.5无强据→真抛硬币,主胜次方向有价值", tier: 3, v: "🟠抛硬币:接近,无强edge,观望为主" },
  { t: "16:00", nm: "横滨水手 vs 清水鼓动", cd: "横滨水手 vs 清水鼓动",
    ctx: "8名次回合·累计1-1(次回合定)", form: "横滨 负胜负负负(1胜4负·差!) / 清水 平平胜平负(一般)",
    h2h: "近3次 1-1 · 1-3 · 2-3(清水客场赢过横滨)", lineup: "未出",
    judge: "★三重验证一致:横滨近5场1胜4负状态差 + H2H清水客场1-3/2-3赢过横滨 + 市场客胜50.7%→清水客胜有真实支撑(非纯跟市场)", tier: 1, v: "🟡可参考·客胜(状态+H2H+市场三验证)" },
  { t: "17:00", nm: "柏太阳神 vs 京都不死鸟", cd: "柏太阳神 vs 京都不死鸟",
    ctx: "10名次回合·累计柏领先4球(6-2·近死签)", form: "柏 负胜负负负(1胜4负·差!) / 京都 负胜胜平平(回升)",
    h2h: "近3次 2-6(首回合) · 3-3 · 1-1", lineup: "未出",
    judge: "柏近5场1胜4负状态差+累计领先4球可松懈轮换+京都状态回升→京都客胜有据;但死签变数大、半全场信号矛盾(客-客20%vs主-主21%)", tier: 2, v: "🟠偏客:柏差+松懈利京都,死签谨慎" },
  { t: "18:00", nm: "川崎前锋 vs 广岛三箭", cd: "川崎前锋 vs 广岛三箭",
    ctx: "4名次回合·累计川崎落后1球(广岛2-1·主场需扳)", form: "川崎 负平负平胜(一般) / 广岛 胜负胜平胜(好)",
    h2h: "近3次 2-1 · 1-2 · 1-2(广岛近年常胜川崎!)", lineup: "未出",
    judge: "川崎主场+必须进球(动机)→市场主胜48.7;但广岛近况好+H2H近3次2胜1负压制川崎→主胜没那么稳,留广岛客场反击;别盲跟主", tier: 2, v: "🟠存疑:川崎动机vs广岛H2H压制,谨慎" },
];

const HEADER = ["开赛", "对阵", "赛事·形势", "近5场状态", "H2H交锋", "阵容", "胜负平(主/次)", "比分(首/次)", "半全场(首/次)", "🎯综合研判", "裁决"];
const rows = M.map(m => { const c = cands[m.cd] || {}; return [m.t, m.nm, m.ctx, m.form, m.h2h, m.lineup, c.probs ? wldTop2(c.probs) : "—", sc2(c.score), sc2(c.hf), m.judge, m.v]; });

const summary = [
  ["分层", "场次(按时间)", "说明"],
  ["🟡 可参考", M.filter(m => m.tier === 1).map(m => `${m.t} ${m.nm.split(" vs ")[0]}`).join("、") || "—", "近5状态+H2H+市场三重一致才入此档(横滨v清水客胜)"],
  ["🟠 谨慎/存疑", M.filter(m => m.tier === 2).map(m => `${m.t} ${m.nm.split(" vs ")[0]}`).join("、"), "form/H2H纠正了纯市场倾向(鹿岛火热/町田状态好/川崎被广岛H2H压制),信号相左不重注"],
  ["🟠 抛硬币", M.filter(m => m.tier === 3).map(m => `${m.t} ${m.nm.split(" vs ")[0]}`).join("、"), "接近无强edge,观望"],
  ["", "", ""],
  ["⛔ 已不可投", "斯洛伐克v黑山(00:30) / 匈牙利v芬兰(01:45) / 加拿大v爱尔兰(07:30)", "3场国际赛=世界杯热身,北京时间凌晨已开赛/完场,竞彩已停售,不再推荐"],
  ["", "", ""],
  ["⚠️诚实", "全部", "全面因素已覆盖:开赛时间/近5状态/H2H/淘汰赛形势/阵容(仅鹿岛-神户已出,其余赛前1h)/DC强度/市场赔率。缺失(打法风格=免费无事件数据/8场阵容未出)标缺不臆造。精确比分~13%/半全场~30%上限,免费数据打不过收盘线,不保证盈利,下注由你定"],
];

const OUT = "D:\\football-model-exports\\深度竞彩_20260606";
mkdirSync(OUT, { recursive: true });
const xlsx = join(OUT, "神选-深度竞彩-2026-06-06.xlsx");
writeXlsxWorkbook(xlsx, [{ name: "深度竞彩", rows: [HEADER, ...rows] }, { name: "分层结论", rows: summary }]);
console.log("✅ xlsx:", xlsx);

const tc = { 1: "#06d6a0", 2: "#ffd166", 3: "#90a4ae" };
const cards = M.map(m => { const c = cands[m.cd] || {};
  return `<div class="card" style="border-left:5px solid ${tc[m.tier]}">
  <div class="hd"><span class="time">${m.t}</span> ${m.nm}</div>
  <div class="ctx">${m.ctx}</div>
  <div class="r"><span>近5</span>${m.form}</div>
  <div class="r"><span>H2H</span>${m.h2h}</div>
  <div class="r"><span>阵容</span>${m.lineup}</div>
  <div class="plays"><div><span>胜负平</span>${c.probs ? wldTop2(c.probs) : "—"}</div><div><span>比分</span>${sc2(c.score)}</div><div><span>半全</span>${sc2(c.hf)}</div></div>
  <div class="judge">🎯 ${m.judge}</div>
  <div class="v">${m.v}</div></div>`;
}).join("");
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>神选综合深度竞彩 06-06</title><style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:linear-gradient(160deg,#0f1024,#1a1a2e);color:#eee;margin:0;padding:12px;font-size:14px}
h1{color:#f9a825;font-size:19px;margin:2px 0}.sub{color:#9aa;font-size:12px;margin-bottom:12px;line-height:1.5}
.card{background:#16213e;border-radius:12px;padding:13px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.hd{font-weight:bold;font-size:15px;color:#fff;margin-bottom:3px}.time{background:#f9a825;color:#1a1a2e;border-radius:5px;padding:1px 7px;font-size:13px;margin-right:6px}
.ctx{color:#f9a825;font-size:11px;margin-bottom:7px}
.r{margin:4px 0;line-height:1.5;font-size:13px}.r span{display:inline-block;width:42px;color:#90caf9;font-weight:bold}
.plays{display:flex;gap:8px;flex-wrap:wrap;margin:7px 0;background:#0d1b34;border-radius:7px;padding:7px}
.plays div{font-size:12.5px}.plays span{color:#90caf9;font-weight:bold;margin-right:3px}
.judge{margin-top:7px;padding:8px;background:#0f3460;border-radius:7px;line-height:1.6;font-size:13px}
.v{margin-top:6px;font-weight:bold;color:#06d6a0;font-size:14px}
.note{background:#3a1c1c;border:1px solid #b71c1c;border-radius:9px;padding:11px;font-size:12px;color:#ffcdd2;line-height:1.65}
.gone{background:#222;border-radius:8px;padding:9px;font-size:12px;color:#888;margin-bottom:12px}
</style></head><body>
<h1>⚡ 神选 · 综合深度竞彩</h1>
<div class="sub">2026-06-06 · 按开赛时间排序 · 全面真实因素(状态/H2H/阵容/形势/赔率) · 永久铁律无兜底 · 投资级</div>
<div class="gone">⛔ 3场国际赛(斯洛伐克/匈牙利/加拿大)凌晨00:30~07:30已开赛完场,竞彩停售,不再推荐</div>
${cards}
<div class="note">⚠️ 已覆盖:真实开赛时间·近5场状态·H2H·淘汰赛形势·阵容(仅13:00鹿岛-神户已出,其余赛前1h公布→自动重分析)·DC历史强度·市场赔率。缺失(打法风格=免费无事件级数据)标缺不臆造。form/H2H已纠正纯市场倾向(鹿岛火热/町田状态好/川崎被广岛H2H压制)。精确比分~13%、半全场~30%上限,免费数据打不过收盘线,不保证盈利,下注由你定。</div>
</body></html>`;
writeFileSync("D:\\Temp\\webshare_lingdao\\jingcai0606.html", html, "utf8");
console.log("✅ 手机页: http://172.16.0.240/jingcai0606.html");
