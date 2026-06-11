// merge-titan007-coverage.mjs — 把 fetch-asian-titan007 的亚盘结果合并进 coverage/<date>.json 的 asianHandicap 字段
// (renderAsianDualCell 期望形状:{ titan007:{live,init,companiesCount,primaryCompany,fetchedAt}, dk:{line,openLine,homeOdds,awayOdds,source} })
// 用法: node scripts/merge-titan007-coverage.mjs --date YYYY-MM-DD [--titan <path>]
// 规则:只填缺/只用真值;titan007 该场没抓到(asian=null)→ 不写字段,显示层照常⚠️标缺,绝不兜底。
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name, def = null) => { const i = process.argv.indexOf("--" + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const date = arg("date");
if (!date) { console.error("用法: node scripts/merge-titan007-coverage.mjs --date YYYY-MM-DD [--titan <path>]"); process.exit(1); }
const covPath = `D:/football-model-data/coverage/${date}.json`;
const titanPath = arg("titan", `D:/football-model-data/coverage/titan007-asian-${date}.json`);

const cov = JSON.parse(readFileSync(covPath, "utf8"));
const titan = JSON.parse(readFileSync(titanPath, "utf8"));

const nameOk = (a, b) => a && b && (a === b || a.startsWith(b) || b.startsWith(a));
let merged = 0, skipped = 0;
for (const t of titan.matches ?? []) {
  if (!t.asian?.primary) { skipped++; continue; }
  const m = (cov.matches ?? []).find((x) => nameOk(x.home?.zh, t.home) && nameOk(x.away?.zh, t.away));
  if (!m) { console.error(`⚠️ coverage 无对阵 ${t.home} vs ${t.away},跳过`); skipped++; continue; }
  const p = t.asian.primary;
  m.asianHandicap = {
    titan007: {
      live: p.live ?? null, init: p.init ?? null,
      companiesCount: t.asian.companiesCount ?? null,
      primaryCompany: { id: p.companyID ?? null, name: p.company ?? null },
      lineConvention: t.asian.lineConvention,
      fetchedAt: titan.fetchedAt,
    },
    ...(m.espnOdds?.asian?.line != null ? { dk: { ...m.espnOdds.asian, source: m.espnOdds.source ?? "ESPN/DraftKings" } } : {}),
  };
  merged++;
}
writeFileSync(covPath, JSON.stringify(cov, null, 2), "utf8");
console.log(`合并完成:titan007亚盘 ${merged} 场入 coverage,${skipped} 场无数据如实跳过(${covPath})`);
