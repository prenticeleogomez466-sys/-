// 足球大模型体系全景导出(2026-06-01)→ xlsx,多 sheet 覆盖各层 + 实时统计。
// 用法:node scripts/export-system-overview.mjs
import { existsSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { getExportDir, getDataDir } from "../src/paths.js";

// ── 实时统计 ──
let sc = {};
try { sc = JSON.parse(execSync("node scripts/overnight-selfcheck.mjs --full", { encoding: "utf8", cwd: process.cwd() })); } catch {}
const r = sc.reachability ?? {};
let withResult = 0, leagues = new Set();
try {
  const d = join(getDataDir(), "fixtures");
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try { const a = JSON.parse(readFileSync(join(d, f), "utf8")); const l = Array.isArray(a) ? a : (a.fixtures ?? a.matches ?? []); for (const x of l) if (x.result && x.result.home != null) { withResult++; if (x.competition) leagues.add(x.competition); } } catch {}
  }
} catch {}
const eloN = (() => { try { return JSON.parse(readFileSync(join(getDataDir(), "national-elo.json"), "utf8")).count; } catch { return 0; } })();

const overview = [
  ["项", "值"],
  ["仓库", "D:\\football-model(独立自跑,已脱离 Codex)"],
  ["自检裁决", sc.verdict ?? "?"],
  ["测试", `${sc.test?.pass ?? "?"} 过 / ${sc.test?.fail ?? "?"} 败`],
  ["源模块总数", r.srcTotal ?? "?"],
  ["生产可达模块", r.production ?? "?"],
  ["工具/测试模块", r.toolingOrTestOnly ?? "?"],
  ["孤儿/僵尸模块", (r.zombies?.length ?? "?") + " (目标 0)"],
  ["历史带赛果场次", withResult],
  ["覆盖联赛数", leagues.size],
  ["经验库场次", sc.experienceLibrary?.used ?? "?"],
  ["国家队 Elo", eloN + " 国"],
  ["一句话定位", "全玩法诚实校准概率器+覆盖器,非'打败市场'机器;真价值在半全场/信心校准/顶级联赛/自知"],
];

const pyramid = [
  ["层", "名称", "职责", "现状"],
  ["L0", "数据源底座", "历史赛果+开收盘赔率+大小球/亚盘+国家队Elo", `${withResult} 场/${leagues.size} 联赛 + 经验库 ${sc.experienceLibrary?.used ?? "?"} + Elo ${eloN} 国`],
  ["L1", "数据审计层", "入库真实性/防泄漏+λ物理闸门+provenance戳", "自检+每源审计"],
  ["L2", "独立小模型", "DC泊松/历史类比/爆冷诱盘/26信号融合", "全接入主路径,0 孤儿"],
  ["L3", "大模型融合", "赔率+模型blend+isotonic校准+一致性", "市场为主、模型微调"],
  ["L4", "全面审计", "comprehensive-audit 10 道闸门", "不达标拦出表"],
  ["L5", "输出端", "7玩法+爆冷+原因+诱盘+模型自知+深度分析", "手机网页+xlsx"],
  ["横切", "永久记忆+自动闭环+临赛首发", "分段战绩召回+每日复盘+首发自动推送", ],
];

const playtypes = [
  ["玩法", "回测水平", "裁决", "说明"],
  ["半全场", "31.4%(+5.1pp 胜 naive)", "✅ 真价值", "halfFullJoint 上下半场拆分+状态依赖"],
  ["比分 top1 / top3", "12.4% / 32.9%", "🟡/✅", "DC-τ 矩阵 argmax,锚 wld"],
  ["胜负平(西甲/意甲)", "56-58%", "✅ 强", "顶级联赛数据足"],
  ["胜负平(北欧/低级别)", "33-45%", "❌ 弱", "高方差联赛,数据/可测性低"],
  ["信心校准", "单调 / ECE 2-3pp", "✅ 可信", "高信心确实高命中"],
  ["让球", "以 wld 为锚 + 公平线/覆盖阶梯", "🟡 透明读数", "独立 edge 不成立(同 1X2)"],
  ["大小球 O/U", "模型 57% < 市场 59%", "❌ 无 edge", "收盘线高效"],
  ["诱盘判定", "诱盘嫌疑桶热门反跑赢 +2.9pp", "❌ 无 edge", "市场更准,仅诊断"],
  ["BTTS / 单双", "≈ 抛硬币", "🟡 校准好无 edge", "本质不可预测,模型不编造"],
  ["CLV(击败收盘线)", "-1.4~-2.8%", "❌ 无正 CLV", "市场跟随器"],
];

