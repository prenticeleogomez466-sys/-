// 今天完整两表 xlsx:竞彩(四列+近5场/H2H/画像/信心) + 14场胜负彩(正在售的期,即使赛日在未来)。
// 用户硬规则:有 14 场就出两张表;固定完整维度;真实可追溯。
import {
  buildDailyRecommendationPackage,
  simpleWldCell, simpleHandicapCell, simpleScoreCell, simpleHalfFullCell,
  simpleFourteenHeaders, toSimpleFourteenRow,
} from "../src/daily-report.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { copyFileSync, existsSync } from "node:fs";

const date = process.argv[2] ?? "2026-06-08";
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });
const preds = pkg.recommendations?.predictions ?? [];
const jc = preds.filter((p) => p.fixture?.marketType === "jingcai")
  .sort((a, b) => String(a.fixture.kickoff).localeCompare(String(b.fixture.kickoff)));
const fourteen = pkg.recommendations?.fourteen?.selections ?? [];
const f14note = pkg.recommendations?.fourteen?.note ?? "";

const dcForm = (p) => {
  const dc = p.deepContext;
  if (!dc) return "未取到";
  const h = dc.home?.form, a = dc.away?.form;
  if (!h && !a) return "未取到";
  return `${h ?? "—"} / ${a ?? "—"}`;
};
const dcH2H = (p) => p.deepContext?.h2h ?? "无记录";
const dcProfile = (p) => {
  const tp = p.teamProfile;
  if (!tp || (!tp.home && !tp.away)) return "未取到(国际赛无俱乐部画像)";
  const parts = [];
  if (tp.home?.ppg > 0) parts.push(`主综合${tp.home.ppg}`);
  if (tp.away?.ppg > 0) parts.push(`客综合${tp.away.ppg}`);
  return parts.length ? parts.join(" / ") : "未取到";
};
const kickoff = (p) => {
  const ko = p.fixture?.kickoff;
  return ko && /\d{2}:\d{2}/.test(ko) ? ko.slice(5, 16) : (ko?.slice(5, 10) ?? "");
};

const jcHeaders = ["开赛", "对阵", "胜负平", "让胜负平", "比分", "半全场", "近5场", "H2H交锋", "实力·主客场画像", "信心"];
const jcRows = jc.map((p) => [
  kickoff(p), `${p.fixture.homeTeam} vs ${p.fixture.awayTeam}`,
  simpleWldCell(p), simpleHandicapCell(p), simpleScoreCell(p), simpleHalfFullCell(p),
  dcForm(p), dcH2H(p), dcProfile(p), String(p.confidence ?? ""),
]);

const sheets = [
  { name: "竞彩", rows: [[`⚡ 神选 · 竞彩 · ${date}`], jcHeaders, ...jcRows] },
];
if (fourteen.length) {
  sheets.push({
    name: "14场",
    rows: [
      [`⚡ 神选 · 14场胜负彩 · ${date}`],
      [f14note || "第26085期 世界杯小组赛"],
      simpleFourteenHeaders(),
      ...fourteen.map(toSimpleFourteenRow),
    ],
  });
}

const target = `C:/Users/Administrator/Desktop/神选-竞彩推荐-${date}.xlsx`;
writeXlsxWorkbook(target, sheets);
console.log("✅ 两表 xlsx 已存:", target);
console.log("   竞彩", jcRows.length, "场 · 14场", fourteen.length, "腿");
