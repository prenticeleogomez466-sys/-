// 诚实回测套件总入口(过夜轮14)——一条命令复现整夜全部验证,回归守护模型"诚实能力声明"。
// ───────────────────────────────────────────────────────────────────────────
// 默认:打印套件清单(每项证什么 + 已验证结论 + 怎么跑),不强跑(各回测 2-5min)。
// --run:依次执行全部,捕获 exit + 关键行,写汇总到 exports;任一非零=诚实声明可能漂移,需查。
// 用法:node scripts/run-honest-backtest-suite.mjs [--run] [--only=score,ou]
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";

const SUITE = [
  { key: "selfcheck", script: "scripts/overnight-selfcheck.mjs --full", proves: "结构/可达性/今日包/全测试 全绿基线", verified: "GREEN · 671测试 · 0僵尸 · prod90" },
  { key: "upset", script: "scripts/run-upset-trap-backtest.mjs", proves: "爆冷风险/盘口移动方向", verified: "加注55.5%vs退烧52.7%·强度档单调·风险校准差0.8pp" },
  { key: "trap", script: "scripts/run-trap-verdict-backtest.mjs", proves: "诱盘判定有无下注edge", verified: "无edge(诱盘嫌疑桶热门反跑赢+2.9pp)·市场更准" },
  { key: "ou", script: "scripts/run-overunder-vs-market-backtest.mjs", proves: "大小球模型vs收盘线", verified: "市场59%>模型57%·分歧无edge" },
  { key: "ou-ext", script: "scripts/run-overunder-vs-market-backtest.mjs --leagues=extended", proves: "冷门O/U速度/CLV", verified: "次级53%朝模型(big-5 49%)·+0.24pp极微不可套利" },
  { key: "score-hf", script: "scripts/run-score-halffull-quality-backtest.mjs", proves: "比分/半全场模型质量(真实HT)", verified: "半全场31.4%(+5.1pp胜naive·真价值)·比分top3 32.9%" },
  { key: "ou-league", script: "scripts/run-overunder-backtest.mjs", proves: "联赛级O/U率维度是否加分", verified: "联赛Brier 0.2472<全局0.2494(微加)·热门档无关" },
];

const args = process.argv.slice(2);
const doRun = args.includes("--run");
const only = (args.find((a) => a.startsWith("--only="))?.split("=")[1] ?? "").split(",").filter(Boolean);
const picked = only.length ? SUITE.filter((s) => only.includes(s.key)) : SUITE;

console.log("=== 诚实回测套件(模型能力验证清单)===\n");
for (const s of SUITE) console.log(`[${s.key}] ${s.proves}\n   已验证: ${s.verified}\n   跑: node ${s.script}\n`);

if (!doRun) {
  console.log("提示:加 --run 依次执行全部(各 2-5min,慢);--only=score-hf,trap 选跑。默认仅打印清单。");
  process.exit(0);
}

console.log(`\n=== --run:依次执行 ${picked.length} 项(慢)===\n`);
const results = [];
for (const s of picked) {
  const t0 = process.hrtime.bigint();
  let ok = true, tail = "";
  try {
    const out = execSync(`node ${s.script}`, { cwd: process.cwd(), encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", "pipe"] });
    tail = out.trim().split("\n").slice(-4).join(" | ");
  } catch (e) {
    ok = false; tail = String(e.stdout ?? e.message).trim().split("\n").slice(-3).join(" | ");
  }
  const sec = Number((process.hrtime.bigint() - t0) / 1000000000n);
  results.push({ key: s.key, ok, sec, tail });
  console.log(`${ok ? "✅" : "❌"} [${s.key}] ${sec}s — ${tail}\n`);
}
const summary = { ranAt: null, total: results.length, passed: results.filter((r) => r.ok).length, results };
const outPath = join(getExportDir(), "honest-backtest-suite-latest.json");
writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
console.log(`汇总 ${summary.passed}/${summary.total} 通过 → ${outPath}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
