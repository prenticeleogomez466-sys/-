import { syncAuthorizedFixturesAndResults } from "./authorized-fixtures.js";

const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();

try {
  const result = await syncAuthorizedFixturesAndResults(date, { strict: args.includes("--strict"), addNew: args.includes("--add-new"), save: !args.includes("--no-save"), resultDate: readArg("--result-date") });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

function readArg(name) {
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
