// 薄壳转发(2026-06-10 输出层单写者收敛,缺陷#7#16):本脚本曾是旁路写者——
// 多脚本各写 同名xlsx/今日足球推荐.html/英文页,实测三面三个日期(xlsx=06-10/手机页=06-09/英文页=06-08)。
// 现输出一律收敛到唯一出口 scripts/today-full-coverage.mjs(xlsx 20列专业版 + 手机页 + 英文固定URL页,
// 三面同源同日期,渲染在 src/today-delivery-lib.js)。保留本文件仅防老调用路径 break,不再自带任何渲染。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const args = process.argv.slice(2);
const readArg = (n) => { const pre = args.find((a) => a.startsWith(`${n}=`)); if (pre) return pre.slice(n.length + 1); const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const date = readArg("--date") ?? args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)); // 缺省由唯一出口取本机UTC+8当日
const target = join(dirname(fileURLToPath(import.meta.url)), "today-full-coverage.mjs");
console.log(`↪ [薄壳] ${basename(fileURLToPath(import.meta.url))} 已收敛到唯一输出出口 today-full-coverage.mjs,转发执行(date=${date ?? "(当日)"} --jconly)…`);
const r = spawnSync(process.execPath, [target, ...(date ? [date] : []), "--jconly"], { stdio: "inherit" });
process.exit(r.status ?? 1);