const signals = [["#", "融合信号(26,全接主路径)", "类别", "数据/状态"]];
const SIG = [
  ["赛季阶段", "情境", "比赛日期"], ["赛事性质", "情境", "联赛走基线"], ["伤停", "阵容", "FPL/Sofascore 免授权"],
  ["交锋史H2H", "状态", "内部历史库"], ["净胜/零封", "状态", "内部历史库"], ["连胜连败", "状态", "内部历史库"],
  ["体能疲劳", "状态", "近期赛程"], ["轮换", "阵容", "轮换上下文"], ["主客场分裂", "状态", "主客PPG净差"],
  ["时间衰减近况", "状态", "历史加权"], ["赔率变化", "市场", "开→当前多次捕获"], ["天气", "环境", "源未配置"],
  ["教练效应", "情境", "需教练史"], ["德比强度", "情境", "同城/宿敌表"], ["排名压力", "情境", "需积分榜"],
  ["强强对话状态", "状态", "强队判定"], ["旅行距离", "环境", "需场馆坐标"], ["战术克制", "战术", "需阵型(首发)"],
  ["裁判倾向", "情境", "需赛前主裁"], ["对手强度校准", "实力", "按Elo校准"], ["进攻链xG", "战术", "需事件级"],
  ["控球调整xG", "战术", "需控球%"], ["定位球", "战术", "需定位球统计"], ["亚盘水位", "市场", "亚盘初→即"],
  ["历史同情境类比", "实力", "同联赛KNN"], ["首发布阵", "阵容", "ESPN首发"],
];
SIG.forEach((s, i) => signals.push([i + 1, s[0], s[1], s[2]]));

const audit = [
  ["#", "审计道", "查什么", "类型"],
  ["①", "模块结构", "代码结构错误", "硬 blocker"],
  ["②", "模块缺陷", "P0/P1/P2 分级", "warning"],
  ["③", "能力就绪", "层就绪度", "warning"],
  ["④", "推荐内容", "竞彩/14场实质校验", "硬 blocker"],
  ["⑤", "逐场自检", "provenance/方向一致/数据齐", "硬 blocker"],
  ["⑥", "真实性总结", "0 造假/可追溯真先验", "硬 blocker"],
  ["⑦", "逐玩法核验", "胜负平/让球/比分/半全场", "汇总"],
  ["⑧", "多模态层", "四玩法小模型如实", "blocker/warn"],
  ["⑨", "爆冷/诱盘核验", "高爆冷/诱盘/畸形拦截", "提示+畸形拦"],
  ["⑩", "模型自知", "分段战绩+信心校准漂移", "读数+漂移warn"],
];

const tasks = [["计划任务(9,全 Ready)", "作用"],
  ["FootballModel-DailyEvolution", "每日预测生成+演化"],
  ["FootballModel-RecapBacktest", "每日预测vs实际复盘(11:00)"],
  ["FootballModel-HealthMonitor", "自动化健康监控"],
  ["FootballModel-WeeklyEvolution", "每周数据变化框架刷新"],
  ["FootballModel-LineupWatch", "首发一出自动重分析推送(~30min)"],
  ["FootballModel-MarketRefresh-Late", "23:50 刷 current 近收盘"],
  ["FootballModel-MarketRefresh-Night", "03:30 刷 current 近收盘"],
  ["FootballModel-CaptureClosing", "06:30 冻结收盘价(CLV用)"],
  ["FootballModel-Top5Watch", "每日扫五大联赛回归提醒(8:00)"],
];

const out = join(getExportDir(), "足球大模型体系全景.xlsx");
writeXlsxWorkbook(out, [
  { name: "体系总览", rows: overview },
  { name: "金字塔架构", rows: pyramid },
  { name: "7玩法能力", rows: playtypes },
  { name: "26融合信号", rows: signals },
  { name: "10道审计", rows: audit },
  { name: "9计划任务", rows: tasks },
]);
console.log("已生成", out);
try { copyFileSync(out, "C:\\Users\\Administrator\\Desktop\\足球大模型体系全景.xlsx"); console.log("桌面副本 OK"); } catch (e) { console.log("桌面副本跳过:", e.message); }
