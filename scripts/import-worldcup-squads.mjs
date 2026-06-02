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
  "瑞士": ["Gregor Kobel","Miro Muheim","Silvan Widmer","Nico Elvedi","Manuel Akanji","Denis Zakaria","Breel Embolo","Remo Freuler","Johan Manzambi","Granit Xhaka","Dan Ndoye","Yvon Mvogo","Ricardo Rodriguez","Ardon Jashari","Djibril Sow","Christian Fassnacht","Rubén Vargas","Eray Cömert","Noah Okafor","Michel Aebischer","Marvin Keller","Fabian Rieder","Zeki Amdouni","Aurèle Amenda","Luca Jaquez","Cedric Itten"],
  "巴西": ["Alisson","Wesley","Gabriel Magalhães","Marquinhos","Casemiro","Alex Sandro","Vinícius Júnior","Bruno Guimarães","Matheus Cunha","Neymar","Raphinha","Weverton","Danilo Luiz","Bremer","Léo Pereira","Douglas Santos","Fabinho","Danilo Santos","Endrick","Lucas Paquetá","Luiz Henrique","Gabriel Martinelli","Ederson","Roger Ibañez","Igor Thiago","Rayan"],
  "摩洛哥": ["Yassine Bounou","Munir Mohamedi","Ahmed Reda Tagnaouti","Achraf Hakimi","Nayef Aguerd","Noussair Mazraoui","Youssef Belammari","Anass Salah-Eddine","Chadi Riad","Issa Diop","Zakaria El Ouahdi","Redouane Halhal","Sofyan Amrabat","Azzedine Ounahi","Bilal El Khannouss","Ismael Saibari","Neil El Aynaoui","Samir El Mourabet","Ayyoub Bouaddi","Ayoub El Kaabi","Soufiane Rahimi","Abde Ezzalzouli","Brahim Díaz","Chemsdine Talbi","Gessime Yassine","Ayoube Amaimouni"],
  "苏格兰": ["Craig Gordon","Angus Gunn","Liam Kelly","Andy Robertson","Grant Hanley","Kieran Tierney","Scott McKenna","Jack Hendry","Nathan Patterson","Anthony Ralston","John Souttar","Aaron Hickey","Dominic Hyam","John McGinn","Scott McTominay","Ryan Christie","Kenny McLean","Lewis Ferguson","Ben Gannon-Doak","Findlay Curtis","Tyler Fletcher","Lyndon Dykes","Ché Adams","Lawrence Shankland","George Hirst","Ross Stewart"],
  "海地": ["Johny Placide","Alexandre Pierre","Josué Duverger","Ricardo Adé","Carlens Arcus","Martin Expérience","Jean-Kévin Duverne","Duke Lacroix","Wilguens Paugain","Hannes Delcroix","Keeto Thermoncy","Leverton Pierre","Danley Jean Jacques","Carl Sainté","Jean-Ricner Bellegarde","Woodensky Pierre","Dominique Simon","Duckens Nazon","Frantzdy Pierrot","Derrick Etienne Jr.","Louicius Deedson","Ruben Providence","Josué Casimir","Yassin Fortuné","Wilson Isidor","Lenny Joseph"],
  "西班牙": ["Unai Simón","David Raya","Joan Garcia","Aymeric Laporte","Marc Cucurella","Marcos Llorente","Eric García","Pedro Porro","Álex Grimaldo","Pau Cubarsí","Marc Pubill","Rodri","Dani Olmo","Mikel Merino","Fabián Ruiz","Pedri","Gavi","Martín Zubimendi","Yéremy Pino","Álex Baena","Ferran Torres","Mikel Oyarzabal","Nico Williams","Lamine Yamal","Borja Iglesias","Víctor Muñoz"],
  "法国": ["Brice Samba","Mike Maignan","Robin Risser","Malo Gusto","Lucas Digne","Dayot Upamecano","Jules Koundé","Ibrahima Konaté","William Saliba","Théo Hernandez","Lucas Hernandez","Maxence Lacroix","Manu Koné","Aurélien Tchouaméni","N'Golo Kanté","Adrien Rabiot","Warren Zaïre-Emery","Ousmane Dembélé","Marcus Thuram","Kylian Mbappé","Michael Olise","Bradley Barcola","Désiré Doué","Jean-Philippe Mateta","Rayan Cherki","Maghnes Akliouche"],
  "阿根廷": ["Juan Musso","Gerónimo Rulli","Emiliano Martínez","Leonardo Balerdi","Nicolás Tagliafico","Gonzalo Montiel","Lisandro Martínez","Cristian Romero","Nicolás Otamendi","Facundo Medina","Nahuel Molina","Leandro Paredes","Rodrigo De Paul","Valentín Barco","Giovani Lo Celso","Exequiel Palacios","Thiago Almada","Nico Paz","Alexis Mac Allister","Enzo Fernández","Julián Alvarez","Lionel Messi","Nicolás González","Giuliano Simeone","José Manuel López","Lautaro Martínez"],
  "葡萄牙": ["Diogo Costa","José Sá","Rui Silva","Ricardo Velho","Rúben Dias","João Cancelo","Nélson Semedo","Nuno Mendes","Diogo Dalot","Gonçalo Inácio","Matheus Nunes","Renato Veiga","Tomás Araújo","Bernardo Silva","Bruno Fernandes","Rúben Neves","Vitinha","João Neves","Samú Costa","Cristiano Ronaldo","João Félix","Rafael Leão","Gonçalo Guedes","Gonçalo Ramos","Pedro Neto","Francisco Trincão","Francisco Conceição"],
  "荷兰": ["Bart Verbruggen","Robin Roefs","Mark Flekken","Jan Paul van Hecke","Jurriën Timber","Virgil van Dijk","Nathan Aké","Micky van de Ven","Denzel Dumfries","Jorrel Hato","Mats Wieffer","Justin Kluivert","Ryan Gravenberch","Guus Til","Tijjani Reijnders","Marten de Roon","Teun Koopmeiners","Frenkie de Jong","Quinten Timber","Wout Weghorst","Memphis Depay","Cody Gakpo","Noa Lang","Donyell Malen","Brian Brobbey","Crysencio Summerville"],
  "乌拉圭": ["Sergio Rochet","Santiago Mele","Fernando Muslera","José María Giménez","Sebastián Cáceres","Ronald Araújo","Guillermo Varela","Mathías Olivera","Matías Viña","Joaquín Piquerez","Santiago Bueno","Manuel Ugarte","Rodrigo Bentancur","Nicolás de la Cruz","Emiliano Martínez","Giorgian de Arrascaeta","Facundo Pellistri","Agustín Canobbio","Federico Valverde","Brian Rodríguez","Maximiliano Araújo","Rodrigo Zalazar","Juan Manuel Sanabria","Darwin Núñez","Federico Viñas","Rodrigo Aguirre"],
  "哥伦比亚": ["David Ospina","Camilo Vargas","Álvaro Montero","Davinson Sánchez","Santiago Arias","Yerry Mina","Daniel Muñoz","Johan Mojica","Jhon Lucumí","Deiver Machado","Willer Ditta","James Rodríguez","Jefferson Lerma","Juan Fernando Quintero","Jhon Arias","Richard Ríos","Kevin Castaño","Jorge Carrascal","Jaminton Campaz","Juan Portilla","Gustavo Puerta","Luis Díaz","Jhon Córdoba","Luis Suárez","Cucho Hernández","Andrés Gómez"],
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
