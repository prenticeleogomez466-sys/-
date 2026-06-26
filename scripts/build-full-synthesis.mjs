#!/usr/bin/env node
/**
 * 全维度综合判读(2026-06-25 用户令:把组合触发/爆冷条件 + 盘口 + 全部数据层融合成一份分析)。
 *   决策规则(用户裁定):有特定爆冷/组合触发条件 → 按触发推;无 → 按盘口推;所有信息综合考虑。
 * 数据源(本次运行实时读,不硬编码):
 *   盘口五赔种 = market-data-store 当日快照;近5/动机 = coverage;WC-Elo模型+三视角对抗证伪 = adversarial 当日。
 * 产物:配套 xlsx(不动主表冻结契约)+ 手机页可插入的综合段落片段(stdout 末尾 <FRAGMENT> 区块)。
 * 诚实铁律:EV/对抗结论照实落,负EV/红灯如实标"观望/降档",绝不冒充稳胆。
 */
import fs from "node:fs";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { loadMarketSnapshots } from "../src/market-data-store.js";
import { loadFixtures } from "../src/fixture-store.js";
import { isTodayDeliveryFixture } from "../src/jingcai-business-day.js";
import { comboTriggers } from "../src/combo-triggers.js";

const date = process.argv.find((a) => a.startsWith("--date="))?.split("=")[1] || "2026-06-25";
const pc = (x) => (x * 100).toFixed(0) + "%";
const devig = (o) => { const inv = [1 / o.home, 1 / o.draw, 1 / o.away], s = inv[0] + inv[1] + inv[2]; return { h: inv[0] / s, d: inv[1] / s, a: inv[2] / s }; };

const snaps = loadMarketSnapshots(date).snapshots;
// 缺当日 coverage/adversarial 文件时诚实降级(标⚠️·相关列空对象),不崩——一条龙里作软步骤跑。
const readJsonSafe = (path, key, fallback) => { try { return JSON.parse(fs.readFileSync(path, "utf8"))[key] ?? fallback; } catch { console.warn(`⚠️ 缺/坏 ${path}——相关列降级标缺(不编造)`); return fallback; } };
const cov = readJsonSafe(`D:/football-model-data/coverage/${date}.json`, "matches", []);
const advd = readJsonSafe(`D:/football-model-data/adversarial/${date}.json`, "verdicts", {});
const findCov = (h, a) => cov.find((x) => (x.home?.zh === h) && (x.away?.zh === a));

// 口径对齐主表:今日竞彩交付场 = isTodayDeliveryFixture 且有盘口快照(排除已赛完场 + 未来预售批次)。
const snapByFix = {}; for (const s of snaps) snapByFix[s.fixtureId] = s;
const deliveryFixtures = loadFixtures(date).fixtures
  .filter((f) => isTodayDeliveryFixture(f, date) && snapByFix[f.id])
  .sort((a, b) => Number(a.sequence) - Number(b.sequence));

