// 僵尸/死码扫描(2026-06-16:用户铁律"全方位提升但不能有僵尸垃圾无用内容")。
//   informational(非硬闸:scripts 常被 cron .ps1/.cmd 间接调用,误报多→不进 audit:suite 拒交付);
//   日常 `npm run audit:deadcode` 看 src 是否冒出仅 test 引用的孤儿模块(=要么接进交付,要么删)。
//   A 真死(无任何引用)/ B test-only 僵尸(只 test 引用·重点)/ C 死脚本候选(不在 package.json 且无引用·须人核 cron)。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
function blobOf(dirs) {
  const t = [];
  for (const d of dirs) {
    for (const f of readdirSync(join(root, d))) {
      if (/\.(mjs|js|cjs|json|ps1|cmd|bat)$/.test(f)) {
        try { t.push("\n/*F:" + d + "/" + f + "*/\n" + readFileSync(join(root, d, f), "utf8")); } catch {}
      }
    }
  }
  return t.join("\n");
}
// 2026-06-20 加固:hasFile("x.js")/existsSync(...,"x.js") 是「文件存不存在」检查(如 model-scorecard 评分卡),
//   不是真消费,却会被 reOf 当成生产引用 → 掩盖真僵尸(combo-builder 当年就这么漏掉)。计引用前先中和这类存在性检查。
const neutralizeExistenceChecks = (s) => s.replace(/hasFile\(\s*["'`][^"'`]+["'`]\s*\)/g, "hasFile(EXISTENCE_CHECK)");
const prodBlob = neutralizeExistenceChecks(blobOf([".", "src", "scripts"]));   // production + entrypoints
const testBlob = blobOf(["test"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reOf = (base) => new RegExp("[\\/\"'\\.]" + esc(base) + "(\\.js|\\.mjs)?[\"'`]", "g");

// src modules referenced ONLY by tests (test-only zombies) or nowhere
const srcFiles = readdirSync(join(root, "src")).filter((f) => /\.js$/.test(f));
const testOnly = [], prodDead = [];
for (const f of srcFiles) {
  const base = f.replace(/\.js$/, "");
  // exclude its own file marker self-reference by removing /*F:src/<f>*/ — but path refs are imports, fine
  const prodHits = (prodBlob.replace("/*F:src/" + f + "*/", "").match(reOf(base)) || []).length;
  const testHits = (testBlob.match(reOf(base)) || []).length;
  if (prodHits === 0 && testHits === 0) prodDead.push("src/" + f);
  else if (prodHits === 0 && testHits > 0) testOnly.push("src/" + f);
}
// scripts/*.mjs not referenced by package.json or any ps1/cmd/other script (and not referenced anywhere)
const pkg = readFileSync(join(root, "package.json"), "utf8");
const scriptFiles = readdirSync(join(root, "scripts")).filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith("_"));
const scriptDead = [];
for (const f of scriptFiles) {
  const inPkg = pkg.includes(f);
  const refd = (prodBlob.replace("/*F:scripts/" + f + "*/", "").match(reOf(f.replace(/\.(mjs|js)$/, ""))) || []).length;
  if (!inPkg && refd === 0) scriptDead.push("scripts/" + f);
}
console.log("=== A) src/*.js 完全无引用(真死) ===\n" + (prodDead.length ? prodDead.map((x) => "  " + x).join("\n") : "  (none)"));
console.log("\n=== B) src/*.js 仅被 test 引用(test-only 僵尸) ===\n" + (testOnly.length ? testOnly.map((x) => "  " + x).join("\n") : "  (none)"));
console.log("\n=== C) scripts/*.mjs 不在 package.json 且无引用(可能死脚本) ===\n" + (scriptDead.length ? scriptDead.map((x) => "  " + x).join("\n") : "  (none)"));
console.log(`\nsrc=${srcFiles.length} scripts=${scriptFiles.length} | 真死=${prodDead.length} test-only=${testOnly.length} 死脚本候选=${scriptDead.length}`);
