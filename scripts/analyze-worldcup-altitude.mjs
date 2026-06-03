#!/usr/bin/env node
/**
 * 世界杯海拔实证(过夜轮3,leak-safe 描述统计,不改数据)。
 * 库内 venue=「球场, 城市」,内置城市→海拔表(公开地理常识),按 ≥1200m 分高原/平地。
 * 最干净的自然实验:2010 南非届内(同批球队)高原 vs 海平面场进球率对比。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";

const ALT = { // m,公开地理数据
  "mexico city":2240,"guadalajara":1566,"león":1815,"leon":1815,"toluca":2667,"puebla":2135,
  "monterrey":540,"querétaro":1820,"queretaro":1820,"nezahualcóyotl":2240,"irapuato":1724,
  "johannesburg":1753,"pretoria":1339,"bloemfontein":1395,"rustenburg":1500,"polokwane":1310,
  "nelspruit":660,"port elizabeth":60,"cape town":25,"durban":8,
};
const cityOf = (notes) => (String(notes||"").split(",").pop()||"").trim().toLowerCase();
const altOf  = (notes) => ALT[cityOf(notes)];

const rows = [];
for (const d of listFixtureDates()) {
  const doc = loadFixtures(d); if (doc.source !== "worldcup-history") continue;
  for (const f of doc.fixtures) {
    const m = /世界杯(\d{4})/.exec(f.competition||""); if(!m) continue;
    const r=f.result||{}; const h=Number(r.home),a=Number(r.away);
    if(!Number.isFinite(h)||!Number.isFinite(a)) continue;
    rows.push({year:Number(m[1]), alt:altOf(f.notes), tot:h+a, draw:h===a?1:0, city:cityOf(f.notes)});
  }
}
const agg=(L)=>{const n=L.length; if(!n)return{n:0}; return{n,gpg:+(L.reduce((s,r)=>s+r.tot,0)/n).toFixed(3),drawPct:+(L.reduce((s,r)=>s+r.draw,0)/n*100).toFixed(1)};};
const cmp=(name,L)=>{
  const hi=L.filter(r=>r.alt>=1200), lo=L.filter(r=>r.alt!=null&&r.alt<1200), un=L.filter(r=>r.alt==null);
  const H=agg(hi),Lo=agg(lo);
  console.log(`\n【${name}】(高原${H.n} / 平地${Lo.n} / 未匹配${un.length})`);
  console.log(`  高原≥1200m : ${H.n}场 场均${H.gpg} 平局${H.drawPct}%`);
  console.log(`  平地<1200m : ${Lo.n}场 场均${Lo.gpg} 平局${Lo.drawPct}%`);
  if(H.gpg&&Lo.gpg) console.log(`  → 高原/平地 进球比 = ${(H.gpg/Lo.gpg).toFixed(3)}  进球差 = ${(H.gpg-Lo.gpg>=0?'+':'')}${(H.gpg-Lo.gpg).toFixed(3)}球/场`);
  if(un.length){const cs=[...new Set(un.map(r=>r.city))].filter(Boolean);if(cs.length)console.log(`  未匹配城市: ${cs.join(", ")}`);}
};

console.log("══════ 世界杯海拔实证 ══════");
cmp("2010 南非·届内自然实验", rows.filter(r=>r.year===2010));
cmp("1970+1986 墨西哥(高原届)", rows.filter(r=>r.year===1970||r.year===1986));
cmp("全部可匹配场合并", rows.filter(r=>r.alt!=null));
console.log("\n诚实:仅墨西哥/南非两东道国城市有海拔表,其余届未匹配;描述统计非命中率净增益。");
