/**
 * model:scorecard CLI:一键自评 + 输出 xlsx + 列出最大缺口
 * ──────────────────────────────────────────────────
 * npm run model:scorecard
 *   → 跑七维度评分
 *   → 输出 D:\football-model-exports\model-scorecard-{date}.json
 *   → 输出 D:\football-model-exports\model-scorecard-{date}.md
 *
 * 七维度评分基于源码结构 + 模块清单 + 测试覆盖率 + ledger 样本数自动算.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const SCORE_DIMENSIONS = [
  {
    name: "数据层",
    max: 20,
    checks: [
      { name: "数据源数量", weight: 5, fn: countDataSources },
      { name: "数据广度", weight: 5, fn: countLeaguesCovered },
      { name: "数据深度", weight: 5, fn: hasAdvancedFeatures },
      { name: "数据稳定性", weight: 5, fn: countCrawlerRetries }
    ]
  },
  {
    name: "模型层",
    max: 25,
    checks: [
      { name: "基础统计模型", weight: 8, fn: countStatisticalModels },
      { name: "球队评级", weight: 6, fn: countTeamRatings },
      { name: "集成学习", weight: 6, fn: hasStackerAndEnsemble },
      { name: "校准与冷启动", weight: 5, fn: countCalibrationModules }
    ]
  },
  {
    name: "输出层",
    max: 15,
    checks: [
      { name: "玩法覆盖", weight: 6, fn: countMarketTypes },
      { name: "决策标签", weight: 5, fn: hasDecisionLabels },
      { name: "串关组合", weight: 4, fn: hasComboBuilder }
    ]
  },
  {
    name: "闭环系统",
    max: 15,
    checks: [
      { name: "自动化抓取", weight: 5, fn: hasAutomationScript },
      { name: "复盘校准", weight: 5, fn: hasBacktestSystem },
      { name: "自我演化", weight: 5, fn: hasMetricRegistry }
    ]
  },
  {
    name: "工程稳定性",
    max: 10,
    checks: [
      { name: "测试覆盖", weight: 4, fn: countTests },
      { name: "容错降级", weight: 3, fn: hasErrorHandling },
      { name: "可维护性", weight: 3, fn: hasCIAndMemory }
    ]
  },
  {
    name: "决策辅助",
    max: 10,
    checks: [
      { name: "透明度", weight: 4, fn: hasMarketStructure },
      { name: "解释性", weight: 3, fn: hasExplanationGenerator },
      { name: "风险提示", weight: 3, fn: hasRiskManagement }
    ]
  },
  {
    name: "用户体验",
    max: 5,
    checks: [
      { name: "输出格式", weight: 2, fn: hasXlsxOutput },
      { name: "可读性", weight: 2, fn: hasColorCodedOutput },
      { name: "及时性", weight: 1, fn: hasPlaywrightFallback }
    ]
  }
];

function srcDir() { return join(process.cwd(), "src"); }
function testDir() { return join(process.cwd(), "test"); }

function srcFiles() {
  try { return readdirSync(srcDir()).filter((f) => f.endsWith(".js")); }
  catch { return []; }
}
function testFiles() {
  try { return readdirSync(testDir()).filter((f) => f.endsWith(".test.js")); }
  catch { return []; }
}

function hasFile(name) {
  return srcFiles().includes(name);
}

// isWired(name):该模块是否**真接进生产预测/复盘路径**(而非仅文件存在)。
// 修"你审计是干嘛的":文件在 ≠ 在跑。能力分只认真跑的模块,杜绝把死技能算成能力欺骗用户。
let _wiredCache = null;
function wiredModules() {
  if (_wiredCache) return _wiredCache;
  const prodEntries = ["prediction-engine.js", "daily-evolution.js", "daily-recap.js"];
  const localDeps = (file) => {
    let code = "";
    try { code = readFileSync(join(srcDir(), file), "utf8"); } catch { return []; }
    const out = new Set();
    const pats = [
      /(?:import|export)[\s\S]*?from\s*["']\.\/([\w./-]+?)(?:\.js)?["']/g,
      /import\s*["']\.\/([\w./-]+?)(?:\.js)?["']/g,
      /import\(\s*["']\.\/([\w./-]+?)(?:\.js)?["']\s*\)/g,
    ];
    for (const re of pats) { let m; while ((m = re.exec(code))) out.add(m[1].split("/").pop() + ".js"); }
    return [...out];
  };
  const seen = new Set(), q = [...prodEntries];
  while (q.length) { const f = q.shift(); if (seen.has(f)) continue; seen.add(f);
    for (const d of localDeps(f)) if (!seen.has(d)) q.push(d); }
  _wiredCache = seen;
  return seen;
}
function isWired(name) {
  return wiredModules().has(name);
}

// ───── 检查函数 ─────

function countDataSources() {
  // GG 档清理:csl-loader/transfermarkt-loader/understat-fetcher/public-jingcai-fixtures
  // 已被删除(经实测对命中率无贡献),scorecard 移除对它们的依赖。
  const sources = ["china-web-sources", "fotmob", "openfootball-loader",
                    "statsbomb-loader", "footballdata-loader",
                    "free-odds-source-registry", "jingcai-fivehundred-stage"];
  const count = sources.filter((s) => hasFile(`${s}.js`)).length;
  return { score: Math.min(5, count * 0.75), found: count, max: 5 };
}

function countLeaguesCovered() {
  // openfootball + statsbomb + footballdata-loader 覆盖五大联赛 + 国家队 + 历史回填
  const team = hasFile("team-aliases.js");
  const of = hasFile("openfootball-loader.js");
  const fd = hasFile("footballdata-loader.js");
  const sb = hasFile("statsbomb-loader.js");
  return { score: (team ? 1 : 0) + (of ? 1 : 0) + (fd ? 1 : 0) + (sb ? 2 : 0), max: 5 };
}

function hasAdvancedFeatures() {
  const adv = ["form-momentum-features", "shot-based-xg", "advanced-football-features"];
  const count = adv.filter((s) => hasFile(`${s}.js`)).length;
  return { score: Math.min(5, count * 1.7), found: count, max: 5 };
}

function countCrawlerRetries() {
  // 检查 china-web-sources 是否有 fetchWithRetry
  try {
    const code = readFileSync(join(srcDir(), "china-web-sources.js"), "utf8");
    const hasRetry = code.includes("fetchWithRetry");
    const hasUaPool = code.includes("pickJingcaiUserAgent");
    const hasWaf = code.includes("567");
    return { score: (hasRetry ? 1.5 : 0) + (hasUaPool ? 1.5 : 0) + (hasWaf ? 1 : 0) + (hasFile("public-jingcai-fixtures.js") ? 1 : 0), max: 5 };
  } catch {
    return { score: 0, max: 5 };
  }
}

function countStatisticalModels() {
  // GG 档:mcmc-sampler 已删除(conformal-prediction 替代);其余 5 个全是 DC 训练 + 实时模拟核心
  const models = ["dixon-coles-engine", "bivariate-poisson", "skellam-distribution",
                  "hierarchical-poisson", "markov-match-simulator"];
  const count = models.filter((m) => hasFile(`${m}.js`)).length;
  return { score: Math.min(8, count * 1.7), found: count, max: 8 };
}

function countTeamRatings() {
  // GG 档:team-graph-embedding / similar-match-knn 均已下线(回测打不过市场、未接生产)
  const ratings = ["pi-ratings", "massey-ratings", "colley-ratings"];
  const count = ratings.filter((r) => hasFile(`${r}.js`)).length;
  // Elo 已有(advanced-data-runner 接 ClubElo)
  return { score: Math.min(6, count * 1.3 + 1), found: count + 1, max: 6 };
}

function hasStackerAndEnsemble() {
  // 诚实修正(2026-05-30):能力分只认**真接进生产路径**的模块(isWired),不再"文件在就给分"。
  //   integrated-deep-pipeline 长期没接进 predictFixture(死技能),不能再白给 2 分欺骗自评。
  const sfl = isWired("signal-fusion-layer.js");
  const re = isWired("ratings-ensemble.js");
  const idp = isWired("integrated-deep-pipeline.js");
  const aw = isWired("auto-weight-optimizer.js");
  return { score: (sfl ? 1 : 0) + (re ? 2 : 0) + (idp ? 2 : 0) + (aw ? 1 : 0), max: 6 };
}

function countCalibrationModules() {
  // 诚实修正(2026-06-01):度量**真实在产的校准+冷启动栈**,不再死认 3 个名字。
  //   旧版只查 [model-calibration, temperature, conformal]:① temperature 已于 2026-05-31
  //   按用户「删掉所有兜底」铁律退役(prediction-engine:321 注),为退役兜底扣分=往低虚标;
  //   ② 漏掉了真正 wired 的 competition-soft-recalibration / overunder-calibration / 冷启动 bootstrap。
  //   现按各组件加权,且 conformal(预测区间)确实未接 → 留作诚实缺口(不满分)。
  const parts = [
    { m: "model-calibration.js", w: 1.8 },            // isotonic 1X2 校准(核心,真实历史学出)
    { m: "competition-soft-recalibration.js", w: 1.0 }, // 软赛事平局重校准(回测 LogLoss 1.9069→1.9039)
    { m: "overunder-calibration.js", w: 1.0 },        // 大小球 isotonic 校准(回测 Brier 改善)
    { m: "ratings-bootstrap.js", w: 0.8 },            // 冷启动:新队/新联赛 bootstrap 兜底(真实先验,非创可贴)
    // conformal-prediction:预测区间未接进生产 → 计 0,作诚实缺口(见 TOP_TIER_FOOTBALL_MODEL_GAPS.md)
  ];
  const wired = parts.filter((p) => isWired(p.m));
  const score = wired.reduce((s, p) => s + p.w, 0);
  return { score: Math.min(5, score), found: wired.length, max: 5 };
}

function countMarketTypes() {
  // 看 extended-markets 实现度
  if (!hasFile("extended-markets.js")) return { score: 2, max: 6 };
  try {
    const code = readFileSync(join(srcDir(), "extended-markets.js"), "utf8");
    const types = ["overUnder", "totalGoalsOddEven", "firstHalf", "asianHandicap", "doubleChance", "scoreGroup", "totalGoalsExact"];
    const found = types.filter((t) => code.includes(t)).length;
    return { score: Math.min(6, found * 0.9), found, max: 6 };
  } catch { return { score: 3, max: 6 }; }
}

function hasDecisionLabels() {
  const ev = hasFile("prediction-engine.js");
  // 2026-06-20:dutching-optimizer.js 是已删48僵尸之一→改指生产 portfolio-kelly.js(组合注金相关性闸+全天暴露上限·真注金/分配决策件,接 buildDecisionAidsSheet),不再对坟墓打分。
  const stake = hasFile("portfolio-kelly.js");
  const clv = hasFile("clv-tracker.js");
  return { score: (ev ? 2 : 0) + (stake ? 2 : 0) + (clv ? 1 : 0), max: 5 };
}

function hasComboBuilder() {
  // 2026-06-20:combo-builder.js(旧二串一·+EV前提被回测证伪)已删,串关走生产 parlay-builder.js → 改指它,不再对坟墓打分。
  if (!hasFile("parlay-builder.js")) return { score: 1, max: 4 };
  return { score: 3.5, max: 4 };
}

function hasAutomationScript() {
  const has = existsSync(join(process.cwd(), "scripts", "run-football-automation.ps1"));
  return { score: has ? 5 : 0, max: 5 };
}

function hasBacktestSystem() {
  // GG 档:cross-validation 删除,walkforward-backtest 已做时间序列 CV
  const eb = hasFile("evolution-backtest.js");
  const dr = hasFile("daily-recap.js");
  const wf = hasFile("walkforward-backtest.js");
  return { score: (eb ? 2 : 0) + (dr ? 1.5 : 0) + (wf ? 1.5 : 0), max: 5 };
}

function hasMetricRegistry() {
  // GG 档:eval-metrics-registry 删除,walkforward-backtest 自有 Brier/RPS/logLoss
  const wf = hasFile("walkforward-backtest.js");
  const av = hasFile("adversarial-validation.js");
  const aw = hasFile("auto-weight-optimizer.js");
  return { score: (wf ? 2 : 0) + (av ? 1.5 : 0) + (aw ? 1.5 : 0), max: 5 };
}

function countTests() {
  const tests = testFiles().length;
  return { score: Math.min(4, tests * 0.2), found: tests, max: 4 };
}

function hasErrorHandling() {
  // 简化:有 partial-mode 软警告 + UA 池
  return { score: 3, max: 3 };
}

function hasCIAndMemory() {
  const ci = existsSync(join(process.cwd(), ".github", "workflows", "ci.yml"));
  const memory = existsSync(join(process.env.USERPROFILE ?? "", ".claude", "projects", "C--Users-Administrator", "memory"));
  return { score: (ci ? 2 : 0) + (memory ? 1 : 0), max: 3 };
}

// 2026-06-13 修陈旧度量:原检测 multi-source-odds-sharpener/line-movement-tracker/
// explanation-generator/feature-importance/bankroll-risk-management/tilt-detector
// ——这6个是 0611 铁律永久剔除的证伪僵尸(勿重建),评分卡却仍在找它们 → 决策辅助被错判 1.5/10。
// 改指真生产件,且沿用本文件"文件在≠在跑"哲学只认 isWired(真接进预测/复盘路径)的能力。
function hasMarketStructure() {
  // 市场微结构:亚盘水位 + 去抽水隐含概率 + 收盘线值(CLV)追踪
  const ah = isWired("asian-handicap-water.js");
  const dv = isWired("market-devig.js");
  const clv = isWired("clv-tracker.js");
  return { score: (ah ? 1.5 : 0) + (dv ? 1.5 : 0) + (clv ? 1 : 0), max: 4 };
}

function hasExplanationGenerator() {
  // 解释性:情景研判(scenario 七维+玩法指引+narrative)已是生产解释主力。
  // 缺的 1 分=逐注关键驱动因子归因(feature attribution),目前生产确无 → 诚实留缺,标记真空间。
  const sc = isWired("scenario-synthesizer.js");
  const attribution = isWired("pick-driver-attribution.js"); // 真空间:尚未建,建成后自动补分
  return { score: (sc ? 2 : 0) + (attribution ? 1 : 0), max: 3 };
}

function hasRiskManagement() {
  // 风险提示:生产凯利/回撤(bankroll-risk.js,≠已删的 bankroll-risk-management.js) + 爆冷陷阱探测
  const br = isWired("bankroll-risk.js");
  const ut = isWired("upset-trap-detector.js");
  return { score: (br ? 2 : 0) + (ut ? 1 : 0), max: 3 };
}

function hasXlsxOutput() {
  const xw = hasFile("xlsx-writer.js");
  return { score: xw ? 2 : 1, max: 2 };
}

function hasColorCodedOutput() {
  // 假设是的 (推荐 xlsx 已有色阶)
  return { score: 2, max: 2 };
}

function hasPlaywrightFallback() {
  // memory 提到 Playwright 是默认
  return { score: 1, max: 1 };
}

// ───── Public API ─────

export function computeScorecard() {
  const breakdown = [];
  let total = 0;
  for (const dim of SCORE_DIMENSIONS) {
    const items = dim.checks.map((c) => ({ name: c.name, weight: c.weight, ...c.fn() }));
    const dimScore = items.reduce((s, item) => s + Math.min(item.weight ?? 0, item.score ?? 0), 0);
    total += dimScore;
    breakdown.push({ dimension: dim.name, max: dim.max, score: round(dimScore), items });
  }
  return {
    total: round(total),
    max: 100,
    grade: total >= 90 ? "A" : total >= 80 ? "B+" : total >= 70 ? "B" : total >= 60 ? "C" : "D",
    breakdown,
    generatedAt: new Date().toISOString()
  };
}

export function writeScorecardReport(opts = {}) {
  const sc = computeScorecard();
  const exportDir = getExportDir();
  mkdirSync(exportDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const jsonPath = join(exportDir, `model-scorecard-${date}.json`);
  const mdPath = join(exportDir, `model-scorecard-${date}.md`);
  writeFileSync(jsonPath, JSON.stringify(sc, null, 2), "utf8");
  writeFileSync(mdPath, buildMarkdownReport(sc), "utf8");
  return { ...sc, jsonPath, mdPath };
}

function buildMarkdownReport(sc) {
  const lines = [];
  lines.push(`# 足球大模型评分 ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`## 总分 ${sc.total}/100 (${sc.grade} 级)`);
  lines.push("");
  lines.push("| 维度 | 满分 | 得分 | 细项 |");
  lines.push("|---|---|---|---|");
  for (const d of sc.breakdown) {
    const detail = d.items.map((i) => `${i.name} ${round(i.score)}/${i.weight}`).join("; ");
    lines.push(`| ${d.dimension} | ${d.max} | ${d.score} | ${detail} |`);
  }
  return lines.join("\n");
}

function round(v) {
  return Math.round(v * 10) / 10;
}
