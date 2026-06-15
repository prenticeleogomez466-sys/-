#!/usr/bin/env node
/**
 * 生成 WC 专属校准档(2026-06-15)。读 recommendation-ledger 的 WC 已结算唯一场,
 * 构建 WC isotonic 校准 profile,写 exports/wc-calibration-profile.json。
 * 当前样本不足(<50)时 usable:false,生产 WC 路由自动 bypass=现状;样本够自动激活。
 * 可接 wc-recap 自动化链每日重建(累积到阈值自动生效)。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";
import { buildWcCalibrationProfile } from "../src/wc-calibration-feedback.js";

const ledgerPath = join(getExportDir(), "recommendation-ledger.json");
const rows = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
const profile = buildWcCalibrationProfile(rows);
profile.generatedAt = new Date().toISOString();

const outPath = join(getExportDir(), "wc-calibration-profile.json");
writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

console.log(`✅ WC 校准档: usable=${profile.usable} samples=${profile.samples}`);
console.log(`   ${profile.reason}`);
console.log(`   reliability: ${JSON.stringify(profile.reliability)}`);
console.log(`   → ${outPath}`);
