/**
 * 清理 openfootball 五大联赛重复:football-data 已带赔率+简洁队名覆盖五大,
 * openfootball 的 en.1/es.1/de.1/it.1/fr.1 是同批比赛的另一套标签+带"FC"后缀队名,
 * 会让模型重复学五大、把球队拆成两个实体。定向删除这 5 个 competition,保留其余一切。
 */
import { listFixtureDates, loadFixtures, saveFixtures } from "../src/fixture-store.js";

const DUP = new Set(["en.1", "es.1", "de.1", "it.1", "fr.1"]);
let datesTouched = 0, removed = 0, emptied = 0;

for (const date of listFixtureDates()) {
  const { fixtures, source } = loadFixtures(date);
  if (!fixtures?.length) continue;
  const kept = fixtures.filter((f) => !DUP.has(f.competition ?? f.league));
  if (kept.length === fixtures.length) continue;  // 该日无 dup
  removed += fixtures.length - kept.length;
  datesTouched++;
  if (kept.length === 0) emptied++;
  saveFixtures(date, kept, { source: source ?? "historical-backfill", allowEmpty: true });
}

console.log(`清理完成:涉及 ${datesTouched} 天,删除 openfootball 重复 ${removed} 场,清空 ${emptied} 天`);