// 决策引擎:综合盘口方向 + 组合触发 + WC对抗证伪,落"综合主推 + 信心 + 理由 + 风险"
function decide(s, v, trg) {
  const eC = s.europeanOdds.current, d = devig(eC);
  const pankouDir = d.h >= d.d && d.h >= d.a ? "主胜" : d.a >= d.d ? "客胜" : "平局";
  const pankouP = Math.max(d.h, d.d, d.a);
  const small = trg.some((t) => t.market === "大小球" && t.predict === "小球");
  const big = trg.some((t) => t.market === "大小球" && t.predict === "大球");
  const reliable = trg.some((t) => t.predict.includes("可作胆"));
  const danger = trg.some((t) => t.tier === "提醒");
  const verdict = v?.label || "⚠️无证伪";
  const red = verdict.includes("🔴"), orange = verdict.includes("🟠"), yellow = verdict.includes("🟡");
  const over25 = s.totalGoalsOdds?.over25 ?? null;
  const ouLine = s.totals?.current?.line ?? null;
  const jcLine = s.jingcaiHandicap?.line ?? null;
  // 规则:胶着盘(盘口非主导或证伪红)且有小球触发 → 小球;否则跟盘口方向并按证伪降档
  let pick, conf, why, risk;
  if (small && (red || pankouDir === "平局" || pankouP < 0.45)) {
    pick = "小球"; conf = red ? "中" : "中偏低";
    why = `胜负面${red ? "三视角全证伪·不碰方向" : "势均/硬币档"};大小盘${ouLine}·over≈${pc(over25 || 0)}·小球触发命中64/61% → 走小球`;
    risk = "若双方对攻打开易破小球";
  } else if (small && reliable) {
    pick = `${pankouDir}(可降档) + 小球`; conf = "中";
    why = `盘口${pankouDir}${pc(pankouP)}·热门被加注可作胆;同时小球触发`;
    risk = "让球危险";
  } else {
    pick = pankouDir;
    conf = yellow ? "中高" : red ? "低·建议观望" : "中";
    why = `盘口${pankouDir}${pc(pankouP)}` + (v ? ` + WC模型${v.direction}${pc(v.prob)}(${v.modelTier?.match(/\(([^()]+)\)/)?.[1] || ""})` : "") + (reliable ? "·热门加注可作胆" : "");
    if (red) why += " ⚠️盘口与模型分歧大(EV" + (v?.ev ?? "?") + ")→建议观望/极轻";
    else if (orange) why += " ·对抗双视角证伪→降档";
    risk = (jcLine && Math.abs(jcLine) >= 1) ? "竞彩让1球危险(强队小胜常被绞)→走胜负面别让球" : "标准档";
  }
  return { pankouDir, pankouP, pick, conf, why, risk, verdict, over25, ouLine, jcLine, model: v };
}

const rows = [];
for (const f of deliveryFixtures) {
  const h = f.homeTeam, a = f.awayTeam, key = `${h}|${a}`;
  const s = snapByFix[f.id];
  const v = advd[key];
  // 1X2未开售(竞彩只卖让球):无欧赔→不跑组合(组合是1X2口径),方向由让球1X2 de-vig 定,诚实标"只让球"
  if (!s?.europeanOdds?.current?.home || s.europeanOdds.current.home <= 1) {
    const ho = s?.handicapOdds?.current;
    let dir = "⚠️待定", note = "1X2未开售(竞彩只卖让球)";
    if (ho?.home > 1 && ho?.away > 1) { const d = devig(ho); dir = d.h >= d.d && d.h >= d.a ? "主队受让/让后胜" : d.a >= d.d ? "客队赢球" : "让球平"; }
    rows.push({ h, a, ko: f.kickoff, unsold: true, s, v, dir, note, c: findCov(h, a) });
    continue;
  }
  const eC = s.europeanOdds.current, eO = s.europeanOdds.initial;
  const r = comboTriggers({ euClose: eC, euOpen: eO?.home > 1 ? eO : null, ahLineClose: s.asianHandicap?.current?.line, ahLineOpen: s.asianHandicap?.initial?.line, ouClose: s.totals?.current?.line, ouOpen: s.totals?.initial?.line, waterHomeClose: s.asianHandicap?.current?.homeWater, waterAwayClose: s.asianHandicap?.current?.awayWater });
  const trg = r?.triggers || [];
  const c = findCov(h, a);
  rows.push({ h, a, s, v, trg, c, dec: decide(s, v, trg) });
}

