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
    league: m.league, result, favSide, pFav: oc[favSide], ahDepthC: Math.abs(lineC),
    ovC, overMove: (Number.isFinite(ovC) && Number.isFinite(ovO)) ? ovC - ovO : null,
    favUpset: result !== favSide, favDrew: result === "draw",
    favWin: result === favSide, favLost: result !== favSide && result !== "draw",
    over25: (hg + ag) > 2.5,
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
["平局隐含概率≥30%", "OOS校准·实际平局31.5%", "🟡防平·勿当胆(唯一过样本外的平局触发)", "最干净的平局信号"],
["⚠'强热+大小球线低→易爆冷平'", "OOS证伪:五大联赛78~90%窄胜非平", "❌砍除", "西班牙0-0是WC铁桶弱旅尾部·公开盘口不可靠预判"],
["亚盘平手~0.25盘", "热门不胜56-60%·平局30%", "本就高不确定·首选别当胆·双选含平", "结构性基线非走势"],
["欧赔/亚盘热门退烧或加注", "对爆冷无预测力(z<2)", "❌不作触发(噪声)", "印证公开盘信号打不过收盘线"],
["意甲/西甲场", "平局26-27%·大球仅47-49%", "偏小球/防平", "联赛风格代理球队特点"],
["德甲/英超场", "大球57-61%", "偏大球", "同上"]];

// Sheet6 爆冷出平vs出负(大小球分水岭 + 强度决定平负)
const s6 = [["维度", "分档", "样本N", "热门胜", "平", "热门负", "解读"]];
for (const [lab, lo, hi, tag] of [["大小球", 0, 0.40, "铁闷→出平"], ["大小球", 0.40, 0.48, "低球→出平"], ["大小球", 0.48, 0.56, "中"], ["大小球", 0.56, 0.64, "偏稳"], ["大小球", 0.64, 1.01, "对攻→热门最稳"]]) {
  const g = F.filter(x => x.ovC != null && x.ovC >= lo && x.ovC < hi); if (g.length < 30) continue;
  s6.push([lab, `${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}%`, g.length, PC(rate(g, x => x.favWin).p), PC(rate(g, x => x.favDrew).p), PC(rate(g, x => x.favLost).p), tag]);
}
for (const [lab, lo, hi] of [["1X2势均", 0.50, 0.58], ["1X2中热", 0.58, 0.66], ["1X2强热", 0.66, 0.74], ["1X2大热", 0.74, 0.82], ["1X2超大热", 0.82, 1.01]]) {
  const g = F.filter(x => x.pFav >= lo && x.pFav < hi); if (g.length < 30) continue;
  const ups = g.filter(x => !x.favWin); const ds = ups.length ? rate(ups, x => x.favDrew).p : 0;
  s6.push([lab, `${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}%`, g.length, PC(rate(g, x => x.favWin).p), PC(rate(g, x => x.favDrew).p), PC(rate(g, x => x.favLost).p), `爆冷里平占比${PC(ds)}`]);
}

// Sheet7 分型临界值标准(可触发)·已过样本外回测审计(audit-upset-triggers.mjs)
const s7 = [["分型", "临界条件(读盘口即可判)", "样本外(2024-26)实证", "玩法指引"],
["🟢低风险(强热可胆)", "1X2≥72%(让球线≥同类中位更佳)", "OOS热门胜76.7%/平16.5%", "可主推·可当胆"],
["🟢低风险(强热窄胜)", "1X2≥72% + 大小球线低(≤3.5)", "OOS热门胜90.4%/平6.4%(强队窄胜·非平!)", "可胆;仅WC对铁桶弱旅留罕见逼平尾部(西班牙0-0型),公开盘口不可靠预判"],
["🟡防平", "平局隐含≥30%", "OOS校准·实际平局31.5%(唯一成立的平局触发)", "防平·勿当胆"],
["🔴双向爆冷", "1X2势均(热门不胜≥42%·约≤58%)", "OOS胜47%/平28%/负25%(爆冷53%)", "平负都可能·绝不当胆"],
["——深浅标准——", "本场亚盘线 vs 同1X2实力档中位线:残差≤-0.25=浅·≥+0.25=深", "基准表见①", "浅≠绝对值小,是比同类浅"],
["❌已证伪·勿用", "'强热+大小球线低→易爆冷平'(从西班牙孤例推)", "OOS翻车:五大联赛这类78~90%窄胜,非平", "砍除·不作触发(防止对会赢的场喊狼来了)"],
["❌已证伪·勿用", "诱盘(公众加注+锐盘不跟)", "加注热门照样55%胜≈基线·无edge", "别靠'识诱盘'反买(市场高效)"]];

const sheets = [
  { name: "①亚盘线基线", rows: s1 }, { name: "②走势=噪声(诚实排除)", rows: s2 },
  { name: "③大小球走势(真edge)", rows: s3 }, { name: "④联赛风格", rows: s4 }, { name: "⑤可执行触发条件", rows: s5 },
  { name: "⑥爆冷出平vs出负", rows: s6 }, { name: "⑦分型临界值标准", rows: s7 },
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
  upsetTypology: {
    深浅标准: "本场亚盘线 vs 同1X2实力档中位线;残差≤-0.25=浅·≥+0.25=深",
    低风险可胆: "1X2≥72%(OOS热门胜~77%;低球也是窄胜OOS90%·非平)",
    防平: "平局隐含≥30%(OOS校准实际平局31.5%·唯一过样本外的平局触发)",
    双向爆冷: "1X2势均(热门不胜≥42%·约≤58%);OOS胜47%/平28%/负25%",
    note: "回测审计(audit-upset-triggers.mjs)样本外2024-26验证;'强热+大小球线低→易爆冷平'已证伪(OOS78~90%窄胜),西班牙0-0=WC铁桶弱旅尾部不可靠预判",
  },
  ruledOutAsNoise: ["欧赔热门加注/退烧→爆冷", "亚盘线加深/退浅→爆冷", "受让方水位移动→爆冷", "诱盘(公众加注锐盘不跟)→underperform", "强热+大小球线低→易爆冷平(OOS翻车=窄胜)", "Pinnacle背离(样本不足)"],
  freeDataGaps: ["阵容(历史批量)", "战意/排名情境(历史批量)", "球员特点", "国家队xG(FBref Cloudflare墙)"],
};
const jpath = join("D:/football-model-data", "handicap-pattern-baselines.json");
writeFileSync(jpath, JSON.stringify(baselines, null, 2));
console.log("✅ baseline json:", jpath);
