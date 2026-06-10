import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 缺陷#3 回归(2026-06-10):build-scrape-from-xml 原离散度定向链路抽到共享模块后不破——
//   ①正常命名照常产出 ②人工互换 XML 注入自动纠正(欧赔仍在 oddsCell 前三位)
//   ③投票不确定 → 退出码≠0 且不落盘(不再"保守按文件名"硬猜)。
// 全程 FOOTBALL_DATA_DIR 指向临时目录,绝不碰真实 D:\football-model-data。

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(rootDir, "scripts", "build-scrape-from-xml.mjs");
const DATE = "2026-06-13";

const xmlOf = (rows3) => `<xml>\n` + rows3.map(({ num, home, away, w, d, l }) =>
  `<m id="${num}" matchnum="${num}" date="${DATE}" league="测试联赛" home="${home}" away="${away}">\n` +
  `<row win="${w}" draw="${d}" lost="${l}" updatetime="${DATE} 10:00:00"/>\n` +
  `<row win="${w}" draw="${d}" lost="${l}" updatetime="${DATE} 09:00:00"/>\n` +
  `</m>`).join("\n") + `\n</xml>`;

// 1X2(悬殊大热,离散)vs 让球(收敛);6003=只卖让球的悬殊场(1X2 未开售)
const EURO_XML = xmlOf([
  { num: "6001", home: "匈牙利", away: "阿塞拜疆", w: "1.17", d: "5.35", l: "11.5" },
  { num: "6002", home: "甲", away: "乙", w: "1.30", d: "4.80", l: "9.00" },
]);
const HC_XML = xmlOf([
  { num: "6001", home: "匈牙利", away: "阿塞拜疆", w: "3.11", d: "3.36", l: "1.96" },
  { num: "6002", home: "甲", away: "乙", w: "2.80", d: "3.20", l: "2.30" },
  { num: "6003", home: "悬殊主", away: "悬殊客", w: "2.95", d: "3.30", l: "2.10" },
]);
const FLAT_XML = xmlOf([
  { num: "6001", home: "匈牙利", away: "阿塞拜疆", w: "2.50", d: "3.10", l: "2.80" },
  { num: "6002", home: "甲", away: "乙", w: "2.60", d: "3.20", l: "2.70" },
]);

function runBuildScrape(spfContent, nspfContent) {
  const base = mkdtempSync(join(tmpdir(), "spf-orient-"));
  const dataDir = join(base, "data");
  mkdirSync(join(dataDir, "crawler"), { recursive: true });
  const spfPath = join(base, "spf.xml");
  const nspfPath = join(base, "nspf.xml");
  writeFileSync(spfPath, spfContent, "utf8");
  writeFileSync(nspfPath, nspfContent, "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--date", DATE, "--spf", spfPath, "--nspf", nspfPath], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, FOOTBALL_DATA_DIR: dataDir },
    timeout: 60000,
  });
  const outFile = join(dataDir, "crawler", `jingcai-scrape-${DATE}.json`);
  const payload = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null;
  const cleanup = () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows 偶发占用,临时目录留给系统清 */ } };
  return { r, payload, cleanup };
}

const rowOf = (payload, num) => payload.captures[1].rows.find((row) => row[0] === num);

test("build-scrape 回归:正常命名(--spf=1X2)产出不变,oddsCell 前三位=欧赔,悬殊场保留未开售标记", () => {
  const { r, payload, cleanup } = runBuildScrape(EURO_XML, HC_XML);
  try {
    assert.equal(r.status, 0, `应正常退出,stderr=${r.stderr}`);
    assert.ok(payload, "应写出 scrape 文件");
    assert.ok(rowOf(payload, "6001")[5].startsWith("1.17 5.35 11.5"), `欧赔应在前三位,实得 ${rowOf(payload, "6001")[5]}`);
    assert.ok(rowOf(payload, "6001")[5].includes("3.11 3.36 1.96"), "让球应在后三位");
    assert.ok(rowOf(payload, "6003")[5].startsWith("未开售"), "只卖让球的悬殊场应标 1X2 未开售");
    assert.match(r.stdout, /1X2 feed = --spf/);
  } finally { cleanup(); }
});

test("build-scrape 互换注入:--spf 实为让球 → 自动纠正,欧赔仍在前三位(06-09 事故不复现)", () => {
  const { r, payload, cleanup } = runBuildScrape(HC_XML, EURO_XML);
  try {
    assert.equal(r.status, 0, `应正常退出,stderr=${r.stderr}`);
    assert.ok(payload, "应写出 scrape 文件");
    assert.ok(rowOf(payload, "6001")[5].startsWith("1.17 5.35 11.5"), `互换日欧赔仍须在前三位(匈牙利 1.17 大热不被推反),实得 ${rowOf(payload, "6001")[5]}`);
    assert.ok(rowOf(payload, "6001")[5].includes("3.11 3.36 1.96"));
    assert.match(r.stdout, /1X2 feed = --nspf/);
  } finally { cleanup(); }
});

test("build-scrape 投票不确定:退出码≠0 且不落盘(绝不按文件名硬猜)", () => {
  const { r, payload, cleanup } = runBuildScrape(FLAT_XML, FLAT_XML);
  try {
    assert.notEqual(r.status, 0, "uncertain 必须非零退出");
    assert.equal(payload, null, "uncertain 绝不写 scrape 文件");
    assert.match(r.stderr, /人工复核/);
  } finally { cleanup(); }
});
