#!/usr/bin/env node
// freeze-delivery-contract —— 交付契约冻结器(2026-06-13 用户最高指令:版式漂移/另起野页 彻底焊死)
// 背景: 0607/0613 用户两次发火"每次进化就把表格内容弄乱/另起手机页"。根因=出表那刻没有机器闸,
//   全靠"我记得"。本契约+audit:suite 的 probe-delivery-contract 探针把它变成硬闸:列序/列数变样
//   或 webshare 冒出白名单外的野页 → 闸红拒交付。
// 关键设计: 列头从"活的 XLSX_HEADERS"现场读取生成,杜绝手抄串字;要"合法改列/改白名单"必须显式
//   重跑本脚本(--write),动作留痕进 git,即铁律"增减都要过你"。
// 用法:
//   node scripts/freeze-delivery-contract.mjs            # 校验:活值 vs 已冻结契约,不一致 exit 1
//   node scripts/freeze-delivery-contract.mjs --write    # 显式重新冻结(合法改列/白名单后才跑)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XLSX_HEADERS } from "../src/today-delivery-lib.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONTRACT_PATH = path.join(ROOT, "scripts", "delivery-contract.json");

// webshare 是全项目共享目录(足球/彩票/小说/导航 170+页),不能用整目录白名单(会误伤)。
// 改用"交付签名"判野页:只盯带当日交付 banner 的页 —— 这种页必须唯一落在 canonical 固定名或合法日期副本上,
// 出现第三个带同款 banner 的文件 = 平行/重复交付副本(正是 0613 我另起 worldcup-today.html 的失败模式)。
// canonical 固定URL页(交付签名页): 今日足球推荐.html(中文手机页) / football.html(英文页)。
const DELIVERY_CANONICAL = ["今日足球推荐.html", "football.html"];
// resolveHtmlWriteTarget 在固定页已被更新日期占用时合法写出的日期副本:足球推荐-<date>.html / football-<date>.html
const WEBSHARE_DATED_PATTERNS = ["^足球推荐-\\d{4}-\\d{2}-\\d{2}\\.html$", "^football-\\d{4}-\\d{2}-\\d{2}\\.html$"];
// 当日交付 banner 签名(renderMobileHtml/renderEnglishHtml 标题;model-map=神选·足球(无日期)、index 仅含链接文字,均不匹配 → 零误伤)
const DELIVERY_BANNER_PATTERNS = ["神选·竞彩·\\d{4}-\\d{2}-\\d{2}", "神选·足球·\\d{4}-\\d{2}-\\d{2}"];

export function buildContract() {
  return {
    _note: "交付契约冻结档。改列序/canonical名/签名是显式动作:改 src/today-delivery-lib.js 或本脚本后,跑 node scripts/freeze-delivery-contract.mjs --write 重冻并提交(增减都要过用户)。audit:suite 的 delivery-contract 探针守它。野页判法=内容签名(只盯带交付banner的页须唯一),不扫整共享目录。",
    frozenAt: process.env.CONTRACT_FREEZE_DATE || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
    xlsxHeaders: XLSX_HEADERS,
    xlsxHeaderCount: XLSX_HEADERS.length,
    deliveryCanonical: DELIVERY_CANONICAL,
    webshareDatedPatterns: WEBSHARE_DATED_PATTERNS,
    deliveryBannerPatterns: DELIVERY_BANNER_PATTERNS,
  };
}

// 纯函数: contract + 活列头 + "带交付banner的html文件名清单"(调用方按签名预筛) → 不符项数组(空=过)。供探针/测试复用,不碰盘。
export function checkContract(contract, liveHeaders, deliveryBearingHtml) {
  const violations = [];
  if (!contract) { violations.push("契约文件缺失(跑 freeze-delivery-contract.mjs --write 先冻结)"); return violations; }
  // ① 列序/列数逐字冻结
  if (liveHeaders.length !== contract.xlsxHeaders.length) {
    violations.push(`列数变样: 活值${liveHeaders.length}列 ≠ 契约${contract.xlsxHeaders.length}列(改列须 --write 重冻)`);
  } else {
    for (let i = 0; i < liveHeaders.length; i++) {
      if (liveHeaders[i] !== contract.xlsxHeaders[i]) {
        violations.push(`第${i}列变样: 活值"${liveHeaders[i]}" ≠ 契约"${contract.xlsxHeaders[i]}"`);
      }
    }
  }
  // ② 平行交付副本检测: 带交付banner的页必须落在 canonical 或合法日期副本,否则=野页/另起页
  const dateRes = (contract.webshareDatedPatterns || []).map((p) => new RegExp(p));
  for (const f of (deliveryBearingHtml || [])) {
    if ((contract.deliveryCanonical || []).includes(f)) continue;
    if (dateRes.some((re) => re.test(f))) continue;
    violations.push(`平行交付副本(野页): "${f}" 带当日交付banner却非canonical/非合法日期副本——0613式另起页?清理或经 --write 纳管`);
  }
  return violations;
}

// CLI 直跑
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("freeze-delivery-contract.mjs")) {
  const write = process.argv.includes("--write");
  const fresh = buildContract();
  if (write) {
    writeFileSync(CONTRACT_PATH, JSON.stringify(fresh, null, 2) + "\n", "utf8");
    console.log(`✅ 已冻结交付契约 → ${CONTRACT_PATH}`);
    console.log(`   列数=${fresh.xlsxHeaderCount} · canonical交付页=${fresh.deliveryCanonical.join("/")} · frozenAt=${fresh.frozenAt}`);
    console.log(`   记得 git add + commit 留痕(改列/白名单=显式动作)。`);
    process.exit(0);
  }
  const contract = existsSync(CONTRACT_PATH) ? JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) : null;
  const v = checkContract(contract, XLSX_HEADERS, []); // CLI 校验只查列契约(野页由 audit:suite 在真目录查)
  if (v.length) {
    console.error("🔴 交付契约不符:\n" + v.map((x) => "  - " + x).join("\n"));
    console.error("如果是合法改列,跑: node scripts/freeze-delivery-contract.mjs --write 重冻并提交。");
    process.exit(1);
  }
  console.log(`✅ 交付契约校验通过(列数=${XLSX_HEADERS.length},与冻结档一致)。`);
}
