#!/usr/bin/env node
/**
 * build-wc-html.mjs —— 世界杯超算夺冠页 worldcup.html 重建器。
 *
 * 背景:旧生成器(build_worldcup_fusion_deliverable.py 一类)在 78439c6「剔除48死件」时被删,
 *   导致 run-worldcup-supercomputer.mjs 每次重算 worldcup-supercomputer.json 后,常驻静态页
 *   worldcup.html 无人重渲染 → audit-wc-pipeline 的 s4-wchtml 闸(Top3 blend% 须与 json 一致)
 *   72h 后必红需人工返厂。本脚本即 audit 提示的 "build_wc_html",补回该维护环节。
 *
 * 纯渲染:唯一真相源 = worldcup-supercomputer.json(队各阶段概率)+ groups.json(组别/中文名)。
 *   不抓数据、不算概率、不编造;json 缺则 fail-loud 退出。版式/样式逐字沿用开赛版页面。
 *
 * 用法:node scripts/build-wc-html.mjs [--web D:\Temp\webshare_lingdao]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const WEB = arg("web", "D:\\Temp\\webshare_lingdao");
const WC = join(getDataSubdir("world-cup"), "2026");

const scPath = join(WC, "worldcup-supercomputer.json");
const grPath = join(WC, "groups.json");
if (!existsSync(scPath)) { console.error(`🔴 缺 ${scPath} —— 先跑 npm run wc:super(--json)`); process.exit(1); }
if (!existsSync(grPath)) { console.error(`🔴 缺 ${grPath}`); process.exit(1); }

const sc = JSON.parse(readFileSync(scPath, "utf8"));
const gdoc = JSON.parse(readFileSync(grPath, "utf8"));
const groups = gdoc.groups;
const rows = sc.rows;
if (!Array.isArray(rows) || !rows.length) { console.error("🔴 supercomputer.json rows 空"); process.exit(1); }

const byEn = new Map(rows.map((r) => [r.en, r]));
const pct = (v) => `${(v * 100).toFixed(2)}%`;
const pct1 = (v) => `${(v * 100).toFixed(1)}%`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Top16 卡片(按 blend 降序)──
const top16 = [...rows].sort((a, b) => b.blend - a.blend).slice(0, 16);
// 每队所属组(用于卡片 grp 标注)
const groupOfEn = new Map();
for (const [g, list] of Object.entries(groups)) for (const en of list) groupOfEn.set(en, g);

const cards = top16.map((r, i) => {
  const grp = groupOfEn.get(r.en) ? `组${groupOfEn.get(r.en)}` : "";
  const mkt = Number.isFinite(r.market) ? `市场 ${pct(r.market)} ✅市场实测` : "市场 ⚠️缺";
  return `  <div class="card">
    <div class="rk">#${i + 1}</div>
    <div class="tm">${esc(r.team)}<span class="grp">${grp} · Elo ${r.elo}</span></div>
    <div class="bl">${pct(r.blend)}</div>
    <div class="sub">模型 ${pct(r.champion)} · ${mkt}</div>
  </div>`;
}).join("\n");

// ── 12 组出线榜(按 advance 降序,前二金色)──
const groupBoxes = Object.keys(groups).map((g) => {
  const list = groups[g].map((en) => byEn.get(en)).filter(Boolean)
    .sort((a, b) => b.advance - a.advance);
  const trs = list.map((r, idx) => {
    const hot = idx < 2 ? ' class="hot"' : "";
    return `    <tr${hot}><td>${idx + 1}</td><td class="l">${esc(r.team)}</td><td>${r.elo}</td><td>${pct1(r.advance)}</td><td>${pct1(r.r16)}</td></tr>`;
  }).join("\n");
  return `  <div class="gbox">
    <div class="gh">${g} 组</div>
    <table><tr><th>#</th><th class="l">球队</th><th>Elo</th><th>出线%</th><th>16强%</th></tr>
${trs}</table>
  </div>`;
}).join("\n");

const au = sc.audit || {};
const r16Sum = rows.reduce((s, r) => s + (r.r16 || 0), 0);
const genAt = sc.generatedAt || "";
const genDate = genAt.slice(0, 10);
const vintage = sc.titleOddsVintage || "市场赔率";
const ver = genAt.replace(/[^0-9]/g, "").slice(0, 12) || "0";

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<title>⚡神选·世界杯超算 ${genDate}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#120a1f;color:#eee;line-height:1.5;-webkit-text-size-adjust:100%}
header{background:linear-gradient(135deg,#4A148C,#7B1FA2);padding:18px 14px;color:#fff}
header h1{margin:0;font-size:19px}
.ready{margin-top:10px;background:#1b5e20;color:#c8f7c5;font-size:12.5px;padding:9px 11px;border-radius:8px}
.warn{margin-top:8px;background:#4a3208;color:#ffd97a;font-size:12px;padding:8px 11px;border-radius:8px}
.dl{display:block;margin-top:10px;background:#FFD54F;color:#4A148C;text-align:center;font-size:15px;font-weight:700;padding:12px;border-radius:8px;text-decoration:none}
main{max-width:820px;margin:0 auto;padding:12px}
h2{font-size:15px;margin:18px 0 8px;color:#CE93D8;border-left:4px solid #7B1FA2;padding-left:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:8px}
.card{background:#1e1230;border:1px solid #3a2459;border-radius:10px;padding:10px}
.rk{font-size:11px;color:#9575CD}
.tm{font-size:15px;font-weight:700;margin:2px 0}
.grp{display:block;font-size:11px;color:#aaa;font-weight:400}
.bl{font-size:22px;font-weight:800;color:#FFD54F}
.sub{font-size:10.5px;color:#bbb;margin-top:2px}
.gbox{background:#1e1230;border:1px solid #3a2459;border-radius:10px;margin:8px 0;overflow:hidden}
.gh{background:#4A148C;color:#fff;font-weight:700;font-size:13.5px;padding:7px 12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:6px 8px;text-align:center;border-top:1px solid #2c1b45}
th{color:#CE93D8;font-size:11.5px}
td.l,th.l{text-align:left}
tr.hot td{color:#FFD54F;font-weight:600}
footer{text-align:center;color:#777;font-size:11px;padding:18px}
.groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
</style>
</head>
<body>
<header>
  <h1>⚡神选·世界杯超算 ${genDate}</h1>
  <div class="ready">✅ N=${sc.n} seed=${sc.seed} · 48/48队 · 审计${au.ok ? "全过" : "⚠️异常"}(夺冠和=${(au.champSum ?? 0).toFixed(5)} / 出线和=${(au.advSum ?? 0).toFixed(3)} / 16强和=${r16Sum.toFixed(3)} / 单调${au.monotonic ? "✓" : "✗"}) · ${sc.marketFusedMatches ?? "?"}场临场赔率融合(α=${sc.alpha} Shin) · ${esc(sc.bracketMode || "FIFA官方对阵表")}</div>
  <div class="ready">📡 夺冠外盘=${esc(vintage)}</div>
  <a class="dl" href="worldcup.xlsx?v=${ver}" download>⬇ 下载完整48队xlsx(神选-世界杯超算)</a>
</header>
<main>
<h2>Top16 夺冠概率(混合 = ${sc.alpha}市场 + ${(1 - sc.alpha).toFixed(2)}模型)</h2>
<div class="cards">
${cards}
</div>
<h2>12组出线榜(按出线%排序,金色=前二)</h2>
<div class="groups">
${groupBoxes}
</div>
<footer>生成 ${genAt} · 蒙特卡洛N=${sc.n} · 数据:国家队Elo + 临场赔率融合 · 概率仅供参考不构成投注建议</footer>
</main>
<script>
window.addEventListener('pageshow',function(e){if(e.persisted){location.reload();}});
</script>
</body>
</html>
`;

const out = join(WEB, "worldcup.html");
writeFileSync(out, html, "utf8");
const t3 = top16.slice(0, 3).map((r) => `${r.team}${pct(r.blend)}`).join(" / ");
console.log(`✅ 重建 worldcup.html → ${out}`);
console.log(`   Top3(混合): ${t3} · 数据时间 ${genAt}`);
