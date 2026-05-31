// 建/刷新永久记忆:从 recommendation-ledger 已结算行 digest 出模型分段战绩,落盘 model-memory.json。
// 用法:node scripts/build-model-memory.mjs   (建议接在 recap 之后,赛果结算后刷新)
// 产物:D:\football-model-exports\model-memory.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildModelMemory } from "../src/model-memory.js";
import { getExportDir } from "../src/paths.js";

const dir = getExportDir();
const ledgerPath = join(dir, "recommendation-ledger.json");
if (!existsSync(ledgerPath)) { console.error("无 ledger,跳过"); process.exit(0); }

const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const memory = buildModelMemory(ledger, { builtAt: new Date().toISOString() });
const outPath = join(dir, "model-memory.json");
writeFileSync(outPath, JSON.stringify(memory, null, 2), "utf8");

const g = memory.global;
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
console.log(`已结算 ${memory.settledTotal} 场 → ${outPath}`);
console.log(`总体:胜平负 ${pct(g.wldHit)}(n=${g.wldN}) · 比分 ${pct(g.scoreHit)}(n=${g.scoreN}) · 半全场 ${pct(g.halfFullHit)}(n=${g.halfFullN}) · 让球 ${pct(g.handicapHit)}(n=${g.handicapN})`);
console.log("热门档命中:", Object.entries(memory.byFavoriteTier).map(([k, v]) => `${k} ${pct(v.wldHit)}(n=${v.n})`).join(" · "));
console.log("信心带命中:", Object.entries(memory.byConfidenceBand).map(([k, v]) => `${k} ${pct(v.wldHit)}(n=${v.n})`).join(" · "));
const topLeagues = Object.entries(memory.byLeague).filter(([, v]) => v.n >= 5).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
console.log("主要联赛命中:", topLeagues.map(([k, v]) => `${k} ${pct(v.wldHit)}(n=${v.n})`).join(" · "));
