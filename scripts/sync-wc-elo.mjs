#!/usr/bin/env node
/**
 * 世界杯 48 队 Elo 保鲜(eloratings.net World.tsv,免费免授权)——2026-06-11 开赛日上线。
 * 只更新 <data>/world-cup/2026/team-priors.json 的 teams[*].elo + elo_date,其余字段(squad/
 * coach/title_odds/fifa_*)一律不碰;冻结基线 worldcup-forecast-baseline / supercomputer-baseline
 * 文件绝不读写。
 * 诚实闸:48 队任一在 TSV 里解析不到 → 整体不写盘(绝不兜底旧值冒充新值);单队漂移>80 视为
 * 疑似错映射,打 ⚠️ 并整体不写盘(国家队两周内 Elo 正常变动远小于 80)。
 * 用法:node scripts/sync-wc-elo.mjs [--dry]
 */
import "../src/env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";

const TSV_URL = "https://www.eloratings.net/World.tsv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DRY = process.argv.includes("--dry");
const MAX_DRIFT = 80; // 错映射哨兵:正常窗口期 Elo 变动远小于此

// 48 队英文规范名(team-priors teams[*].en)→ eloratings.net 代码。
// 已对 en.teams.tsv 逐一核实:SQ=Scotland、CD=DR Congo、HT=Haiti、CW=Curaçao(2026-06-11)。
const EN_CODE = {
  "Mexico": "MX", "South Africa": "ZA", "Korea Republic": "KR", "Czechia": "CZ",
  "Canada": "CA", "Bosnia and Herzegovina": "BA", "United States": "US", "Paraguay": "PY",
  "Qatar": "QA", "Switzerland": "CH", "Brazil": "BR", "Morocco": "MA",
  "Haiti": "HT", "Scotland": "SQ", "Australia": "AU", "Turkiye": "TR",
  "Netherlands": "NL", "Japan": "JP", "Ivory Coast": "CI", "Ecuador": "EC",
  "Sweden": "SE", "Tunisia": "TN", "Spain": "ES", "Cape Verde": "CV",
  "Belgium": "BE", "Egypt": "EG", "Saudi Arabia": "SA", "Uruguay": "UY",
  "Iran": "IR", "New Zealand": "NZ", "France": "FR", "Senegal": "SN",
  "Argentina": "AR", "Algeria": "DZ", "Austria": "AT", "Jordan": "JO",
  "Portugal": "PT", "DR Congo": "CD", "England": "EN", "Croatia": "HR",
  "Ghana": "GH", "Panama": "PA", "Uzbekistan": "UZ", "Colombia": "CO",
  "Iraq": "IQ", "Norway": "NO", "Germany": "DE", "Curacao": "CW",
};

const dir = join(getDataSubdir("world-cup"), "2026");
const priorsPath = join(dir, "team-priors.json");
const priors = JSON.parse(readFileSync(priorsPath, "utf8"));

const r = await fetch(TSV_URL, { headers: { "User-Agent": UA } });
if (!r.ok) { console.error(`❌ eloratings.net HTTP ${r.status},不写盘(保留旧 Elo,elo_date 不动)`); process.exit(1); }
const byCode = {};
for (const line of (await r.text()).trim().split("\n")) {
  const c = line.split("\t");
  if (c[2] && Number.isFinite(Number(c[3]))) byCode[c[2]] = Number(c[3]);
}

const missing = [], drifted = [], changes = [];
for (const [cn, t] of Object.entries(priors.teams)) {
  const code = EN_CODE[t.en];
  const fresh = code ? byCode[code] : undefined;
  if (!Number.isFinite(fresh)) { missing.push(`${cn}(${t.en}→${code ?? "无映射"})`); continue; }
  const d = fresh - t.elo;
  if (Math.abs(d) > MAX_DRIFT) drifted.push(`${cn} ${t.elo}→${fresh}(Δ${d})`);
  if (d !== 0) changes.push({ cn, en: t.en, old: t.elo, fresh, d });
}
if (missing.length) { console.error(`❌ ${missing.length} 队在 World.tsv 解析不到:${missing.join("、")} —— 整体不写盘`); process.exit(1); }
if (drifted.length) { console.error(`⚠️ 漂移>±${MAX_DRIFT} 疑似错映射:${drifted.join("、")} —— 整体不写盘,先人工核`); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
console.log(`eloratings.net World.tsv 解析 ${Object.keys(byCode).length} 国;48/48 队对上;变动 ${changes.length} 队(elo_date ${priors.elo_date} → ${today}):`);
for (const c of changes.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)))
  console.log(`  ${c.cn.padEnd(7)} ${c.old} → ${c.fresh} (${c.d > 0 ? "+" : ""}${c.d})`);
if (!changes.length) console.log("  (全部与现值一致)");

if (DRY) { console.log("--dry:不写盘"); process.exit(0); }
for (const t of Object.values(priors.teams)) t.elo = byCode[EN_CODE[t.en]];
priors.elo_date = today;
writeFileSync(priorsPath, JSON.stringify(priors, null, 2), "utf8");
console.log(`✅ 写 ${priorsPath}(只动 elo/elo_date,其余字段未触碰)`);
