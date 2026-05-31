/**
 * 经验库覆盖体检(2026-05-31 学习轮 23)
 * 列各联赛样本量(<40 退全局)+ 某日竞彩各场命中联赛级 or 退全局。
 * 用法:node scripts/audit-experience-coverage.mjs [YYYY-MM-DD]
 */
import { loadExperienceLibrary, resetExperienceLibraryCache } from "../src/experience-library-store.js";
import { recommendFixtures } from "../src/prediction-engine.js";

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
resetExperienceLibraryCache();
const lib = loadExperienceLibrary();
if (!lib) { console.log("无经验库"); process.exit(1); }
const lgs = Object.entries(lib.leagues).map(([k, v]) => [k, v.n]).sort((a, b) => b[1] - a[1]);
const weak = lgs.filter(([, n]) => n < 40).length;
console.log(`经验库:${lgs.length} 联赛 / 全局 ${lib.global.n} 场;样本<40(退全局)的联赛 ${weak} 个`);

const rec = recommendFixtures(date);
const preds = rec.predictions || [];
let leagueHit = 0;
for (const p of preds) {
  const src = p.experienceContext?.source || "无";
  if (/联赛/.test(src)) leagueHit++;
}
console.log(`${date} 竞彩 ${preds.length} 场:命中联赛级经验 ${leagueHit} / 退全局或国际赛 ${preds.length - leagueHit}`);
console.log(weak === 0 ? "✅ 全部联赛样本充足(联赛级可靠);今日命中按上方,国际赛退全局属正常。" : "⚠️ 有联赛样本不足,需回填。");
