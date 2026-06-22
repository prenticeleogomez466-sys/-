#!/usr/bin/env node
/**
 * 世界杯当前小组积分 + 面临问题 xlsx(2026-06-22 用户:每天自动出)。
 * 数据=loadWcGroupContext(真实ESPN正赛赛果)。落固定文件(覆盖)+webshare手机页目录。
 */
import fs from "node:fs";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { loadWcGroupContext, teamStandingLine, teamProblemLine } from "../src/wc-group-context.js";

const ctx = loadWcGroupContext();
const today = new Date().toISOString().slice(0, 10);

// Sheet1:12组积分榜
const s1 = [[`⚽ 2026世界杯·当前小组积分 · ${today} · 真实赛果${ctx.resultsN}场(ESPN正赛)`],
  ["组", "名次", "队伍", "赛", "胜", "平", "负", "进", "失", "净", "积分"]];
for (const [g, gx] of Object.entries(ctx.byGroup)) {
  gx.table.forEach((r, i) => s1.push([g, String(i + 1), r.team, r.pld, r.w, r.d, r.l, r.gf, r.ga, (r.gd >= 0 ? "+" : "") + r.gd, r.pts]));
  s1.push([""]);
}

// Sheet2:每队面临问题(出线形势)
const s2 = [[`⚽ 2026世界杯·各队面临的问题(出线形势) · ${today}`],
  ["组", "队伍", "当前积分形势", "面临的问题(末轮胜/平/负→出线推演)"]];
for (const [g, gx] of Object.entries(ctx.byGroup)) {
  for (const r of gx.table) s2.push([g, r.team, teamStandingLine(ctx, r.team) || "—", teamProblemLine(ctx, r.team) || "—"]);
  s2.push([""]);
}
s2.push(["说明", "出线规则", "每组前2直接出线+12个小组第3名里最好的8个", "末轮穷举另一场3结果精确推演;R32具体对手依赖全组终名+最佳第三未定。tiebreak=积分/净胜/进球。数据=ESPN真实赛果,缺标缺不编。"]);

const dir = "C:/Users/Administrator/Desktop/足球推荐/世界杯";
fs.mkdirSync(dir, { recursive: true });
const out = `${dir}/2026世界杯小组积分情景_最新.xlsx`;
writeXlsxWorkbook(out, [{ name: "当前积分", rows: s1 }, { name: "面临问题", rows: s2 }]);
// webshare 手机页目录(端口80常驻)
try { const wd = "D:/Temp/webshare_lingdao"; if (fs.existsSync(wd)) writeXlsxWorkbook(`${wd}/wc-standings.xlsx`, [{ name: "当前积分", rows: s1 }, { name: "面临问题", rows: s2 }]); } catch {}
console.log(`✅ 世界杯积分情景表:${out}(真实赛果${ctx.resultsN}场)`);
