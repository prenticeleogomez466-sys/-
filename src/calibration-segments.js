/**
 * 校准分段映射(② 分段校准 —— 2026-05-31)
 * ⚠️ 回测负结果·研究存档,未接入生产:leak-safe 回测(run-segmented-calibration-backtest.mjs)显示
 *   分段 isotonic 比全局 isotonic **校准更差**(全体 ECE 0.0063→0.0112,top5/otherTop 退化,
 *   仅 second 微弱改善)——段图样本少过拟合,全局图汇集全样本反而更优。遵"变好才留"已回滚,
 *   本模块仅供回测脚本复现该结论用,prediction-engine/model-calibration 不引用。
 * ──────────────────────────────────────────────────────────────
 * 问题:全局 isotonic 校准用五大联赛训练,套到所有联赛/赛事 → 系统性偏差
 *   (低级别/非五大联赛市场效率低、平局多、热门更易过度自信;国际赛更甚)。
 *
 * 方案:把校准按**层级段**切分,trainer 对每段单独训 isotonic,apply 端按 fixture
 *   所属段选对应映射。关键:训练集见不到的联赛(日职/瑞超/芬超/MLS…)按其**层级特征**
 *   归到最像的段(otherTop=非五大顶级联赛),用荷甲/葡超/土超/比甲/希腊等训练出的
 *   校准去服务它们,远比硬套五大联赛全局图合理。
 *
 * 段定义(trainer 从 football-data 联赛代码/标签判段;apply 从 fixture.competition 判段,同口径):
 *   top5     五大联赛(市场最 sharp,校准近恒等)
 *   second   各国次级联赛(英冠/德乙/西乙…,效率较低)
 *   otherTop 非五大的顶级联赛(荷甲/葡超/土超/比甲/希腊…,以及运行时的日职/瑞超/芬超/巴甲/沙特/MLS)
 *   intl     国家队/友谊/国际赛(训练集通常无样本 → apply 端回退全局 + 由 soft-recal 处理平局)
 */

const TOP5_CODES = new Set(["E0", "SP1", "D1", "I1", "F1"]);
const SECOND_CODES = new Set(["E1", "E2", "EC", "SC0", "D2", "I2", "SP2", "F2"]);
const OTHERTOP_CODES = new Set(["N1", "B1", "P1", "T1", "G1"]);

export const CALIBRATION_SEGMENTS = ["top5", "second", "otherTop", "intl"];

/**
 * 联赛代码 / 中文联赛名 / 赛事名 → 校准段。
 * @param {string} leagueOrCompetition football-data 代码(E0…)或 fixture.competition(中文/英文名)
 * @returns {"top5"|"second"|"otherTop"|"intl"}
 */
export function calibrationSegment(leagueOrCompetition) {
  const s = String(leagueOrCompetition ?? "").trim();
  if (!s) return "otherTop";

  // 1) football-data 联赛代码精确判段(trainer 路径)
  if (TOP5_CODES.has(s)) return "top5";
  if (SECOND_CODES.has(s)) return "second";
  if (OTHERTOP_CODES.has(s)) return "otherTop";

  // 2) 国际/友谊/国家队(放最前于名称匹配,避免"国际"被别的规则吞)
  if (/(国际|友谊|热身|国家队|国家|Nations|Friendly|International|世预|世界杯|洲际)/i.test(s)) return "intl";

  // 3) 五大联赛名称
  if (/(英超|西甲|德甲|意甲|法甲|Premier\s*League|La\s*Liga|Bundesliga|Serie\s*A|Ligue\s*1)/i.test(s)) return "top5";

  // 4) 次级联赛名称
  if (/(英冠|英甲|英乙|苏超|西乙|德乙|意乙|法乙|Championship|League\s*One|League\s*Two|2\.?\s*Bundesliga|Segunda|Serie\s*B|Ligue\s*2)/i.test(s)) return "second";

  // 5) 其它一律归"非五大顶级联赛"(日职/瑞超/芬超/挪超/荷甲/葡超/土超/巴甲/中超/沙特/MLS/J联赛…)
  return "otherTop";
}
