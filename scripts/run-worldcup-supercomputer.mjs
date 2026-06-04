#!/usr/bin/env node
/**
 * 2026 世界杯「超级计算机」— 对标 Opta Supercomputer 的招牌产出。
 * 真实分组(2025-12 华盛顿抽签)+ 48 队 Elo(免费 eloratings.net)→ 严谨蒙特卡洛锦标赛模拟
 * (真 FIFA 小组 tiebreaker + 强度种子布拉克特 + 90'→加时→点球)→ 每队各阶段晋级概率。
 *
 * 取代旧 run-worldcup-champion-sim.mjs(随机配对/随机同分/固定进球)。引擎见 src/tournament-simulator.js。
 *
 * 用法:node scripts/run-worldcup-supercomputer.mjs [--n 20000] [--seed 20260611] [--json] [--xlsx]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir, getExportDir } from "../src/paths.js";
import { teamPrior, groupVenueMults, matchVenueMult } from "../src/world-cup-priors.js";
import { runMonteCarlo } from "../src/tournament-simulator.js";

const argv = process.argv.slice(2);
const argNum = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : def; };
const N = argNum("--n", 20000);
const SEED = argNum("--seed", 20260611);

const gdoc = JSON.parse(readFileSync(join(getDataSubdir("world-cup"), "2026", "groups.json"), "utf8"));
const groups = gdoc.groups;
const zh = gdoc.team_name_zh || {};
const HOSTS = new Set(["United States", "Canada", "Mexico"]);

// 官方淘汰赛对阵表(FIFA 真实 R32 位次 + 第三名 495 分配表)。数据盘优先,回退仓库内 data/,再缺则强度种子树。
let bracket = null;
for (const p of [join(getDataSubdir("world-cup"), "2026", "bracket.json"), join(process.cwd(), "data", "world-cup", "2026", "bracket.json")]) {
  try { bracket = JSON.parse(readFileSync(p, "utf8")); break; } catch { /* next */ }
}

// 评级源(免费替代 Opta Power Rankings):国家队 Elo 来自 team-priors(eloratings.net)。
const eloCache = {};
const eloOf = (t) => {
  if (eloCache[t] != null) return eloCache[t];
  const tp = teamPrior(t) || teamPrior(zh[t]);
  return (eloCache[t] = tp?.elo || 1500);
};

// 进球强度实证校准(scripts/analyze-wc-stage-goals.mjs,1998-2022 32队×7届 448 场,leak-safe):
//   世界杯全程场均 2.536 球;淘汰赛(含加时记录口径)= 小组赛,扣加时后 90' 淘汰赛反更低 ~2.40。
//   旧值 1.18–1.28 把淘汰赛进球凭空抬高 18–28%,无实证支撑 → 高估强队碾压、低估点球大战变数。
//   改:base λtot 2.6→2.54(=实证全程),phaseIntensity 全程 0.96(90' 淘汰 ~2.44,加时另按 /3 叠加 ≈2.5)。
const phaseIntensity = { r32: 0.96, r16: 0.96, qf: 0.96, sf: 0.96, final: 0.96 };
// 大融合(2026-06-04):比分分布与单场世界杯模型统一 —— 国际赛进球过离散 nbSize=8
//   (= prediction-engine NB_SIZE_SOFT,49k 国际赛 leak-safe 验证 holdout 精确比分 logloss −0.03)。
//   超算每场不再纯泊松"各算各的";过离散↑平局/极端比分 → 淘汰赛更多点球 → 夺冠分布更贴实证。
// venue 逐场场地乘子(2026-06-04 大融合②):真实 FIFA 赛程 match-venues.json 每赛号→城市→海拔/气温 λ 乘子。
//   仅墨西哥城(2240m)+6%、露天高温城(蒙特雷-5%/迈阿密/堪萨斯/费城-3%)非中性,其余顶棚/温和城中性。
const groupVMs = groupVenueMults();
const koVenueMult = {};
for (let m = 73; m <= 104; m++) koVenueMult[m] = matchVenueMult(m);
const res = runMonteCarlo({ groups, eloOf, hosts: HOSTS, lambdaTotal: 2.54, hostAdv: 35, penTilt: 0, phaseIntensity, bracket, nbSize: 8, groupVenueMults: groupVMs, koVenueMult }, N, SEED);
const bracketMode = bracket ? "FIFA官方对阵表(R32位次+第三名495分配)" : "强度种子树(无官方表回退)";

