/**
 * 全量历史回填:所有联赛、所有球队、多赛季,全部免费源。
 * 目标(用户 2026-05-31):扩大场次、所有联赛都涉及、所有队伍特征都吸取。
 *   - openfootball  五大联赛 4 赛季
 *   - football-data 18 欧洲联赛(五大+英冠英甲英乙苏超德乙意乙西乙法乙荷甲比甲葡超土超希超)5 赛季,带赔率
 *   - ESPN          8 洲际联赛(美职/巴甲/日职/沙特/中超/阿甲/墨超/韩K)
 *   - statsbomb     世界杯/欧冠
 * 全部去重后写入 fixture-store → collectHistoricalMatches 自动吸收 → DC 全局拟合学到所有队。
 */
import { backfillHistorical } from "../src/historical-backfill.js";
import { ALL_LEAGUES } from "../src/footballdata-loader.js";

// 清空可能干扰 football-data 的代理(遵 reference_lottery_fetch_proxy)
for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) delete process.env[k];

const t0 = Date.now();
const summary = await backfillHistorical({
  leagues: ["en.1", "es.1", "de.1", "it.1", "fr.1"],
  seasons: ["2024-25", "2023-24", "2022-23", "2021-22"],
  includeOpenfootball: true,
  includeStatsbomb: true,
  includeFootballData: true,
  footballDataLeagues: ALL_LEAGUES,           // 18 欧洲联赛(含五大+扩展)
  footballDataSeasons: ["2526", "2425", "2324", "2223", "2122"],
  includeEspn: true,                          // 8 洲际联赛
});
console.log("回填汇总:", JSON.stringify(summary, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
