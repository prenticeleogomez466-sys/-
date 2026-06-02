#!/usr/bin/env node
/**
 * 一次性从维基 2026_FIFA_World_Cup_squads 完整 wikitext 解析全 48 队大名单并入库 team-priors。
 * 交互 session 用:fetch 整页 wikitext(306KB)自己正则解析(绕开 WebFetch 小模型前部截断),
 * 球员名在 {{nat fs ... |name=[[Player]]}} 模板;英文队名→中文映射,未匹配诚实报告、不强塞不编造。
 * 内置审计:写入几队/真实性核验/48队覆盖/未匹配清单。
 */
import { readFileSync, writeFileSync } from "node:fs";
const P = "D:/football-model-data/world-cup/2026/team-priors.json";
const tp = JSON.parse(readFileSync(P, "utf8"));

const en2zh = {};
for (const [zh, v] of Object.entries(tp.teams)) if (v.en) en2zh[v.en] = zh;
// 英文变体 → 中文(维基队名 vs team-priors.en 的差异)
const VARIANT = {
  "South Korea": "韩国", "Korea Republic": "韩国", "Ivory Coast": "科特迪瓦", "Côte d'Ivoire": "科特迪瓦",
  "Turkey": "土耳其", "Türkiye": "土耳其", "United States": "美国", "USA": "美国", "Cape Verde": "佛得角",
  "DR Congo": "刚果民主共和国", "Congo DR": "刚果民主共和国", "Curaçao": "库拉索", "Curacao": "库拉索",
  "IR Iran": "伊朗", "Iran": "伊朗", "New Zealand": "新西兰", "Saudi Arabia": "沙特阿拉伯",
  "Bosnia and Herzegovina": "波黑", "England": "英格兰", "Germany": "德国", "Japan": "日本",
  "Belgium": "比利时", "Croatia": "克罗地亚", "Iraq": "伊拉克", "Australia": "澳大利亚", "Netherlands": "荷兰",
  "Spain": "西班牙", "France": "法国", "Brazil": "巴西", "Argentina": "阿根廷", "Portugal": "葡萄牙",
  "Czech Republic": "捷克", "Czechia": "捷克", "Mexico": "墨西哥", "South Africa": "南非", "Canada": "加拿大",
  "Qatar": "卡塔尔", "Switzerland": "瑞士", "Morocco": "摩洛哥", "Scotland": "苏格兰", "Haiti": "海地",
  "Paraguay": "巴拉圭", "Austria": "奥地利", "Algeria": "阿尔及利亚", "Uzbekistan": "乌兹别克斯坦",
  "Jordan": "约旦", "Panama": "巴拿马", "Ghana": "加纳", "Senegal": "塞内加尔", "Ecuador": "厄瓜多尔",
  "Tunisia": "突尼斯", "Uruguay": "乌拉圭", "Colombia": "哥伦比亚", "Norway": "挪威",
};

function clean(s) {
  s = s.trim().replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/'''|''/g, "").replace(/\{\{.*?\}\}/g, "").trim();
  return s;
}

(async () => {
  const t = await (await fetch("https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_squads?action=raw")).text();
  // 按 ===Team=== 分段
  const parts = t.split(/^===\s*([^=].*?)\s*===\s*$/m);
  const squads = {};
  for (let i = 1; i < parts.length; i += 2) {
    const team = parts[i].trim();
    const body = parts[i + 1] || "";
    const names = [...body.matchAll(/\|\s*name\s*=\s*([^|}\n]+)/g)].map((m) => clean(m[1])).filter((n) => n && n.length > 1 && !/^\d/.test(n));
    if (names.length >= 15) squads[team] = names.slice(0, 30);
  }

  let written = 0; const miss = []; const okTeams = [];
  for (const [en, names] of Object.entries(squads)) {
    const zh = VARIANT[en] || en2zh[en];
    if (zh && tp.teams[zh]) { tp.teams[zh].squad = names; tp.teams[zh].squad_source = "wikipedia-2026-squads"; written++; okTeams.push(`${zh}(${names.length})`); }
    else miss.push(`${en}(${names.length}人,未映射中文)`);
  }
  writeFileSync(P, JSON.stringify(tp, null, 2));

  console.log("=== 维基全名单导入审计 ===");
  console.log(`wikitext 解析出 ${Object.keys(squads).length} 队 | 写入 team-priors ${written} 队`);
  const total = Object.keys(tp.teams).length;
  const withSquad = Object.values(tp.teams).filter((x) => Array.isArray(x.squad) && x.squad.length >= 15).length;
  console.log(`48队完整名单覆盖: ${withSquad}/${total}`);
  if (miss.length) { console.log(`\n⚠ 未映射中文(不强塞,需补VARIANT):`); miss.forEach((m) => console.log("  " + m)); }
  // 真实性核验
  let bad = 0;
  for (const x of Object.values(tp.teams)) if (Array.isArray(x.squad)) for (const p of x.squad) if (!p || /^(player|tbd|n\/a)/i.test(p)) bad++;
  console.log(`\n真实性核验: ${bad === 0 ? "✅ 0 空名/占位" : "❌ " + bad + " 异常"}`);
})();