// 市场隐含夺冠率(1/赔率 去 vig 归一)+ 混合(0.65市场+0.35模型,据 reference 学界结论:市场含全信息)
const ALPHA = 0.65;
const rawMkt = res.teams.map((r) => { const tp = teamPrior(r.team) || teamPrior(zh[r.team]); return tp?.title_odds ? 1 / tp.title_odds : 0; });
const mktSum = rawMkt.reduce((s, x) => s + x, 0) || 1;
const rows = res.teams.map((r, i) => {
  const mkt = rawMkt[i] / mktSum;
  return {
    team: zh[r.team] || r.team, en: r.team, elo: eloOf(r.team),
    advance: r.advance, r16: r.r16, qf: r.qf, sf: r.sf, final: r.final,
    champion: r.champion, market: mkt, blend: ALPHA * mkt + (1 - ALPHA) * r.champion,
  };
});
rows.sort((a, b) => b.blend - a.blend);

const pc = (x) => (x * 100).toFixed(1) + "%";
console.log(`=== 2026 世界杯超级计算机(N=${N} 次蒙特卡洛, seed=${SEED}, 引擎=tournament-simulator)===`);
console.log(`真实分组+Elo+真FIFA小组规则+${bracketMode}+90'→加时→点球50/50`);
console.log("\n排名 球队          Elo   出线   16强   8强   4强   决赛  夺冠(模型) 市场  混合");
rows.slice(0, 20).forEach((r, i) => {
  console.log(
    `${String(i + 1).padEnd(3)} ${(r.team).padEnd(8)} ${String(r.elo).padEnd(5)} ${pc(r.advance).padStart(6)} ${pc(r.r16).padStart(6)} ${pc(r.qf).padStart(5)} ${pc(r.sf).padStart(5)} ${pc(r.final).padStart(5)} ${pc(r.champion).padStart(7)} ${pc(r.market).padStart(6)} ${pc(r.blend).padStart(6)}`
  );
});
console.log(`\n审计:夺冠概率和=${pc(res.audit.champSum)}(应≈100%) | 出线期望和=${res.audit.advSum.toFixed(1)}(应=32) | 单调性=${res.audit.monotonic ? "✓" : "✗"} | 总闸门=${res.audit.ok ? "✓通过" : "✗"}`);
console.log(bracket
  ? "✅ R32 已用 FIFA 官方对阵表(胜者/亚军固定位次 + 第三名 495 组合官方分配,无同组重赛);点球 50/50(学界);命中率上限不变。"
  : "⚠️ 诚实边界:未找到 bracket.json,R32 回退强度种子树;点球 50/50;命中率上限不变。");

if (argv.includes("--json")) {
  const p = join(getExportDir(), "worldcup-supercomputer.json");
  writeFileSync(p, JSON.stringify({ n: N, seed: SEED, alpha: ALPHA, audit: res.audit, rows }, null, 1));
  console.log("已写 JSON:", p);
}
if (argv.includes("--xlsx")) {
  // 复用 polish-xlsx 之外的最简写法:直接调 python openpyxl(项目里已有 polish 脚本依赖 openpyxl)
  const header = ["排名", "球队", "EN", "Elo", "出线%", "16强%", "8强%", "4强%", "决赛%", "夺冠模型%", "市场隐含%", "混合%"];
  const data = rows.map((r, i) => [i + 1, r.team, r.en, r.elo, +(r.advance * 100).toFixed(1), +(r.r16 * 100).toFixed(1), +(r.qf * 100).toFixed(1), +(r.sf * 100).toFixed(1), +(r.final * 100).toFixed(1), +(r.champion * 100).toFixed(1), +(r.market * 100).toFixed(1), +(r.blend * 100).toFixed(1)]);
  const tmp = join(getExportDir(), "_wc_super_rows.json");
  writeFileSync(tmp, JSON.stringify({ header, data }), "utf8");
  const py = `
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
d = json.load(open(r"${tmp.replace(/\\/g, "\\\\")}", encoding="utf-8"))
wb = Workbook(); ws = wb.active; ws.title = "世界杯超算2026"
hf = Font(bold=True, color="FFFFFF"); hp = PatternFill("solid", fgColor="1F4E78")
ws.append(d["header"])
for c in ws[1]: c.font=hf; c.fill=hp; c.alignment=Alignment(horizontal="center")
for row in d["data"]: ws.append(row)
widths=[5,12,18,7,8,8,8,8,8,11,11,8]
for i,w in enumerate(widths,1): ws.column_dimensions[chr(64+i)].width=w
ws.freeze_panes="A2"
out=r"${join(getExportDir(), "神选-世界杯超算-2026.xlsx").replace(/\\/g, "\\\\")}"
wb.save(out); print("XLSX:", out)
`;
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python", ["-c", py], { encoding: "utf8" });
  console.log((r.stdout || "").trim() || `xlsx 失败:${r.stderr}`);
}
