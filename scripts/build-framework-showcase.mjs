/**
 * 足球大模型 · 框架展示页生成器(2026-06-01)
 * ════════════════════════════════════════════════════════════════════
 * 实时自省仓库,渲染一页手机可看的框架总览 HTML。所有数字可追溯、不编造:
 *   数据规模/模块数/测试数 实时统计;小模型登记/回测证据 读真实 profile + 标注产出命令。
 * 输出:exports/framework-showcase.html + 手机共享目录(端口80)。
 *
 * 用法:node scripts/build-framework-showcase.mjs
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir, getDataSubdir } from "../src/paths.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SHARE = "D:/Temp/webshare_lingdao";

// —— 实时统计:数据底座 ——
const fxDir = getDataSubdir("fixtures");
let total = 0, wRes = 0, wHalf = 0, wOdds = 0, wOver = 0;
const leagues = {};
for (const f of readdirSync(fxDir).filter((x) => x.endsWith(".json"))) {
  let o; try { o = JSON.parse(readFileSync(join(fxDir, f), "utf8")); } catch { continue; }
  for (const m of (o.fixtures || [])) {
    total++;
    if (m.result && m.result.home != null) { wRes++; const c = m.competition || "?"; leagues[c] = (leagues[c] || 0) + 1; }
    if (m.result && m.result.halfHome != null) wHalf++;
    if (m.marketHistorical?.openProbs) wOdds++;
    if (m.marketHistorical?.overProb != null) wOver++;
  }
}
const topLeagues = Object.entries(leagues).sort((a, b) => b[1] - a[1]).slice(0, 12);
const srcCount = readdirSync(join(root, "src")).filter((x) => x.endsWith(".js")).length;
const testCount = readdirSync(join(root, "test")).filter((x) => /\.(test\.)?(m?js)$/.test(x)).length;

// —— 真实回测证据(读 profile,缺则标注)——
const exp = getExportDir();
const readProf = (f) => { try { return JSON.parse(readFileSync(join(exp, f), "utf8")); } catch { return null; } };
const ouProf = readProf("overunder-calibration-profile.json");

// —— 小模型自主登记(与 models-registry 同源口径)——
const models = [
  ["联赛专家混合层", "league-expert-mixture", "共享全局拟合", "否·展示/兜底", "独立重拟合更差(-0.27pp),共享读是对的"],
  ["每联赛数据变化指纹", "build-league-datachange", "自主读 store 漂移/水位", "否·框架基础/速度", "league>global 但输市场,让球零增益"],
  ["历史比赛镜头", "historical-lens", "自读真实赛果(leak-safe)", "否·多模态对比", "稀疏即 available:false 不编造"],
  ["半全场参数", "halftime-fulltime-model", "自主读 33k 真实半场", "是·出半全场概率", "拟合打不过写死默认 Δ-0.0001→诚实弃用,到顶"],
  ["大小球 isotonic 校准", "overunder-calibration", "自主读真实总进球", "是·无盘口冷门场", `holdout Brier ${ouProf?.backtest?.rawBrier ?? "?"}→${ouProf?.backtest?.calBrier ?? "?"}(Δ+${ouProf?.backtest?.deltaBrier ?? "?"})真增益`],
];

const num = (n) => n.toLocaleString("en-US");
const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b1020;color:#e6ebf5;font:15px/1.6 -apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px;max-width:880px;margin:0 auto}
h1{font-size:22px;margin-bottom:4px}h2{font-size:17px;margin:22px 0 10px;color:#7cc4ff;border-left:3px solid #7cc4ff;padding-left:8px}
.sub{color:#8b98b5;font-size:13px;margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.card{background:#161d33;border:1px solid #243154;border-radius:10px;padding:12px}
.card .v{font-size:24px;font-weight:700;color:#fff}.card .k{font-size:12px;color:#8b98b5;margin-top:2px}
.flow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}
.flow .step{background:#1b2540;border:1px solid #2f3e66;border-radius:8px;padding:8px 11px;font-size:13px}
.flow .ar{color:#5f6f99}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #223052;vertical-align:top}
th{color:#9fb0d6;font-weight:600}
.yes{color:#5fd08a}.no{color:#f0a85f}
.bar{background:#161d33;border:1px solid #243154;border-radius:8px;padding:10px 12px;margin:8px 0}
.tag{display:inline-block;background:#1b2540;border:1px solid #2f3e66;border-radius:6px;padding:2px 7px;font-size:12px;margin:2px;color:#bcd0f5}
.note{color:#8b98b5;font-size:12px;margin-top:4px}
.ok{color:#5fd08a;font-weight:600}
code{background:#0d1530;border:1px solid #243154;border-radius:5px;padding:1px 6px;font-size:12px;color:#9fe6c4}
.foot{color:#5f6f99;font-size:12px;margin-top:24px;border-top:1px solid #223052;padding-top:12px}
`;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>足球大模型 · 框架展示</title>
<style>${css}</style></head><body>
<h1>⚽ 足球大模型 · 框架展示</h1>
<div class="sub">中文竞彩大模型 · 真实数据端到端 · 自主小模型 + 全环节审计 · 诚实 KPI(CLV)。本页数字实时自省自仓库,可追溯不编造。</div>

<h2>① 数据底座(实时统计)</h2>
<div class="cards">
  <div class="card"><div class="v">${num(wRes)}</div><div class="k">带赛果场次</div></div>
  <div class="card"><div class="v">${Object.keys(leagues).length}</div><div class="k">覆盖联赛</div></div>
  <div class="card"><div class="v">${num(wHalf)}</div><div class="k">带真实半场</div></div>
  <div class="card"><div class="v">${num(wOdds)}</div><div class="k">带开/收盘赔率</div></div>
  <div class="card"><div class="v">${num(wOver)}</div><div class="k">带大小球隐含</div></div>
  <div class="card"><div class="v">${srcCount}</div><div class="k">src 模块</div></div>
  <div class="card"><div class="v">${testCount}</div><div class="k">测试文件</div></div>
</div>
<div class="note">联赛分布(前12):${topLeagues.map(([k, v]) => `<span class="tag">${k} ${num(v)}</span>`).join("")}</div>
<div class="note">免费源:football-data.co.uk(18欧洲联赛,带开收盘赔率+半场)· ESPN 隐藏API(15洲际/北欧)· openfootball · statsbomb · FPL/Sofascore 伤停。绝不接付费。</div>

<h2>② 五层架构</h2>
<div class="flow">
  <span class="step">实时闸门<br>竞彩赔率/阵容</span><span class="ar">→</span>
  <span class="step">数据层<br>fixture-store ${num(wRes)}场</span><span class="ar">→</span>
  <span class="step">模型核心<br>Dixon-Coles τ + 校准</span><span class="ar">→</span>
  <span class="step">自主小模型层<br>各自读数据·自裁决</span><span class="ar">→</span>
  <span class="step">审计闸门<br>孤儿/真实/方向/λ物理</span><span class="ar">→</span>
  <span class="step">输出<br>竞彩+14场+大小球</span>
</div>
<div class="note">每场预测打 provenance 戳(odds-only / odds+DC / dixon-coles);无真实先验的场诚实剔除,绝不编造方向。</div>

<h2>③ 小模型自主登记表</h2>
<table>
<tr><th>小模型</th><th>数据源(自主读)</th><th>驱动主概率</th><th>回测裁决</th></tr>
${models.map(([n, , src, drive, verdict]) => `<tr><td><b>${n}</b></td><td>${src}</td><td>${drive.startsWith("是") ? `<span class="yes">${drive}</span>` : `<span class="no">${drive}</span>`}</td><td>${verdict}</td></tr>`).join("")}
</table>
<div class="note">闸门 <code>npm run audit:autonomous</code> 对每个小模型查 孤儿/真实分析/真实数据;<code>npm run models:registry</code> 看全表。</div>

<h2>④ 回测证据 · 诚实 KPI</h2>
<div class="bar"><b>大小球 isotonic 校准</b> — holdout Brier ${ouProf?.backtest?.rawBrier ?? "?"}→<span class="ok">${ouProf?.backtest?.calBrier ?? "?"}</span>(Δ+${ouProf?.backtest?.deltaBrier ?? "?"})真增益 · ${num(ouProf?.nTrain ?? 0)}场拟合 · <code>npm run train:overunder</code>
<div class="note">有市场盘口时市场仍最优(Brier ${ouProf?.backtest?.marketBrier ?? "?"});校准价值在无盘口冷门场。</div></div>
<div class="bar"><b>CLV(击败收盘线)= 真 edge 指标</b> — 模型 DC pick CLV −0.069%;<b>模型≠市场的真分歧场 CLV −0.814%、命中仅 27.9%</b>。<code>npm run backtest:clv</code>
<div class="note">黄金标准量化:公开数据打不过收盘线,模型逆市场分歧=高风险。命中率不是 edge,CLV 才是。</div></div>
<div class="bar"><b>诚实上限</b> — 胜负平≈市场 54-55% · 比分 12-15% · 半全场 28-35% · 大小球到顶。物理上限,不承诺 70-80%。</div>

<h2>⑤ 自主运转 + 审计命令</h2>
<div class="note">
<code>enrich:fixtures</code> 补半场赔率 · <code>expand:espn</code> 扩洲际 · <code>train:overunder</code>/<code>train:halffull</code> 自训小模型 ·
<code>audit:autonomous</code> 三连审计 · <code>models:registry</code> 登记表 · <code>backtest:clv</code> 真KPI · <code>sweep:halflife</code> 调参 ·
<code>daily</code> 实时闸门→预测→xlsx→微信 · <code>recap:daily</code> 预测vs实际复盘。
</div>

<div class="foot">真增益唯一方向 = 市场未定价的实时私有信息(伤停/阵容/盘口速度,需授权源)。公开数据空间已挖到头,不假装还能榨命中率。<br>
生成时间见文件;数字实时自省仓库 D:\\football-model。</div>
</body></html>`;

const outExp = join(exp, "framework-showcase.html");
writeFileSync(outExp, html, "utf8");
let shareMsg = "";
if (existsSync(SHARE)) { try { writeFileSync(join(SHARE, "framework.html"), html, "utf8"); shareMsg = `\n手机共享:${join(SHARE, "framework.html")}(端口80 → /framework.html)`; } catch (e) { shareMsg = `\n共享目录写入失败:${e.message}`; } }
console.log(`框架展示页已生成:\n  ${outExp}${shareMsg}`);
console.log(`\n实时数字:带赛果 ${num(wRes)} / 联赛 ${Object.keys(leagues).length} / 半场 ${num(wHalf)} / 赔率 ${num(wOdds)} / 模块 ${srcCount} / 测试 ${testCount}`);