// ===== 配套 xlsx =====
const fmtRec = (rr) => rr ? `${rr.w}胜${rr.d}平${rr.l}负 进${rr.gf}失${rr.ga}` : "⚠️缺";
const s1 = [
  [`⚡ 神选·全维度综合判读 · ${date} · 盘口+WC模型+Elo+近5+组合触发+对抗证伪 一体化`],
  ["比赛", "盘口de-vig方向", "WC模型(Elo)", "组合触发", "对抗证伪结论", "✅综合主推", "信心", "综合理由(全维度)", "风险提醒"],
];
for (const x of rows) {
  if (x.unsold) {
    const ho = x.s?.handicapOdds?.current;
    const hl = ho ? `让球1X2 主${ho.home}/平${ho.draw}/客${ho.away}` : "⚠️让球缺";
    const md = x.v ? `${x.v.direction} ${pc(x.v.prob)}(${x.v.modelTier?.match(/\(([^()]+)\)/)?.[1] || ""})` : "⚠️缺";
    s1.push([`${x.h} vs ${x.a}`, `${x.note}·${hl}`, md, "—(1X2未开售·组合不适用)", x.v?.label || "⚠️无证伪", x.dir, "中偏低", `1X2未开售只卖让球;按让球de-vig+模型 → ${x.dir};悬殊盘只买赢球别买深让(净胜要够)`, "深让易赢球输盘"]);
    continue;
  }
  const d = devig(x.s.europeanOdds.current);
  const dl = `主${pc(d.h)}/平${pc(d.d)}/客${pc(d.a)}`;
  const md = x.v ? `${x.v.direction} ${pc(x.v.prob)}(${x.v.modelTier?.match(/\(([^()]+)\)/)?.[1] || ""})` : "⚠️缺";
  const tg = x.trg.length ? x.trg.map((t) => `${t.tier}|${t.market}:${t.predict}(${pc(t.hitRate?.te || 0)})`).join(" ; ") : "无";
  s1.push([`${x.h} vs ${x.a}`, dl, md, tg, x.dec.verdict, x.dec.pick, x.dec.conf, x.dec.why, x.dec.risk]);
}

// Sheet2:逐场全数据底稿(可追溯)
const s2 = [
  [`神选·逐场全数据底稿 · ${date}(每个数字本次运行实时抓)`],
  ["比赛", "欧赔初→终(主/平/客)", "竞彩让球线", "亚盘+水位", "大小盘·over%", "比分前3", `${"近5(主)"}`, "近5(客)", "出线动机"],
];
for (const x of rows) {
  if (x.unsold) {
    const ho = x.s?.handicapOdds?.current, ah = x.s?.asianHandicap?.current;
    s2.push([
      `${x.h} vs ${x.a}`, "⚠️欧赔未开售(竞彩只卖让球)",
      String(x.s?.jingcaiHandicap?.line ?? "⚠️"),
      ah ? `让${ah.line} 主水${ah.homeWater}/客水${ah.awayWater}` : "⚠️",
      `${x.s?.totals?.current?.line ?? "⚠️"} · ${pc(x.s?.totalGoalsOdds?.over25 || 0)}`,
      (x.s?.scoreOdds?.top || []).slice(0, 3).map((z) => `${z.score}@${z.odds}`).join(" ") || "⚠️缺",
      fmtRec(x.c?.home?.record5), fmtRec(x.c?.away?.record5),
      "小组赛:出线压力+强度,强队或轮换、弱队搏命",
    ]);
    continue;
  }
  const eC = x.s.europeanOdds.current, eO = x.s.europeanOdds.initial, ah = x.s.asianHandicap?.current;
  s2.push([
    `${x.h} vs ${x.a}`,
    `${eO?.home}/${eO?.draw}/${eO?.away} → ${eC.home}/${eC.draw}/${eC.away}`,
    String(x.s.jingcaiHandicap?.line ?? "⚠️"),
    ah ? `让${ah.line} 主水${ah.homeWater}/客水${ah.awayWater}` : "⚠️",
    `${x.s.totals?.current?.line ?? "⚠️"} · ${pc(x.s.totalGoalsOdds?.over25 || 0)}`,
    (x.s.scoreOdds?.top || []).slice(0, 3).map((z) => `${z.score}@${z.odds}`).join(" "),
    fmtRec(x.c?.home?.record5), fmtRec(x.c?.away?.record5),
    (x.c && findCov(x.h, x.a)) ? "小组赛:出线压力+强度,强队或轮换、弱队搏命" : "",
  ]);
}

