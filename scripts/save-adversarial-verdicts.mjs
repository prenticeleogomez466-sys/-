// 把 football-signal-verify workflow 的产出转成「交付消费端格式」并落盘。
// ──────────────────────────────────────────────────────────────────────────
// 根因(2026-06-17 踩坑→2026-06-18 永久化):该 workflow 在沙箱里跑,无文件系统,
//   只能 return { ok, summary, rows },且字段是 adversarialLabel / lensVerdicts;
//   而交付消费端(today-full-coverage.mjs:79)读 D:/football-model-data/adversarial/<date>.json
//   的 .verdicts,按 `${homeTeam}|${awayTeam}` 键,每注要 { label, kill, ev, ... }。
//   以前每次手工转→易错漏=返厂。本脚本把转换固化为确定性步骤(带守护测试)。
//
// 用法:node scripts/save-adversarial-verdicts.mjs <workflow产出json路径> [--date YYYY-MM-DD]
//   workflow产出json = { ok, summary:{date,totalForDate,clean,oneVote,twoVote,threeVote},
//                         rows:[{ match:"主 vs 客", competition, direction, prob, confidence,
//                                 risk, modelTier, ev, refuteVotes, maxSeverity, lensVerdicts:[..] }] }
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 票数 → 交付标签(与 2026-06-17 canonical 一致:0/1票不含"证伪"二字,2/3票才含 →
//   消费端 advKilled 用 /证伪/ 只圈出 2+ 票被证伪的注,clean/单视角不误杀)。
export function voteLabel(votes) {
  if (votes <= 0) return "🟢 三视角通过(相对稳健)";
  if (votes === 1) return "🟡 单视角存疑(谨慎/降注)";
  if (votes === 2) return "🟠 双视角证伪(建议双选/降档)";
  return "🔴 三视角全证伪(建议观望)";
}

// "主队 vs 客队" → "主队|客队"(消费端键)。只切第一个分隔符,队名含空格也安全。
// ⚠️2026-06-18 加固:workflow 产出的 match 分隔符不稳定(实测有 " vs " 与 " 对 " 两种,
//   agent 自由发挥),只认 " vs " 会漏切→键名带" 对 "→消费端 advFor 查不到→证伪列全标⚠️未跑。
//   兼容多分隔符(已含"|"=幂等:已是键则原样返回)。
const MATCH_SEPS = [" vs ", " VS ", " 对 ", " v ", "|"];
export function matchToKey(match) {
  const s = String(match || "");
  for (const sep of MATCH_SEPS) {
    const i = s.indexOf(sep);
    if (i >= 0) return `${s.slice(0, i)}|${s.slice(i + sep.length)}`;
  }
  return s;
}

// workflow 产出 → 消费端 { date, generatedBy, summary, totalVerdicts, verdicts }
export function toDeliveryFormat(wf, { generatedBy } = {}) {
  if (!wf || !Array.isArray(wf.rows)) throw new Error("workflow 产出缺 rows 数组");
  const verdicts = {};
  for (const r of wf.rows) {
    const key = matchToKey(r.match);
    verdicts[key] = {
      label: voteLabel(r.refuteVotes),
      kill: Array.isArray(r.lensVerdicts) ? r.lensVerdicts.join("\n") : String(r.kill ?? ""),
      direction: r.direction ?? null,
      prob: r.prob ?? null,
      confidence: r.confidence ?? null,
      risk: r.risk ?? null,
      modelTier: r.modelTier ?? null,
      ev: Number.isFinite(r.ev) ? r.ev : null,
      refuteVotes: r.refuteVotes ?? 0,
      maxSeverity: r.maxSeverity ?? 0,
      competition: r.competition ?? null,
    };
  }
  return {
    date: wf.summary?.date ?? null,
    generatedBy: generatedBy ?? "skill:football-signal-verify",
    summary: wf.summary ?? null,
    totalVerdicts: Object.keys(verdicts).length,
    verdicts,
  };
}

// CLI(被测试/import导入时不执行)。
// ⚠️2026-06-18 修:旧守卫 `file://${argv[1]}` 在 Windows 上=两斜杠,而 import.meta.url=三斜杠
//   (file:///D:/...)→ 永不相等=CLI 死;且 -e/import 时 argv[1] 可能 undefined→.replace 崩。
//   pathToFileURL 是跨平台正解(自动产 file:///,并对盘符/空格正确编码)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inPath = process.argv[2];
  if (!inPath) { console.error("用法: node scripts/save-adversarial-verdicts.mjs <workflow产出json> [--date YYYY-MM-DD]"); process.exit(1); }
  const dateArg = (() => { const i = process.argv.indexOf("--date"); return i > 0 ? process.argv[i + 1] : null; })();
  const wf = JSON.parse(readFileSync(inPath, "utf8"));
  const out = toDeliveryFormat(wf, { generatedBy: `skill:football-signal-verify (${dateArg || wf.summary?.date || ""})` });
  const date = dateArg || out.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`❌ 无合法日期(--date 或 workflow summary.date):${date}`); process.exit(1); }
  out.date = date;
  if (out.summary) out.summary.date = date;
  const dir = join(process.env.FOOTBALL_DATA_DIR || "D:/football-model-data", "adversarial");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, `${date}.json`);
  writeFileSync(p, JSON.stringify(out, null, 1), "utf8");
  const s = out.summary || {};
  console.log(`✅ 已写 ${p}`);
  console.log(`   ${out.totalVerdicts} 注 | 稳健 ${s.clean ?? "?"} / 单视角 ${s.oneVote ?? "?"} / 双视角 ${s.twoVote ?? "?"} / 三视角 ${s.threeVote ?? "?"}`);
}
