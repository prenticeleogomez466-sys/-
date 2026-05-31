// 实时CLV评分: 用 capture-closing 冻结的 final(收盘) 给历史推荐打 CLV
// ──────────────────────────────────────────────────────────────────────────
// 覆盖 football-data 够不到的联赛(日职/K联/挪超/瑞超…)。把推荐(all-match-recommendations)
// 按 队名canonical+日期 匹配 market 快照的 europeanOdds.final, 算 CLV。
// ⚠️诚实: final 由 capture-closing 冻结自爬虫最后一次 current; 若该日 current 未临场更新,
//   则 final≈早盘, CLV≈0(非真收盘)。真收盘需爬虫临场轮询(见 capture-closing 说明)。
// 用法: node scripts/clv-live-score.mjs

import fs from "node:fs";
import { canonicalTeamName } from "../src/team-aliases.js";
import { loadMarketSnapshots } from "../src/market-data-store.js";
import { computeCLV } from "../src/clv-confidence-gate.js";

const PICK = { 主胜: "home", 平局: "draw", 客胜: "away" };

(async () => {
  const ex = "D:/football-model-data/exports";
  const recFiles = fs.readdirSync(ex).filter((f) => /^all-match-recommendations-.*\.json$/.test(f)).sort();
  const ledger = [];
  let total = 0, matched = 0, nonTrivial = 0;

  for (const rf of recFiles) {
    const j = JSON.parse(fs.readFileSync(`${ex}/${rf}`, "utf8"));
    const date = j.date || rf.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) continue;
    const snaps = loadMarketSnapshots(date).snapshots;
    if (!snaps.length) continue;
    const idx = new Map();
    for (const s of snaps) idx.set(`${canonicalTeamName(s.homeTeam)}|${canonicalTeamName(s.awayTeam)}`, s);

    for (const r of (j.rows || [])) {
      if (!r.odds || !PICK[r.pick]) continue;
      total++;
      const [h, a] = String(r.match).split(/\s*vs\s*/);
      const s = idx.get(`${canonicalTeamName(h)}|${canonicalTeamName(a)}`);
      const fin = s?.europeanOdds?.final;
      if (!fin) continue;
      const betOdds = r.odds[PICK[r.pick]], closeOdds = fin[PICK[r.pick]];
      if (!(betOdds > 1 && closeOdds > 1)) continue;
      matched++;
      const clv = computeCLV(betOdds, closeOdds);
      if (Math.abs(clv.clv) > 0.5) nonTrivial++;
      ledger.push({ date, match: r.match, pick: r.pick, betOdds, closeOdds, clv: clv.clv, comp: r.competition });
    }
  }

  console.log(`\n===== 实时CLV评分 (用冻结收盘 final, 全联赛) =====`);
  console.log(`推荐 ${total} 条, 匹配到收盘 ${matched} 条, 其中CLV≠0(收盘真有移动) ${nonTrivial} 条`);
  if (matched) {
    const cl = ledger.filter((x) => x.clv != null);
    const avg = cl.reduce((s, x) => s + x.clv, 0) / cl.length;
    const pos = cl.filter((x) => x.clv > 0).length;
    console.log(`平均 CLV ${avg.toFixed(2)}% | 正CLV ${pos}/${cl.length} (${(pos / cl.length * 100).toFixed(1)}%)`);
    if (nonTrivial < matched * 0.3)
      console.log(`⚠️ 多数 CLV≈0 → 这些日期快照 current 未临场更新, final≈早盘; 等爬虫临场轮询后此评分才反映真收盘。`);
  }
  fs.writeFileSync("D:/football-model-exports/clv-live-ledger.json", JSON.stringify({ total, matched, nonTrivial, ledger }, null, 2));
  console.log("SAVED: D:/football-model-exports/clv-live-ledger.json");
})();
