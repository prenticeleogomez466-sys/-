/**
 * 过夜全面自检(2026-05-30,用户过夜自动化要求②:每20分钟检查模型各角落、保证跑通、
 * 无僵尸/无效模块)。一次性确定性跑完,把结论追加进 overnight 进度日志。
 *
 * 检查项:
 *  1. 语法:node --check 全部 src/*.js + scripts/*.mjs
 *  2. 可达性:从 scripts/ + test/ BFS import 图,标出 production 可达 / 仅工具/测试 / 真僵尸(无人引用)
 *  3. 经验库:文件存在 + 联赛数 + 新鲜度
 *  4. 今日推荐包:实跑 buildDailyRecommendationPackage,断言 audit.errors==0
 *  5. (可选 --full)npm test 全量
 * 用法:node scripts/overnight-selfcheck.mjs [--full]
 */
import { readFileSync, readdirSync, existsSync, appendFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SRC = join(ROOT, "src");
const SCRIPTS = join(ROOT, "scripts");
const TEST = join(ROOT, "test");
const full = process.argv.includes("--full");

const report = [];
const log = (s) => { report.push(s); };

// ---- 1. 语法检查 ----
function checkSyntax() {
  const files = [
    ...readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => join(SRC, f)),
    ...readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")).map((f) => join(SCRIPTS, f)),
  ];
  const bad = [];
  for (const f of files) {
    try { execSync(`node --check "${f}"`, { stdio: "pipe" }); }
    catch (e) { bad.push(`${basename(f)}: ${String(e.stderr || e.message).split("\n")[0]}`); }
  }
  return { total: files.length, bad };
}

