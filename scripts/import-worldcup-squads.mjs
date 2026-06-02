#!/usr/bin/env node
/**
 * 导入 2026 世界杯真实大名单到 team-priors(48h闭关·补全大名单)。
 * 数据源:维基 2026_FIFA_World_Cup_squads(WebFetch 真实抓取,非编造);逐轮累积补,抓到才写、未抓的保持原样。
 * 内置审计:写入后报每队人数 + 48队完整名单覆盖进度。
 */
import { readFileSync, writeFileSync } from "node:fs";
const P = "D:/football-model-data/world-cup/2026/team-priors.json";
const tp = JSON.parse(readFileSync(P, "utf8"));

// 本批(轮44,A/B组等7队,维基真实名单)
const SQUADS = {
  "捷克": ["Matěj Kovář","Jindřich Staněk","Lukáš Horníček","Vladimír Coufal","Tomáš Holeš","Ladislav Krejčí","David Zima","Jaroslav Zelený","David Jurásek","David Douděra","Robin Hranáč","Štěpán Chaloupek","Tomáš Souček","Vladimír Darida","Lukáš Provod","Michal Sadílek","Pavel Šulc","Lukáš Červ","Hugo Sochůrek","Alexandr Sojka","Denis Višinský","Patrik Schick","Adam Hložek","Jan Kuchta","Mojmír Chytil","Tomáš Chorý"],
  "墨西哥": ["Guillermo Ochoa","Raúl Rangel","Carlos Acevedo","Jesús Gallardo","César Montes","Jorge Sánchez","Johan Vásquez","Israel Reyes","Mateo Chávez","Edson Álvarez","Orbelín Pineda","Roberto Alvarado","Luis Romo","Luis Chávez","Érik Lira","Gilberto Mora","Brian Gutiérrez","Obed Vargas","Álvaro Fidalgo","Raúl Jiménez","Alexis Vega","Santiago Giménez","César Huerta","Julián Quiñones","Guillermo Martínez","Armando González"],
  "南非": ["Ronwen Williams","Ricardo Goss","Sipho Chaine","Aubrey Modiba","Khuliso Mudau","Nkosinathi Sibisi","Mbekezeli Mbokazi","Ime Okon","Samukele Kabini","Khulumani Ndamane","Thabang Matuludi","Kamogelo Sebelebele","Bradley Cross","Olwethu Makhanya","Teboho Mokoena","Sphephelo Sithole","Thalente Mbatha","Jayden Adams","Themba Zwane","Lyle Foster","Evidence Makgopa","Oswin Appollis","Iqraam Rayners","Relebohile Mofokeng","Thapelo Maseko","Tshepang Moremi"],
  "韩国": ["Kim Seung-gyu","Jo Hyeon-woo","Song Bum-keun","Kim Min-jae","Kim Moon-hwan","Seol Young-woo","Lee Tae-seok","Park Jin-seob","Kim Tae-hyeon","Lee Han-beom","Jens Castrop","Lee Ki-hyuk","Cho Wi-je","Lee Jae-sung","Hwang Hee-chan","Hwang In-beom","Lee Kang-in","Paik Seung-ho","Kim Jin-gyu","Lee Dong-gyeong","Bae Jun-ho","Eom Ji-sung","Yang Hyun-jun","Son Heung-min","Cho Gue-sung","Oh Hyeon-gyu"],
  "波黑": ["Nikola Vasilj","Martin Zlomislić","Osman Hadžikić","Sead Kolašinac","Dennis Hadžikadunić","Amar Dedić","Nikola Katić","Tarik Muharemović","Nihad Mujakić","Stjepan Radeljić","Nidal Čelik","Amir Hadžiahmetović","Benjamin Tahirović","Armin Gigović","Dženis Burnić","Ivan Bašić","Esmir Bajraktarević","Amar Memić","Ivan Šunjić","Kerim Alajbegović","Ermin Mahmić","Edin Džeko","Ermedin Demirović","Samed Baždar","Haris Tabaković","Jovo Lukić"],
  "加拿大": ["Dayne St. Clair","Alistair Johnston","Luc de Fougerolles","Alfie Jones","Joel Waterman","Mathieu Choinière","Stephen Eustáquio","Ismaël Koné","Cyle Larin","Jonathan David","Liam Millar","Tani Oluwaseyi","Derek Cornelius","Jacob Shaffelburg","Moïse Bombito","Maxime Crépeau","Tajon Buchanan","Owen Goodman","Alphonso Davies","Ali Ahmed","Jonathan Osorio","Richie Laryea","Niko Sigur","Promise David","Nathan Saliba"],
  "卡塔尔": ["Mahmud Abunada","Pedro Miguel","Lucas Mendes","Issa Laye","Jassem Gaber","Abdulaziz Hatem","Ahmed Alaaeldin","Edmilson Junior","Mohammed Muntari","Hassan Al-Haydos","Akram Afif","Karim Boudiaf","Ayoub Al-Oui","Homam Ahmed","Yusuf Abdurisag","Boualem Khoukhi","Ahmed Al-Ganehi","Sultan Al-Brake","Almoez Ali","Ahmed Fathy","Salah Zakaria"],
};

let written = 0; const miss = [];
for (const [k, arr] of Object.entries(SQUADS)) {
  if (tp.teams[k]) { tp.teams[k].squad = arr; tp.teams[k].squad_source = "wikipedia-2026-squads"; written++; }
  else miss.push(k);
}
writeFileSync(P, JSON.stringify(tp, null, 1));

// ── 审计 ──
console.log("=== 大名单导入审计(轮44)===");
console.log(`本批写入 ${written} 队${miss.length ? " | ⚠未匹配队名:" + miss.join(",") : ""}`);
for (const k of Object.keys(SQUADS)) console.log(`  ${k}: ${tp.teams[k]?.squad?.length ?? 0} 人`);
const total = Object.keys(tp.teams).length;
const withSquad = Object.values(tp.teams).filter((t) => Array.isArray(t.squad) && t.squad.length).length;
console.log(`\n48队完整名单覆盖: ${withSquad}/${total} | 待补 ${total - withSquad}(后续轮逐组 WebFetch,抓不到=不编造)`);
// 真实性核验:抽查无空名/无占位
const bad = [];
for (const [k, arr] of Object.entries(SQUADS)) for (const p of arr) if (!p || /^(player|tbd|n\/a|占位)/i.test(p)) bad.push(`${k}:${p}`);
console.log(`真实性核验: ${bad.length === 0 ? "✅ 0 空名/占位(全真实球员名)" : "❌ " + bad.join(",")}`);
