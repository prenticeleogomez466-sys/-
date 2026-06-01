// 五大联赛重启自动提醒(2026-06-01)——休赛期模型最弱,五大联赛才是主场。
// 每天扫今日竞彩,出现 ≥minMatches 场五大联赛(英超/西甲/意甲/德甲/法甲)即写提醒标志 +
//   控制台高亮(计划任务捕获 → 可接微信推送)。提醒后写 state 防重复刷屏。
// 用法:node scripts/top5-league-watch.mjs [--date=YYYY-MM-DD] [--min=3]
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadFixtures } from "../src/fixture-store.js";
import { getDataSubdir, getExportDir } from "../src/paths.js";

const args = process.argv.slice(2);
const getArg = (f, d) => { const e = args.find((a) => a.startsWith(`${f}=`)); return e ? e.slice(f.length + 1) : d; };
const date = getArg("--date", new Date().toISOString().slice(0, 10));
const minMatches = Number(getArg("--min", "3"));

const TOP5 = ["英超", "西甲", "意甲", "德甲", "法甲", "英格兰超级联赛", "西班牙甲级联赛", "意大利甲级联赛", "德国甲级联赛", "法国甲级联赛"];

let set;
try { set = loadFixtures(date); } catch { console.log(`[${date}] 无赛程`); process.exit(0); }
const fixtures = (set.fixtures ?? []).filter((f) => f.marketType === "jingcai" || (f.tags ?? []).some((t) => /竞彩/.test(t)));
const top5 = fixtures.filter((f) => TOP5.some((l) => (f.competition ?? "").includes(l)));

const dir = getDataSubdir("alerts");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "top5-watch-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

if (top5.length >= minMatches) {
  if (state[date]) { console.log(`[${date}] 五大联赛 ${top5.length} 场,已提醒过,跳过`); process.exit(0); }
  state[date] = top5.length;
  writeFileSync(statePath, JSON.stringify(state, null, 0), "utf8");
  const leagues = [...new Set(top5.map((f) => f.competition))];
  const msg = `🔔 五大联赛回来了!今日(${date})竞彩有 ${top5.length} 场五大联赛(${leagues.join("/")})——这是足球大模型的主场(西甲/意甲历史命中 56-58%),值得认真看。跑 node scripts/jingcai-daily.mjs 出正式推荐。`;
  console.log(msg);
  // 写桌面提醒文件(用户/计划任务可见)
  try { writeFileSync(join(getExportDir(), "五大联赛回归提醒.txt"), msg + "\n", "utf8"); } catch {}
  process.exit(3); // exit 3 = 命中提醒(计划任务可据此触发微信推送)
} else {
  console.log(`[${date}] 竞彩 ${fixtures.length} 场,其中五大联赛仅 ${top5.length} 场(<${minMatches})→ 仍休赛期/淡季,不提醒`);
  process.exit(0);
}
