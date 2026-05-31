// CLV + 背离置信门: 历史验证 + 应用到真实推荐
// ──────────────────────────────────────────────────────────────────────────
// ① 验证(真实 football-data): 把"独立模型(Elo) 是否与市场开盘同向"分桶, 看实测命中率
//    —— 证明"与市场同向→更准"(置信门是校准的, 不是拍脑袋)。
// ② CLV 机器: 在 open(下注)→close(收盘) 上跑通, 报"押市场热门"的平均CLV。
// ③ 应用: 把 gate() 套到最新真实推荐行, 输出哪些该降档。
// 用法: node scripts/clv-confidence-gate-report.mjs

import { gate, computeCLV, devig } from "../src/clv-confidence-gate.js";
import fs from "node:fs";

const BASE = "https://www.football-data.co.uk/mmz4281";
const SEASON_CODES = ["2122", "2223", "2324", "2425"];
const LEAGUES = ["E0", "E1", "D1", "SP1", "I1", "F1"];
const HOME_ADV = 60, ELO_K = 20, MIN_GAMES = 6;

function n(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function d3(h, d, a) { if (!(h && d && a)) return null; const s = 1 / h + 1 / d + 1 / a; return { h: 1 / h / s, d: 1 / d / s, a: 1 / a / s }; }
function pd(s) { const m = s.split("/"); if (m.length !== 3) return 0; let [d, mo, y] = m.map((x) => +x); if (y < 100) y += 2000; return Date.UTC(y, mo - 1, d); }

async function load() {
  const all = [];
  for (const lg of LEAGUES) for (const sc of SEASON_CODES) {
    try {
      const r = await fetch(`${BASE}/${sc}/${lg}.csv`); if (!r.ok) continue;
      const lines = (await r.text()).split(/\r?\n/).filter((l) => l.trim());
      const head = lines[0].split(","); const ix = (k) => head.indexOf(k);
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(","); if (c.length < 10) continue;
        const ftr = c[ix("FTR")]; if (!"HDA".includes(ftr)) continue;
        const open = d3(n(c[ix("AvgH")]), n(c[ix("AvgD")]), n(c[ix("AvgA")])) ?? d3(n(c[ix("B365H")]), n(c[ix("B365D")]), n(c[ix("B365A")]));
        const oOpenH = n(c[ix("AvgH")]) ?? n(c[ix("B365H")]);
        const oCloseH = n(c[ix("AvgCH")]) ?? n(c[ix("B365CH")]);
        if (!open) continue;
        all.push({ home: c[ix("HomeTeam")], away: c[ix("AwayTeam")], ftr, open, oOpenH, oCloseH, ts: pd(c[ix("Date")]) });
      }
    } catch {}
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
}

(async () => {
  const data = await load();
  console.error(`[load] ${data.length} 场`);

  // ── ① 验证: Elo 与市场同向/背离 → 实测命中 ──
  const elo = new Map(); const games = new Map();
  const g = (t) => elo.get(t) ?? 1500;
  const buckets = { 同向: { n: 0, hit: 0 }, 次热: { n: 0, hit: 0 }, 逆市: { n: 0, hit: 0 } };
  let clvSum = 0, clvN = 0, clvPos = 0;

  for (const m of data) {
    const gh = games.get(m.home) ?? 0, ga = games.get(m.away) ?? 0;
    if (gh >= MIN_GAMES && ga >= MIN_GAMES) {
      // Elo → 选项
      const dr = g(m.home) + HOME_ADV - g(m.away);
      const pH = 1 / (1 + Math.pow(10, -dr / 400));
      const drawB = 0.27 * (1 - Math.min(0.6, Math.abs(pH - 0.5) * 1.2));
      const eloP = { home: (1 - drawB) * pH, draw: drawB, away: (1 - drawB) * (1 - pH) };
      const eloPick = eloP.home >= eloP.draw && eloP.home >= eloP.away ? "home" : eloP.draw >= eloP.away ? "draw" : "away";
      const mk = [["home", m.open.h], ["draw", m.open.d], ["away", m.open.a]].sort((a, b) => b[1] - a[1]);
      const rank = mk.findIndex((e) => e[0] === eloPick);
      const lvl = rank === 0 ? "同向" : rank === 1 ? "次热" : "逆市";
      const actual = m.ftr === "H" ? "home" : m.ftr === "D" ? "draw" : "away";
      buckets[lvl].n++; if (eloPick === actual) buckets[lvl].hit++;

      // CLV: 押市场热门, open→close
      if (m.oOpenH && m.oCloseH && m.open.h >= m.open.d && m.open.h >= m.open.a) {
        const r = computeCLV(m.oOpenH, m.oCloseH);
        if (r.clv != null) { clvSum += r.clv; clvN++; if (r.clv > 0) clvPos++; }
      }
    }
    // 更新 Elo
    const eh = g(m.home), ea = g(m.away);
    const exp = 1 / (1 + Math.pow(10, -((eh + HOME_ADV - ea) / 400)));
    const sh = m.ftr === "H" ? 1 : m.ftr === "D" ? 0.5 : 0;
    elo.set(m.home, eh + ELO_K * (sh - exp)); elo.set(m.away, ea + ELO_K * ((1 - sh) - (1 - exp)));
    games.set(m.home, gh + 1); games.set(m.away, ga + 1);
  }

  console.log(`\n===== ① 置信门校准验证 (Elo vs 市场开盘, 真实 ${LEAGUES.length}联赛×${SEASON_CODES.length}季) =====`);
  console.log(`${"模型相对市场".padEnd(8)}  ${"场数".padEnd(6)}  实测命中%`);
  for (const k of ["同向", "次热", "逆市"]) {
    const b = buckets[k]; if (!b.n) continue;
    console.log(`${k.padEnd(10)}  ${String(b.n).padEnd(6)}  ${(b.hit / b.n * 100).toFixed(1)}%`);
  }
  console.log(`→ 命中率应随"同向"递增, 印证: 与市场背离时模型该降档。`);

  console.log(`\n===== ② CLV 机器验证 (押市场热门, open→close 收盘) =====`);
  console.log(`样本 ${clvN} 场, 平均CLV ${(clvSum / clvN).toFixed(2)}%, 正CLV占比 ${(clvPos / clvN * 100).toFixed(1)}%`);
  console.log(`→ 押"开盘热门"对收盘平均CLV≈${(clvSum / clvN).toFixed(1)}%(≈0 说明开盘热门已被收盘修正, 无价); 真正+CLV要靠抢错价/早盘。`);

  // ── ③ 应用到最新真实推荐 ──
  const exDir = "D:/football-model-data/exports";
  const recFiles = fs.readdirSync(exDir).filter((f) => /^all-match-recommendations-.*\.json$/.test(f)).sort();
  console.log(`\n===== ③ 应用置信门到最新真实推荐 =====`);
  if (!recFiles.length) { console.log("(无 all-match-recommendations 产出)"); return; }
  const recPath = `${exDir}/${recFiles[recFiles.length - 1]}`;
  const rj = JSON.parse(fs.readFileSync(recPath, "utf8"));
  const rows = rj.rows || [];
  console.log(`文件 ${recFiles[recFiles.length - 1]}, ${rows.length} 条推荐`);
  let down = 0; const gated = [];
  for (const r of rows) {
    const res = gate(r);
    if (res.confidenceMultiplier < 1) down++;
    gated.push({ match: r.match, pick: r.pick, conf: r.confidence, ...res });
  }
  console.log(`其中 ${down}/${rows.length} 条与市场背离 → 触发降档`);
  console.log(`\n${"对阵".padEnd(22)} ${"模型选".padEnd(6)} ${"市场热".padEnd(6)} ${"判定".padEnd(8)} 原置信→门后`);
  for (const x of gated.slice(0, 20)) {
    const mp = { home: "主", draw: "平", away: "客" }[x.marketPick] ?? "-";
    console.log(`${(x.match || "").slice(0, 20).padEnd(22)} ${(x.pick || "").padEnd(6)} ${mp.padEnd(7)} ${(x.fightLevel || "").padEnd(8)} ${x.conf ?? "-"}→${x.gatedConfidence ?? "-"}`);
  }

  fs.writeFileSync("D:/football-model-exports/clv-confidence-gate.json", JSON.stringify({
    validation: { buckets, clv: { n: clvN, avgPct: clvSum / clvN, posRate: clvPos / clvN } },
    appliedTo: recFiles[recFiles.length - 1], downgraded: down, total: rows.length, gated,
  }, null, 2));
  console.log("\nSAVED: D:/football-model-exports/clv-confidence-gate.json");
})();
