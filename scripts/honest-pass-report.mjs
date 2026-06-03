/**
 * 诚实过关报告:对某日竞彩 picks 跑确定性 honest-pass-gate,分推荐池/观望池。
 * 用法:node scripts/honest-pass-report.mjs [--date YYYY-MM-DD]
 * 数据=本次 recommendFixtures 实时跑(禁假编),非缓存。
 */
import "../src/env.js";
import { recommendFixtures } from "../src/prediction-engine.js";
import { splitHonestPool } from "../src/honest-pass-gate.js";

const args = process.argv.slice(2);
const readArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

const rec = recommendFixtures(date);
const preds = (rec.predictions || []).filter((p) => (p.fixture?.marketType ?? "jingcai") !== "shengfucai");

const rows = preds.map((p) => {
  const f = p.fixture || {};
  return {
    match: `${f.homeTeam} vs ${f.awayTeam}`,
    competition: f.competition,
    direction: p.pick?.label,
    prob: p.pick?.probability,
    ev: p.expectedValue?.primary?.ev,
    risk: p.risk,
    confidence: p.confidence,
    divergencePp: p.marketDivergence?.divergence,
    aligned: p.marketDivergence?.aligned,
    softLeague: p.multimodal?.regime?.leagueMode === "soft-international",
  };
});

const { pass, watch, judged } = splitHonestPool(rows);

console.log(`\n===== 诚实过关报告 ${date} =====`);
console.log(`竞彩 ${rows.length} 注 → 过关 ${pass.length} / 观望 ${watch.length}\n`);
for (const r of judged) {
  console.log(`${r.honest.pass ? "✅" : "🔻"} ${r.match} | ${r.direction} ${(r.prob * 100).toFixed(1)}% | EV ${r.ev != null ? r.ev.toFixed(3) : "—"} | 风险 ${r.risk} | ${r.competition}`);
  console.log(`   ${r.honest.verdict}`);
  for (const c of r.honest.checks) console.log(`     ${c.ok ? "✓" : "✗"} ${c.name}:${c.detail}`);
}
console.log(`\n推荐池(诚实过关):${pass.length ? pass.map((r) => r.match + " " + r.direction).join(" / ") : "（空 — 今日无注满足全部 5 条,诚实结论=观望/空仓）"}`);
