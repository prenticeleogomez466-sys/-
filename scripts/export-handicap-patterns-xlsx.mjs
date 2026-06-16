#!/usr/bin/env node
/**
 * 盘口共性挖掘 → xlsx 报告 + 可复用基线 JSON(2026-06-16 用户:"把真实有用的信息做出来")。
 * 数据/口径同 scripts/mine-handicap-patterns.mjs(8906场五大联赛真实历史)。
 * 诚实:每条带样本数 + 偏离 + z;|z|<2 标"噪声·不可作触发"。阵容/战意/球员=免费墙,本报告不含、标缺。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { matches } = await loadFootballDataMatches();
function feat(m) {
  const o = m.odds, oc = m.oddsClose; if (!o || !oc || !m.asian) return null;
  const hg = m.homeGoals, ag = m.awayGoals; if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const result = hg > ag ? "home" : hg < ag ? "away" : "draw";
  const favSide = oc.home >= oc.away ? "home" : "away";
  const lineC = Number(m.asian.lineClose ?? m.asian.line);
  const ovO = m.overProb, ovC = m.overProbClose;
  return {
    league: m.league, result, favSide, ahDepthC: Math.abs(lineC),
    ovC, overMove: (Number.isFinite(ovC) && Number.isFinite(ovO)) ? ovC - ovO : null,
    favUpset: result !== favSide, favDrew: result === "draw", over25: (hg + ag) > 2.5,
  };
}
const F = matches.map(feat).filter(Boolean);
const rate = (arr, p) => { const n = arr.length, k = arr.filter(p).length; return { n, p: n ? k / n : 0 }; };
const z = (p, p0, n) => n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt(p0 * (1 - p0) / n) : 0;
const PC = (x) => (x * 100).toFixed(1) + "%";
const flag = (zz) => Math.abs(zz) >= 2.6 ? "🟢可作触发" : Math.abs(zz) >= 2 ? "🟡待样本" : "⚪噪声·不可触发";
const baseOver = rate(F, x => x.over25).p;

// Sheet1 亚盘线基线
const s1 = [["收盘亚盘线|line|", "样本N", "热门不胜率", "平局率", "大球率(>2.5)"]];
for (const [lab, lo, hi] of [["平手", 0, 0.1], ["±0.25", 0.25, 0.25], ["±0.5", 0.5, 0.5], ["±0.75", 0.75, 0.75], ["±1", 1, 1], ["±1.25", 1.25, 1.25], ["±1.5", 1.5, 1.5], ["±1.75", 1.75, 1.75], ["±2及以上", 2, 9]]) {
  const g = F.filter(x => x.ahDepthC >= lo && x.ahDepthC <= hi + 0.001);
  if (g.length < 30) continue;
  s1.push([lab, g.length, PC(rate(g, x => x.favUpset).p), PC(rate(g, x => x.favDrew).p), PC(rate(g, x => x.over25).p)]);
}

// Sheet2 走势触发结论(欧赔/亚盘=噪声;诚实排除)
const s2 = [["走势信号", "分段", "样本N", "热门不胜率", "vs该段基线", "z", "裁决"]];
// 欧赔/亚盘走势对爆冷=噪声(已由 mine-handicap-patterns.mjs 实证),诚实落表:
[["欧赔热门退烧→爆冷", "浅盘", 606, 0.563, 0.553, 0.5], ["欧赔热门加注→爆冷", "浅盘", 649, 0.552, 0.553, 0.0],
["亚盘线退浅→爆冷", "浅盘", 879, 0.560, 0.553, 0.4], ["欧赔热门退烧→爆冷", "中深", 282, 0.326, 0.378, -1.8],
["亚盘线加深→爆冷", "中深", 623, 0.413, 0.378, 1.8]].forEach(r =>
  s2.push([r[0], r[1], r[2], PC(r[3]), ((r[3] - r[4]) * 100).toFixed(1) + "pp", r[5].toFixed(1), flag(r[5])]));
s2.push(["——结论——", "欧赔/亚盘走势对爆冷=噪声(z<2),不可作触发;印证'公开盘口信号打不过收盘线'", "", "", "", "", ""]);

// Sheet3 大小球走势=唯一真 edge
const s3 = [["触发条件", "样本N", "实际大球率", "vs基线" + PC(baseOver), "z", "裁决"]];
const r1 = rate(F.filter(x => x.overMove > 0.04), x => x.over25);
const r2 = rate(F.filter(x => x.overMove < -0.04), x => x.over25);
s3.push(["大小球被加注(over隐含↑>4pp)→大球", r1.n, PC(r1.p), ((r1.p - baseOver) * 100).toFixed(1) + "pp", z(r1.p, baseOver, r1.n).toFixed(1), flag(z(r1.p, baseOver, r1.n))]);
s3.push(["大小球退烧(over隐含↓>4pp)→小球", r2.n, PC(r2.p), ((r2.p - baseOver) * 100).toFixed(1) + "pp", z(r2.p, baseOver, r2.n).toFixed(1), flag(z(r2.p, baseOver, r2.n))]);
// 校准
s3.push(["——收盘大球概率分档→实际大球率(校准)——", "", "", "", "", ""]);
for (const [lo, hi] of [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1]]) {
  const g = F.filter(x => x.ovC != null && x.ovC >= lo && x.ovC < hi); if (g.length < 30) continue;
  s3.push([`收盘大球${lo * 100}~${hi * 100}%`, g.length, PC(rate(g, x => x.over25).p), "", "", ""]);
}

// Sheet4 联赛风格(球队特点的真实代理)
const s4 = [["联赛", "样本N", "平局率", "大球率", "热门不胜率", "风格"]];
for (const [lg, nm] of [["E0", "英超"], ["SP1", "西甲"], ["D1", "德甲"], ["I1", "意甲"], ["F1", "法甲"]]) {
  const g = F.filter(x => x.league === lg); if (!g.length) continue;
  const dr = rate(g, x => x.favDrew).p, ov = rate(g, x => x.over25).p;
  const style = ov >= 0.55 ? "开放·偏大球" : dr >= 0.26 ? "闷局·偏平偏小球" : "中性";
  s4.push([nm, g.length, PC(dr), PC(ov), PC(rate(g, x => x.favUpset).p), style]);
}

// Sheet5 可执行触发条件总表
const s5 = [["触发条件(读盘口即可判)", "历史命中", "玩法指引", "诚实caveat"],
["大小球盘口收盘比初盘加注>4pp", "实际大球63%(基线53%,z=4.4)", "大球倾向(浅/中盘最稳;深盘降级)", "方向提示非保证,不自动下注"],
["大小球盘口收盘比初盘退烧>4pp", "实际大球仅44%(z=-4.7)", "小球倾向", "同上"],
["1X2笃定≥85% 但 亚盘线浅(<3)+大小球线低(≤3.5)", "背离=隐藏闷局(西班牙0-0原型)", "爆冷风险升档·勿当胆勿打深让球", "五大联赛样本少,WC/悬殊场显著;瑞典5-1反例"],
["亚盘平手~0.25盘", "热门不胜56-60%·平局30%", "本就高不确定·首选别当胆·双选含平", "结构性基线非走势"],
["欧赔/亚盘热门退烧或加注", "对爆冷无预测力(z<2)", "❌不作触发(噪声)", "印证公开盘信号打不过收盘线"],
["意甲/西甲场", "平局26-27%·大球仅47-49%", "偏小球/防平", "联赛风格代理球队特点"],
["德甲/英超场", "大球57-61%", "偏大球", "同上"]];

const sheets = [
  { name: "①亚盘线基线", rows: s1 }, { name: "②走势=噪声(诚实排除)", rows: s2 },
  { name: "③大小球走势(真edge)", rows: s3 }, { name: "④联赛风格", rows: s4 }, { name: "⑤可执行触发条件", rows: s5 },
];
const date = new Date().toISOString().slice(0, 10);
const dir = join(process.env.USERPROFILE || "C:/Users/Administrator", "Desktop", "足球推荐", date);
mkdirSync(dir, { recursive: true });
const out = join(dir, `神选-盘口共性挖掘与触发条件-${date}.xlsx`);
writeXlsxWorkbook(out, sheets);
console.log("✅ xlsx:", out);

// 可复用 JSON 基线
const baselines = {
  generatedAt: new Date().toISOString(), source: "footballdata 8906场五大联赛 2021-2026",
  ahLineBaseline: s1.slice(1).map(r => ({ line: r[0], n: r[1], upset: r[2], draw: r[3], over: r[4] })),
  totalsMovementTrigger: { steamOverRate: 0.63, drainOverRate: 0.44, baseOver: Number(baseOver.toFixed(3)), threshold: 0.04, z: 4.4 },
  leagueStyle: s4.slice(1).map(r => ({ league: r[0], draw: r[2], over: r[3], style: r[5] })),
  ruledOutAsNoise: ["欧赔热门加注/退烧→爆冷", "亚盘线加深/退浅→爆冷", "Pinnacle背离(样本不足)"],
  freeDataGaps: ["阵容(历史批量)", "战意/排名情境(历史批量)", "球员特点", "国家队xG(FBref Cloudflare墙)"],
};
const jpath = join("D:/football-model-data", "handicap-pattern-baselines.json");
writeFileSync(jpath, JSON.stringify(baselines, null, 2));
console.log("✅ baseline json:", jpath);
