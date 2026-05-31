// B: 用 football-data.co.uk 收盘价回填历史推荐, 算模型真实 CLV
// ──────────────────────────────────────────────────────────────────────────
// 免费数据(football-data CSV 自带 AvgC* 收盘)。把模型实际推荐(all-match-recommendations)
// 里能匹配到的欧洲联赛场, 用收盘价算 CLV = (1/收盘 - 1/下注)/(1/下注)。
// 仅覆盖 football-data 主库联赛(五大+荷比葡土希); 挪超/瑞典超等不在内, 走 A 实时采集。
// 用法: node scripts/clv-backfill-footballdata.mjs

import fs from "node:fs";
import { canonicalTeamName } from "../src/team-aliases.js";
import { computeCLV } from "../src/clv-confidence-gate.js";

const BASE = "https://www.football-data.co.uk/mmz4281";
const COMP2LG = {
  德甲: "D1", 德乙: "D2", 英超: "E0", 英冠: "E1", 英甲: "E2", 英乙: "E3",
  西甲: "SP1", 西乙: "SP2", 意甲: "I1", 意乙: "I2", 法甲: "F1", 法乙: "F2",
  荷甲: "N1", 比甲: "B1", 葡超: "P1", 土超: "T1", 希腊: "G1",
};
const PICK_COL = { 主胜: ["AvgCH", "B365CH"], 平局: ["AvgCD", "B365CD"], 客胜: ["AvgCA", "B365CA"] };
const PICK_OPENCOL = { 主胜: "home", 平局: "draw", 客胜: "away" };

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function pd(s) { const m = s.split("/"); if (m.length !== 3) return 0; let [d, mo, y] = m.map((x) => +x); if (y < 100) y += 2000; return Date.UTC(y, mo - 1, d); }
function norm(s) { return canonicalTeamName(s); }

async function fetchCsv(season, lg) {
  try {
    const r = await fetch(`${BASE}/${season}/${lg}.csv`); if (!r.ok) return [];
    const lines = (await r.text()).split(/\r?\n/).filter((l) => l.trim());
    const head = lines[0].split(","); const ix = (k) => head.indexOf(k);
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(","); if (c.length < 10) continue;
      out.push({
        home: c[ix("HomeTeam")], away: c[ix("AwayTeam")], ts: pd(c[ix("Date")]),
        get: (col) => num(c[ix(col)]),
      });
    }
    return out;
  } catch { return []; }
}

(async () => {
  const ex = "D:/football-model-data/exports";
  const recFiles = fs.readdirSync(ex).filter((f) => /^all-match-recommendations-.*\.json$/.test(f)).sort();
  if (!recFiles.length) { console.log("无推荐文件"); return; }

  const ledger = [];
  let totalEuro = 0, matched = 0;
  const csvCache = new Map();

  for (const rf of recFiles) {
    const j = JSON.parse(fs.readFileSync(`${ex}/${rf}`, "utf8"));
    const recDate = j.date || rf.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    const recTs = recDate ? Date.parse(recDate) : null;
    const season = seasonCode(recDate);
    for (const r of (j.rows || [])) {
      const lg = COMP2LG[r.competition]; if (!lg) continue;
      if (!r.odds || !PICK_OPENCOL[r.pick]) continue;
      totalEuro++;
      const betOdds = r.odds[PICK_OPENCOL[r.pick]]; if (!(betOdds > 1)) continue;
      // 取该赛季 CSV
      const key = `${season}/${lg}`;
      if (!csvCache.has(key)) csvCache.set(key, await fetchCsv(season, lg));
      const rows = csvCache.get(key);
      const [h, a] = String(r.match).split(/\s*vs\s*/);
      const ch = norm(h), ca = norm(a);
      // 匹配: 队名 canonical 相等 + 日期 ±3 天
      const hit = rows.find((m) => norm(m.home) === ch && norm(m.away) === ca && (recTs == null || Math.abs(m.ts - recTs) <= 4 * 864e5));
      if (!hit) continue;
      const closeOdds = PICK_COL[r.pick].map((col) => hit.get(col)).find((v) => v > 1);
      if (!(closeOdds > 1)) continue;
      const clv = computeCLV(betOdds, closeOdds);
      matched++;
      ledger.push({ date: recDate, match: r.match, pick: r.pick, betOdds, closeOdds, clv: clv.clv, verdict: clv.verdict, conf: r.confidence });
    }
  }

  console.log(`\n===== B: football-data 收盘回填 · 模型真实 CLV =====`);
  console.log(`欧洲可回填推荐 ${totalEuro} 条, 成功匹配收盘 ${matched} 条\n`);
  if (matched) {
    const cl = ledger.filter((x) => x.clv != null);
    const avg = cl.reduce((s, x) => s + x.clv, 0) / cl.length;
    const pos = cl.filter((x) => x.clv > 0).length;
    const strongPos = cl.filter((x) => x.clv > 3).length;
    console.log(`平均 CLV ${avg.toFixed(2)}% | 正CLV ${pos}/${cl.length} (${(pos / cl.length * 100).toFixed(1)}%) | 强正(>3%) ${strongPos}`);
    console.log(`判读: 平均CLV>0 且 正CLV率≥55% = 长期有 edge; ≈0 或更低 = 跟随市场无 edge\n`);
    console.log(`${"日期".padEnd(11)}${"对阵".padEnd(20)}${"选".padEnd(5)}${"下注".padEnd(6)}${"收盘".padEnd(6)}CLV%`);
    for (const x of cl.slice(0, 25))
      console.log(`${x.date.padEnd(11)}${x.match.slice(0, 18).padEnd(20)}${x.pick.padEnd(5)}${String(x.betOdds).padEnd(6)}${String(x.closeOdds).padEnd(6)}${x.clv > 0 ? "+" : ""}${x.clv}`);
  } else {
    console.log("(未匹配到收盘——可能队名别名缺失或赛季CSV尚未含该轮, 见匹配率)");
  }
  fs.writeFileSync("D:/football-model-exports/clv-backfill-ledger.json", JSON.stringify({ totalEuro, matched, ledger }, null, 2));
  console.log("\nSAVED: D:/football-model-exports/clv-backfill-ledger.json");
})();

function seasonCode(dateStr) {
  // 2026-05 → 季 2025/26 → "2526"; 8月及以后算新赛季
  const d = new Date(dateStr); const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1;
  const start = mo >= 8 ? y : y - 1;
  return String(start % 100).padStart(2, "0") + String((start + 1) % 100).padStart(2, "0");
}
