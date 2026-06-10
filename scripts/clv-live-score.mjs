// 实时CLV评分: 用 capture-closing 冻结的 final(收盘) 给历史推荐打 CLV
// ──────────────────────────────────────────────────────────────────────────
// ⚠️ 预期管理(已裁决,2026-06-05 + 2026-06-10 复确认):CLV **只作监控不作 edge**。
//   回测已证模型无 CLV edge,本脚本绝不被任何选注逻辑消费;它只回答"我们的推荐价
//   相对收盘价被市场怎么修正"这一个监控问题。
//
// 2026-06-10 缺陷#9 配套修(滚动摄入):
//   旧版只读 D:/football-model-data/exports/all-match-recommendations-*.json(最后一份 5-16)
//   → ledger 全是 5-16 旧 picks,每日计划任务空转。改为双源:
//   ① recommendation-ledger.json(每日 daily-report 滚动追加的当日 picks,含 primaryOdds 下注价)
//   ② 遗留 all-match-recommendations-*.json(5 月历史,保留对账)
//   按 日期|对阵|方向 去重合并。时区根修后 capture-closing-live 能真冻结收盘,新 picks 自动进监控。
// 落盘:持久 ledger 进 D:\football-model-data\clv\(exports 根有 16:01 清空史,勿放持久件);
//   exports 根只留一份每日重建的只读副本(供手机页/对账,丢了无所谓)。
// 用法: node scripts/clv-live-score.mjs

import fs from "node:fs";
import { join } from "node:path";
import { canonicalTeamName } from "../src/team-aliases.js";
import { loadMarketSnapshots } from "../src/market-data-store.js";
import { computeCLV } from "../src/clv-confidence-gate.js";
import { getDataDir, getExportDir, getDataSubdir } from "../src/paths.js";

const PICK = { 主胜: "home", 平局: "draw", 客胜: "away" };

// 统一一条"待打分 pick":{ date, match: "主 vs 客", pick, betOdds, comp, sequence? }
function legacyPicks() {
  const ex = join(getDataDir(), "exports");
  if (!fs.existsSync(ex)) return [];
  const out = [];
  for (const rf of fs.readdirSync(ex).filter((f) => /^all-match-recommendations-.*\.json$/.test(f)).sort()) {
    let j;
    try { j = JSON.parse(fs.readFileSync(join(ex, rf), "utf8")); } catch { continue; }
    const date = j.date || rf.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) continue;
    for (const r of (j.rows || [])) {
      if (!r.odds || !PICK[r.pick]) continue;
      const betOdds = r.odds[PICK[r.pick]];
      out.push({ date, match: String(r.match), pick: r.pick, betOdds, comp: r.competition ?? null, sequence: null });
    }
  }
  return out;
}

// 滚动源:recommendation-ledger.json(daily-report 每日追加;primaryOdds=推荐时刻下注价,null=当时无价,如实跳过不编)
function ledgerPicks() {
  const p = join(getExportDir(), "recommendation-ledger.json");
  if (!fs.existsSync(p)) return [];
  let entries;
  try { entries = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries) {
    if (!e?.date || !PICK[e.primary]) continue;
    const betOdds = Number(e.primaryOdds);
    if (!(betOdds > 1)) continue; // 推荐时刻没有可信下注价 → 无法算 CLV,如实跳过(绝不用收盘价冒充下注价)
    const match = String(e.match ?? "").replace(/\s*对\s*/, " vs ");
    out.push({ date: e.date, match, pick: e.primary, betOdds, comp: e.competition ?? null, sequence: e.sequence != null ? String(e.sequence) : null });
  }
  return out;
}

(async () => {
  const picks = [...legacyPicks(), ...ledgerPicks()];
  const seen = new Set();
  const ledger = [];
  let total = 0, matched = 0, nonTrivial = 0, liveCaptured = 0;

  // 按日期分组,市场快照每日只加载一次
  const byDate = new Map();
  for (const p of picks) {
    const dk = `${p.date}|${p.match}|${p.pick}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }

  for (const [date, datePicks] of [...byDate.entries()].sort()) {
    const snaps = loadMarketSnapshots(date).snapshots;
    if (!snaps.length) { total += datePicks.length; continue; }
    const idx = new Map();
    const seqIdx = new Map();
    for (const s of snaps) {
      idx.set(`${canonicalTeamName(s.homeTeam)}|${canonicalTeamName(s.awayTeam)}`, s);
      if (s.sequence != null) seqIdx.set(String(s.sequence), s);
    }
    for (const p of datePicks) {
      total++;
      const [h, a] = String(p.match).split(/\s*vs\s*/i);
      const s = (p.sequence && seqIdx.get(p.sequence)) || idx.get(`${canonicalTeamName(h)}|${canonicalTeamName(a)}`);
      const fin = s?.europeanOdds?.final;
      if (!fin) continue;
      const closeOdds = fin[PICK[p.pick]];
      if (!(p.betOdds > 1 && closeOdds > 1)) continue;
      matched++;
      const clv = computeCLV(p.betOdds, closeOdds);
      if (Math.abs(clv.clv) > 0.5) nonTrivial++;
      // 诚实标注收盘来源:live-capture=临场轮询真收盘;frozen-current=爬虫最后一次 current(可能≈早盘)
      const closingKind = s.closingLiveCapturedAt ? "live-capture" : "frozen-current";
      if (closingKind === "live-capture") liveCaptured++;
      ledger.push({ date, match: p.match, pick: p.pick, betOdds: p.betOdds, closeOdds, clv: clv.clv, comp: p.comp, closingKind });
    }
  }

  console.log(`\n===== 实时CLV评分 (用冻结收盘 final, 全联赛;只作监控不作edge) =====`);
  console.log(`picks ${total} 条(去重后), 匹配到收盘 ${matched} 条, 其中真临场捕获收盘 ${liveCaptured} 条, CLV≠0 ${nonTrivial} 条`);
  if (matched) {
    const cl = ledger.filter((x) => x.clv != null);
    const avg = cl.reduce((s, x) => s + x.clv, 0) / cl.length;
    const pos = cl.filter((x) => x.clv > 0).length;
    console.log(`平均 CLV ${avg.toFixed(2)}% | 正CLV ${pos}/${cl.length} (${(pos / cl.length * 100).toFixed(1)}%)`);
    if (liveCaptured < matched * 0.3)
      console.log(`⚠️ 多数收盘=frozen-current(非临场捕获), final 可能≈早盘; capture-closing-live 时区已根修(2026-06-10),新场次起 live-capture 占比应回升。`);
  }
  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), total, matched, liveCaptured, nonTrivial, note: "CLV只作监控不作edge(已裁决)", ledger }, null, 2);
  const persistDir = getDataSubdir("clv");
  fs.mkdirSync(persistDir, { recursive: true });
  const persistPath = join(persistDir, "clv-live-ledger.json");
  fs.writeFileSync(persistPath, payload);
  // exports 根副本:仅展示用(该目录有 16:01 清空史,每日由计划任务重建,丢失无碍)
  const exportCopy = join(getExportDir(), "clv-live-ledger.json");
  try { fs.writeFileSync(exportCopy, payload); } catch {}
  console.log(`SAVED: ${persistPath}(持久) + ${exportCopy}(展示副本)`);
})();