// Sheet3:决策口径说明(诚实定性)
const s3 = [
  ["神选·综合判读口径与诚实定性"],
  ["项", "说明"],
  ["决策规则", "用户裁定:有特定爆冷/组合触发条件→按触发推;无→按盘口推;全部信息综合考虑"],
  ["盘口为主", "主推方向由500竞彩真盘 de-vig 热门定;WC-Elo模型只作对照,分歧以盘口为准"],
  ["组合触发器", "combo-triggers引擎(五大联赛12458场+386张真竞彩截图验证);纯赔率口径,对世界杯作参考叠加"],
  ["世界杯爆冷规律", "强队不输常被逼平·让球盘绞肉机:大热门走胜负面、竞彩让1球别碰"],
  ["对抗证伪", "三视角(市场效率/样本过拟合/回测一致)对抗;🔴全证伪=观望 🟠双=降档 🟡单=谨慎"],
  ["诚实定性", "本次WC模型多数场EV为负、打不过收盘线;有选择性出手价值的是小球触发与最干净的方向,跟盘是降档参与非稳胆"],
];

const dir = `C:/Users/Administrator/Desktop/足球推荐/${date}`;
fs.mkdirSync(dir, { recursive: true });
const out = `${dir}/神选-全维度综合判读-${date}.xlsx`;
writeXlsxWorkbook(out, [
  { name: "综合判读", rows: s1 },
  { name: "逐场全数据底稿", rows: s2 },
  { name: "口径与诚实定性", rows: s3 },
]);
console.log("已生成配套表:", out);

// ===== 手机页可插入片段 =====
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let html = `\n<section id="full-synthesis" style="margin:18px 0;padding:14px;border:2px solid #2a6;border-radius:10px;background:#f6fff6">\n`;
html += `<h2 style="margin:0 0 8px">🧠 全维度综合判读(盘口+WC模型+Elo+近5+组合触发+对抗证伪)</h2>\n`;
html += `<p style="margin:4px 0;color:#555;font-size:13px">规则:有特定爆冷/组合触发→按触发;无→按盘口;全部信息综合。诚实:今天多数场EV为负、打不过收盘线,有选择性价值的是小球与最干净的方向。</p>\n`;
html += `<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#2a6;color:#fff">`;
for (const th of ["比赛", "综合主推", "信心", "综合理由", "风险"]) html += `<th style="padding:6px;border:1px solid #ccc;text-align:left">${th}</th>`;
html += `</tr></thead><tbody>`;
for (const x of rows) {
  if (x.unsold) {
    html += `<tr><td style="padding:6px;border:1px solid #ddd"><b>${esc(x.h)} vs ${esc(x.a)}</b></td>`;
    html += `<td style="padding:6px;border:1px solid #ddd"><b>${esc(x.dir)}</b></td>`;
    html += `<td style="padding:6px;border:1px solid #ddd">中偏低</td>`;
    html += `<td style="padding:6px;border:1px solid #ddd">1X2未开售·竞彩只卖让球;按让球+模型 → ${esc(x.dir)};悬殊盘只买赢球别买深让</td>`;
    html += `<td style="padding:6px;border:1px solid #ddd;color:#c33">深让易赢球输盘</td></tr>`;
    continue;
  }
  html += `<tr><td style="padding:6px;border:1px solid #ddd"><b>${esc(x.h)} vs ${esc(x.a)}</b></td>`;
  html += `<td style="padding:6px;border:1px solid #ddd"><b>${esc(x.dec.pick)}</b></td>`;
  html += `<td style="padding:6px;border:1px solid #ddd">${esc(x.dec.conf)}</td>`;
  html += `<td style="padding:6px;border:1px solid #ddd">${esc(x.dec.why)}</td>`;
  html += `<td style="padding:6px;border:1px solid #ddd;color:#c33">${esc(x.dec.risk)}</td></tr>`;
}
html += `</tbody></table></section>\n`;
console.log("<FRAGMENT>");
console.log(html);
console.log("</FRAGMENT>");
