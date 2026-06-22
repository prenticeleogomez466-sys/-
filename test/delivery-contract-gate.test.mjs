// 交付契约硬闸守护测试(2026-06-13 用户最高指令:版式漂移/另起野页 彻底焊死)
//   防废闸:真实契约+真实活值必须过;喂毒:改列序/改列数/平行交付副本(0613式另起页)必须被拦。
//   配套 scripts/freeze-delivery-contract.mjs + audit-suite.mjs 的 delivery-contract 探针。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContract, checkContract } from "../scripts/freeze-delivery-contract.mjs";
import { XLSX_HEADERS } from "../src/today-delivery-lib.js";

const contract = buildContract();

test("防废闸:真实契约 + 真实活列头 + 干净交付页 → 零违规", () => {
  // 带交付 banner 的页全部落在 canonical / 合法日期副本
  const clean = ["今日足球推荐.html", "football.html", "足球推荐-2026-06-13.html", "football-2026-06-13.html"];
  assert.deepEqual(checkContract(contract, XLSX_HEADERS, clean), []);
});

test("契约自洽:buildContract 冻结的列头 == 活的 XLSX_HEADERS(冻结即活值,无手抄漂移)", () => {
  assert.deepEqual(contract.xlsxHeaders, XLSX_HEADERS);
  assert.equal(contract.xlsxHeaderCount, 29); // 2026-06-22 末位+🌍世界杯小组形势列(重冻)
});

test("喂毒①:列数被砍(27→17,0613式自搓表) → 必拦", () => {
  const cut = XLSX_HEADERS.slice(0, 17);
  const v = checkContract(contract, cut, []);
  assert.ok(v.some((x) => /列数变样/.test(x)), `应报列数变样,实得: ${v.join("|")}`);
});

test("喂毒②:列序/列名被改(某列改字) → 必拦", () => {
  const tampered = [...XLSX_HEADERS];
  tampered[3] = "胜负平(我自己改的名)";
  const v = checkContract(contract, tampered, []);
  assert.ok(v.some((x) => /第3列变样/.test(x)), `应报第3列变样,实得: ${v.join("|")}`);
});

test("喂毒③:平行交付副本(野页,如0613的worldcup-today.html带交付banner) → 必拦", () => {
  const withRogue = ["今日足球推荐.html", "worldcup-today.html"];
  const v = checkContract(contract, XLSX_HEADERS, withRogue);
  assert.ok(v.some((x) => /平行交付副本.*worldcup-today\.html/.test(x)), `应报野页,实得: ${v.join("|")}`);
});

test("零误伤:彩票/小说/导航页就算混进列表(理论上不会带交付banner)也只看签名后清单——非交付页不入参即不判", () => {
  // 调用方按 banner 预筛,checkContract 只收"带交付banner"的页;此处验证合法日期副本不被误杀
  const v = checkContract(contract, XLSX_HEADERS, ["football-2026-06-10.html", "足球推荐-2026-06-10.html"]);
  assert.deepEqual(v, []);
});

test("契约缺失 → 显式报缺(不静默放行)", () => {
  const v = checkContract(null, XLSX_HEADERS, []);
  assert.ok(v.some((x) => /契约文件缺失/.test(x)));
});
