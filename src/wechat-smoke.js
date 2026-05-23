import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWechatChannelHealth } from "./wechat-channel.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = join(rootDir, "data", "exports");
const date = readArg("--date") ?? todayInShanghai();
const health = buildWechatChannelHealth(date);

mkdirSync(exportDir, { recursive: true });
const path = join(exportDir, `wechat-channel-health-${date}.json`);
writeFileSync(path, `${JSON.stringify(health, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...health, path }, null, 2));
if (!health.ok) process.exitCode = 1;

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