// ---- 2. 可达性(import BFS) ----
function importsOf(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  const re = /(?:import\s[^'"]*?from\s*|import\s*)["'](\.\.?\/[^"']+)["']|require\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    let rel = m[1] || m[2];
    if (!rel) continue;
    let resolved = resolveRel(file, rel);
    if (resolved) out.push(resolved);
  }
  return out;
}
function resolveRel(fromFile, rel) {
  const base = join(dirname(fromFile), rel);
  const cands = [base, base + ".js", base + ".mjs", base + ".cjs", join(base, "index.js")];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
function packageScriptRoots() {
  // package.json scripts 里 `node <path>` 引用的 src/scripts 文件本身就是入口,必须当根,
  // 否则会把 npm-script 入口模块(model:audit/advanced:sync/server 等)误判成僵尸。
  const roots = [];
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    for (const cmd of Object.values(pkg.scripts || {})) {
      for (const m of String(cmd).matchAll(/node\s+(?:--[\w=]+\s+)*((?:src|scripts)\/[\w./-]+)/g)) {
        const p = join(ROOT, m[1]);
        if (existsSync(p)) roots.push(p);
      }
    }
  } catch {}
  return roots;
}
function automationRoots() {
  // PS 自动化脚本里 `npm run X` / `node src\xxx` 间接拉起的入口(health/evolution/recap 等)
  const roots = [];
  const ps = join(ROOT, "scripts", "run-football-automation.ps1");
  try {
    const text = readFileSync(ps, "utf8");
    for (const m of text.matchAll(/node\s+["']?((?:src|scripts)[\\/][\w./\\-]+)/g)) {
      const p = join(ROOT, m[1].replace(/\\/g, "/"));
      if (existsSync(p)) roots.push(p);
    }
  } catch {}
  return roots;
}
function reachability() {
  const srcFiles = new Set(readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => join(SRC, f)));
  const serverFile = join(SRC, "server.js");
  const roots = [
    ...readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")).map((f) => join(SCRIPTS, f)),
    ...(existsSync(TEST) ? readdirSync(TEST).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")).map((f) => join(TEST, f)) : []),
    ...packageScriptRoots(),
    ...automationRoots(),
    ...(existsSync(serverFile) ? [serverFile] : []), // 独立服务入口
  ];
  // production 根 = 日常推荐/复盘真实链路
  const prodRoots = ["jingcai-daily.mjs", "daily-with-fallback.mjs", "render-recommendation-html.mjs", "run-daily-recap.mjs", "daily-report.mjs"]
    .map((f) => join(SCRIPTS, f)).filter(existsSync);
  const bfs = (starts) => {
    const seen = new Set(starts);
    const stack = [...starts];
    while (stack.length) {
      const f = stack.pop();
      for (const dep of importsOf(f)) if (!seen.has(dep)) { seen.add(dep); stack.push(dep); }
    }
    return seen;
  };
  const allReached = bfs(roots);
  const prodReached = bfs(prodRoots);
  const zombies = [...srcFiles].filter((f) => !allReached.has(f)).map((f) => basename(f));
  const toolingOnly = [...srcFiles].filter((f) => allReached.has(f) && !prodReached.has(f)).map((f) => basename(f));
  const prod = [...srcFiles].filter((f) => prodReached.has(f)).length;
  return { srcTotal: srcFiles.size, production: prod, toolingOrTestOnly: toolingOnly.length, zombies };
}

// ---- 3. 经验库 ----
function experienceLib() {
  const path = join(process.env.FOOTBALL_DATA_DIR || "D:\\football-model-data", "experience-library.json");
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  try {
    const lib = JSON.parse(readFileSync(path, "utf8"));
    const ageH = (Date.now() - statSync(path).mtimeMs) / 3.6e6;
    return { ok: true, leagues: lib.meta?.leagues, used: lib.meta?.usedMatches, ageHours: Number(ageH.toFixed(1)) };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ---- 4. 今日包 ----
async function todayPackage() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  try {
    await import("../src/env.js");
    const { buildDailyRecommendationPackage } = await import("../src/daily-report.js");
    const pkg = buildDailyRecommendationPackage(today, { skipRealtimeGate: true });
    return { date: today, ok: pkg.audit.summary.errors === 0, errors: pkg.audit.summary.errors, jingcai: pkg.recommendations.predictions.filter((p) => p.fixture.marketType === "jingcai").length };
  } catch (e) { return { date: today, ok: false, error: e.message.split("\n")[0] }; }
}

// ---- 5. npm test (--full) ----
function npmTest() {
  try {
    const out = execSync("npm test", { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    const pass = (out.match(/# pass (\d+)/) || out.match(/pass (\d+)/) || [])[1];
    const fail = (out.match(/# fail (\d+)/) || out.match(/fail (\d+)/) || [])[1];
    return { pass: Number(pass), fail: Number(fail) };
  } catch (e) {
    const out = String(e.stdout || "");
    const fail = (out.match(/fail (\d+)/) || [])[1];
    return { pass: Number((out.match(/pass (\d+)/) || [])[1]), fail: Number(fail) || "?", crashed: true };
  }
}

// ---- 跑 ----
const syntax = checkSyntax();
const reach = reachability();
const lib = experienceLib();
const today = await todayPackage();
const test = full ? npmTest() : { skipped: true };

const stamp = new Date().toISOString();
const status = {
  stamp,
  syntax: { total: syntax.total, bad: syntax.bad.length },
  reachability: reach,
  experienceLibrary: lib,
  todayPackage: today,
  test,
  verdict: syntax.bad.length === 0 && reach.zombies.length === 0 && today.ok && (full ? test.fail === 0 : true) ? "GREEN" : "ATTENTION",
};

console.log(JSON.stringify(status, null, 2));
if (syntax.bad.length) console.log("语法失败:", syntax.bad.join(" | "));
if (reach.zombies.length) console.log("僵尸模块:", reach.zombies.join(", "));

// 追加进度日志
const logPath = join(process.env.FOOTBALL_EXPORT_DIR || "D:\\football-model-exports", "overnight-progress.md");
const line = `\n### ${stamp} 自检 [${status.verdict}]\n- 语法 ${syntax.total - syntax.bad.length}/${syntax.total} OK${syntax.bad.length ? " ⚠️ " + syntax.bad.length + " 失败" : ""}\n- 可达性: production ${reach.production} / 工具或测试 ${reach.toolingOrTestOnly} / 僵尸 ${reach.zombies.length}${reach.zombies.length ? " ⚠️ " + reach.zombies.join(",") : ""} (共 ${reach.srcTotal})\n- 经验库: ${lib.ok ? lib.leagues + " 联赛 / " + lib.used + " 场 / " + lib.ageHours + "h前" : "❌ " + lib.reason}\n- 今日包(${today.date}): ${today.ok ? "✅ " + today.jingcai + " 竞彩 0 错误" : "⚠️ " + (today.error || today.errors + " 错误")}\n- 测试: ${full ? (test.fail === 0 ? "✅ " + test.pass + " 全过" : "⚠️ " + test.fail + " 失败") : "跳过(非 --full)"}`;
try { appendFileSync(logPath, line, "utf8"); } catch {}
process.exit(status.verdict === "GREEN" ? 0 : 1);
