/**
 * 球员名/位置中文化(2026-06-16 用户裁决:情报详情用中文·知名球员转中文+位置中文)
 * ────────────────────────────────────────────────────────────
 * 铁律(guardrail 绝不编造,最高优先级):
 *   - 位置代码 → 中文:确定性映射(ESPN 位置码标准含义),无歧义。未知码原样返回。
 *   - 球员名 → 中文:只收录【有公认通用中文译名】的知名国脚/五大联赛主力(可追溯),
 *     生僻小国球员无权威中文名的【保留拉丁原名,绝不瞎音译】(防编造)。
 *   纯查表、零 I/O、决定性。映射缺=保留原文,不猜。
 */

// ESPN 位置代码 → 中文(后缀 -L/-R/-C 表左/右/中路)。未知码原样返回。
const POSITION_ZH = {
  G: "门将", GK: "门将",
  RB: "右后卫", LB: "左后卫", RWB: "右翼卫", LWB: "左翼卫",
  CB: "中卫", "CB-L": "左中卫", "CB-R": "右中卫", "CB-C": "中卫",
  CD: "中卫", "CD-L": "左中卫", "CD-R": "右中卫", "CD-C": "中卫",
  DM: "后腰", "DM-L": "左后腰", "DM-R": "右后腰", "DM-C": "后腰",
  CM: "中前卫", "CM-L": "左中前卫", "CM-R": "右中前卫", "CM-C": "中前卫",
  LM: "左前卫", RM: "右前卫", M: "中场",
  AM: "前腰", "AM-L": "左前腰", "AM-R": "右前腰", "AM-C": "前腰",
  LW: "左边锋", RW: "右边锋", LF: "左边锋", RF: "右边锋",
  F: "前锋", CF: "中锋", "CF-L": "左中锋", "CF-R": "右中锋", "CF-C": "中锋",
  ST: "前锋", S: "前锋", SUB: "替补",
};

// 知名球员 → 公认通用中文译名(只收可追溯的国脚/五大联赛主力;键=ESPN 名单原名,精确匹配)。
const PLAYER_ZH = {
  // 英格兰
  "Harry Kane": "哈里·凯恩", "John Stones": "斯通斯", "Marcus Rashford": "拉什福德",
  "Anthony Gordon": "安东尼·戈登", "Jordan Henderson": "亨德森", "Jordan Pickford": "皮克福德",
  "Marc Guéhi": "格伊", "Ezri Konsa": "孔萨", "Kobbie Mainoo": "梅努",
  "Elliot Anderson": "埃利奥特·安德森", "Aaron Wan-Bissaka": "万-比萨卡", "Djed Spence": "斯彭斯",
  // 法国
  "Kylian Mbappé": "姆巴佩", "Adrien Rabiot": "拉比奥", "Aurélien Tchouaméni": "琼阿梅尼",
  "Dayot Upamecano": "于帕梅卡诺", "Michael Olise": "奥利塞", "Mike Maignan": "迈尼昂",
  "Theo Hernández": "特奥·埃尔南德斯", "Désiré Doué": "多埃", "Ibrahima Konaté": "科纳特",
  "Jules Koundé": "孔德", "Marcus Thuram": "图拉姆", "Habib Diarra": "迪亚拉",
  // 葡萄牙
  "Cristiano Ronaldo": "克里斯蒂亚诺·罗纳尔多", "Bruno Fernandes": "布鲁诺·费尔南德斯",
  "Diogo Dalot": "达洛特", "Nélson Semedo": "塞梅多", "João Cancelo": "坎塞洛",
  "Gonçalo Ramos": "贡萨洛·拉莫斯", "Gonçalo Inácio": "伊纳西奥", "José Sá": "何塞·萨",
  "Francisco Conceição": "弗朗西斯科·孔塞桑", "Francisco Trincão": "特林康", "Samú Costa": "萨穆·科斯塔",
  // 阿根廷
  "Cristian Romero": "罗梅罗", "Nicolás Otamendi": "奥塔门迪", "Emiliano Martínez": "埃米利亚诺·马丁内斯",
  "Alexis Mac Allister": "麦卡利斯特", "Enzo Fernández": "恩佐·费尔南德斯", "Exequiel Palacios": "帕拉西奥斯",
  "Giovani Lo Celso": "洛塞尔索", "Julián Álvarez": "胡利安·阿尔瓦雷斯", "Thiago Almada": "阿尔马达",
  "Giuliano Simeone": "吉乌利亚诺·西蒙尼",
  // 挪威
  "Erling Haaland": "哈兰德", "Alexander Sørloth": "瑟尔罗特", "Antonio Nusa": "努萨",
  "Sander Berge": "贝里", "Fredrik Aursnes": "奥尔斯内斯", "Kristoffer Ajer": "阿耶尔",
  "Julian Ryerson": "瑞尔森", "Ørjan Nyland": "尼兰", "Jørgen Strand Larsen": "斯特兰德·拉森",
  // 克罗地亚
  "Luka Modric": "莫德里奇", "Ivan Perisic": "佩里西奇", "Andrej Kramaric": "克拉马里奇",
  "Josko Gvardiol": "格瓦迪奥尔", "Dominik Livakovic": "利瓦科维奇", "Josip Stanisic": "斯坦尼西奇",
  "Josip Sutalo": "苏塔洛", "Petar Sucic": "苏契奇",
  // 哥伦比亚
  "Luis Díaz": "路易斯·迪亚斯", "James Rodríguez": "哈梅斯·罗德里格斯", "Jhon Arias": "阿里亚斯",
  "Davinson Sánchez": "达文森·桑切斯", "Johan Mojica": "莫希卡", "Daniel Muñoz": "丹尼尔·穆尼奥斯",
  "Jefferson Lerma": "莱尔马", "Richard Ríos": "里奥斯", "Camilo Vargas": "巴尔加斯",
  "Luis Suárez": "路易斯·苏亚雷斯",
  // 奥地利
  "Marko Arnautovic": "阿瑙托维奇", "Konrad Laimer": "莱默尔", "Marcel Sabitzer": "萨比策尔",
  "Nicolas Seiwald": "赛瓦尔德", "Christoph Baumgartner": "鲍姆加特纳", "Alexander Schlager": "施拉格尔",
  "Philipp Lienhart": "林哈特", "Michael Gregoritsch": "格雷戈里奇", "Marco Friedl": "弗里德尔",
  // 捷克
  "Patrik Schick": "希克", "Tomás Soucek": "索切克", "Adam Hlozek": "赫洛热克",
  "Ladislav Krejcí": "克莱伊奇", "Vladimír Coufal": "库法尔",
  // 阿尔及利亚
  "Riyad Mahrez": "马赫雷斯", "Mohamed Amoura": "阿穆拉", "Amine Gouiri": "古伊里",
  "Houssem Aouar": "阿瓦尔", "Aïssa Mandi": "曼迪", "Rayan Aït-Nouri": "艾特-努里",
  "Luca Zidane": "卢卡·齐达内",
  // 加纳
  "Thomas Partey": "托马斯·帕尔泰", "Jordan Ayew": "阿尤", "Antoine Semenyo": "塞门约",
  "Fatawu Issahaku": "伊萨哈库", "Alexander Djiku": "吉库",
  // 塞内加尔
  "Iliman Ndiaye": "伊利曼·恩迪亚耶", "Ismaïla Sarr": "萨尔", "Krépin Diatta": "迪亚塔",
  "Ismail Jakobs": "雅各布斯", "Lamine Camara": "卡马拉",
  // 韩国
  "Son Heung-Min": "孙兴慜", "Kim Min-Jae": "金玟哉", "Lee Jae-Sung": "李在城",
  "Kim Seung-Gyu": "金承奎",
  // 墨西哥
  "César Montes": "蒙特斯", "Jesús Gallardo": "加利亚多", "Johan Vásquez": "巴斯克斯",
  "Roberto Alvarado": "阿尔瓦拉多", "Raúl Jiménez": "劳尔·希门尼斯", "Jorge Sánchez": "桑切斯",
  // 加拿大
  "Jonathan David": "乔纳森·戴维", "Cyle Larin": "拉林", "Tajon Buchanan": "布坎南",
  "Stephen Eustáquio": "尤斯塔基奥", "Alistair Johnston": "约翰斯顿", "Ismaël Koné": "科内",
  // 亚洲/非洲其他知名
  "Akram Afif": "阿菲夫", "Eldor Shomurodov": "绍穆罗多夫", "Abdukodir Khusanov": "胡萨诺夫",
  "Chancel Mbemba": "姆贝姆巴", "Cédric Bakambu": "巴坎布", "Marco Pasalic": "帕沙利奇",
  // 2026-06-17 扩充(顶级联赛主力/公认中文译名·仍只收有把握的,生僻保留原文)
  "Ante Budimir": "布迪米尔",          // 克罗地亚·奥萨苏纳射手
  "Yoane Wissa": "维萨",               // 刚果金·布伦特福德(英超)
  "Lyle Foster": "莱尔·福斯特",        // 南非·伯恩利(英超)
  "Mousa Al-Tamari": "塔马里",         // 约旦·蒙彼利埃(法甲)
  "Arthur Masuaku": "马苏阿库",        // 刚果金·前西汉姆
  "Axel Tuanzebe": "图安泽贝",         // 刚果金·前曼联
  "Edo Kayembe": "卡延贝",             // 刚果金·沃特福德
  "Matej Kovár": "科瓦日",             // 捷克门将·勒沃库森
  "Marko Arnautovic": "阿瑙托维奇",    // (奥地利·已收同名保险)
  "Derrick Köhn": "科恩",              // 刚果金·加拉塔萨雷左后卫
  "Samuel Moutoussamy": "穆图萨米",    // 刚果金·南特
  // 2026-06-20 扩充(今日竞彩4场+14场各队知名球员·公认中文译名/日本汉字名,仍只收有把握的,生僻保留原文)
  // 荷兰
  "Cody Gakpo": "加克波", "Donyell Malen": "马伦", "Virgil van Dijk": "范戴克",
  "Bart Verbruggen": "维尔布鲁根", "Denzel Dumfries": "邓弗里斯", "Micky van de Ven": "范德文",
  "Ryan Gravenberch": "赫拉文贝赫", "Tijjani Reijnders": "雷因德斯", "Frenkie de Jong": "弗兰基·德容",
  "Memphis Depay": "德佩", "Nathan Aké": "阿克", "Xavi Simons": "哈维·西蒙斯",
  "Crysencio Summerville": "萨默维尔", "Jurriën Timber": "蒂姆贝尔",
  // 瑞典
  "Alexander Isak": "伊萨克", "Viktor Gyökeres": "约克雷斯", "Dejan Kulusevski": "库卢塞夫斯基",
  "Emil Forsberg": "福斯贝里", "Anthony Elanga": "埃兰加", "Isak Hien": "希恩",
  "Gabriel Gudmundsson": "古德蒙松", "Kristoffer Nordfeldt": "诺德费尔特",
  // 德国
  "Florian Wirtz": "维尔茨", "Jonathan Tah": "塔", "Joshua Kimmich": "基米希",
  "Nico Schlotterbeck": "施洛特贝克", "Kai Havertz": "哈弗茨", "Jamal Musiala": "穆夏拉",
  "Leroy Sané": "萨内", "Aleksandar Pavlovic": "帕夫洛维奇", "Oliver Baumann": "鲍曼",
  "Antonio Rüdiger": "吕迪格", "Serge Gnabry": "格纳布里", "İlkay Gündoğan": "京多安",
  "Marc-André ter Stegen": "特尔施特根", "Niclas Füllkrug": "菲尔克鲁格", "Felix Nmecha": "恩梅查",
  // 科特迪瓦
  "Franck Kessié": "凯西", "Nicolas Pépé": "佩佩", "Seko Fofana": "塞科·福法纳",
  "Wilfried Singo": "辛戈", "Simon Adingra": "阿丁格拉", "Elye Wahi": "瓦希",
  // 厄瓜多尔
  "Moisés Caicedo": "凯塞多", "Enner Valencia": "瓦伦西亚", "Gonzalo Plata": "普拉塔",
  "Willian Pacho": "帕乔", "Pervis Estupiñán": "埃斯图皮尼安", "Piero Hincapié": "因卡皮耶",
  "Félix Torres": "费利克斯·托雷斯", "Joel Ordóñez": "奥多涅斯",
  // 库拉索(多数生僻保留原文,仅收效力顶级联赛者)
  "Riechedly Bazoer": "巴泽尔", "Tahith Chong": "钟", "Leandro Bacuna": "莱安德罗·巴库纳", "Juninho Bacuna": "胡尼尼奥·巴库纳",
  // 突尼斯
  "Ellyes Skhiri": "斯基里", "Hannibal Mejbri": "梅杰布里", "Montassar Talbi": "塔尔比",
  "Rani Khedira": "拉尼·赫迪拉",
  // 补充(顶级/次顶级联赛主力·有通用译名)
  "Jan Paul van Hecke": "范赫克",      // 荷兰·布莱顿
  "Daniel Svensson": "斯文森",          // 瑞典·多特蒙德
  "Emmanuel Agbadou": "阿格巴杜",       // 科特迪瓦·狼队(英超)
  "Guela Doué": "杜埃",                 // 科特迪瓦·斯特拉斯堡
  "Yasin Ayari": "阿亚里",              // 瑞典·布莱顿
  // 2026-06-20 二次扩充(次顶级联赛常规主力·有可查通用译名)
  "Hernán Galíndez": "加林德斯",        // 厄瓜多尔·主力门将
  "Eloy Room": "鲁姆",                  // 库拉索·门将(MLS)
  "Omar Rekik": "雷基克",               // 突尼斯·阿森纳青训
  "Ghislain Konan": "科南",             // 科特迪瓦·兰斯(法甲)
  "Benjamin Nygren": "尼格伦",          // 瑞典·凯尔特人
  "Anis Slimane": "斯利曼",             // 突尼斯·雷恩/布莱克本
  "Ismaël Gharbi": "加尔比",            // 突尼斯·PSG青训/布拉加
  "Elias Saad": "埃利亚斯·萨德",        // 突尼斯·圣保利(德甲)
  "Nathaniel Brown": "纳撒尼尔·布朗",   // 德国·法兰克福
  "Yahia Fofana": "亚希亚·福法纳",      // 科特迪瓦·昂热门将(法甲)
  // 日本(汉字名·精确)
  "Zion Suzuki": "铃木彩艳", "Ayase Ueda": "上田绮世", "Ritsu Doan": "堂安律",
  "Daichi Kamada": "镰田大地", "Daizen Maeda": "前田大然", "Hiroki Ito": "伊藤洋辉",
  "Keito Nakamura": "中村敬斗", "Junya Ito": "伊东纯也", "Ao Tanaka": "田中碧",
  "Takefusa Kubo": "久保建英", "Wataru Endo": "远藤航", "Kaoru Mitoma": "三笘薫",
  "Takehiro Tomiyasu": "富安健洋", "Ko Itakura": "板仓滉", "Tsuyoshi Watanabe": "渡边刚",
  "Kaishu Sano": "佐野海舟",
};

// 主帅 → 中文(2026-06-20 用户:表内不留英文;只收有把握的,生僻保留原名·不瞎译)。键=team-priors 原名。
const COACH_ZH = {
  "Ronald Koeman": "罗纳德·科曼", "Graham Potter": "格雷厄姆·波特", "Julian Nagelsmann": "朱利安·纳格尔斯曼",
  "Emerse Faé": "埃默斯·法埃", "Sebastián Beccacece": "塞巴斯蒂安·贝卡塞塞", "Dick Advocaat": "迪克·阿德沃卡特",
  "Sabri Lamouchi": "萨布里·拉穆奇", "Hajime Moriyasu": "森保一",
  "Luis de la Fuente": "路易斯·德拉富恩特", "Hervé Renard": "埃尔韦·勒纳尔", "Marcelo Bielsa": "马塞洛·别尔萨",
  "Hossam Hassan": "侯萨姆·哈桑", "Lionel Scaloni": "斯卡洛尼", "Ralf Rangnick": "拉尔夫·朗尼克",
  "Didier Deschamps": "德尚", "Ståle Solbakken": "索尔巴肯", "Vladimir Petković": "彼得科维奇",
  "Roberto Martínez": "罗伯托·马丁内斯", "Thomas Tuchel": "图赫尔", "Otto Addo": "奥托·阿多",
  "Thomas Christiansen": "克里斯蒂安森", "Zlatko Dalić": "达利奇", "Néstor Lorenzo": "内斯托尔·洛伦索",
};

/** 主帅名 → 中文(知名才转);无权威中文名→保留原名(不瞎译)。 */
export function translateCoach(name) {
  if (name == null) return "";
  const n = String(name).trim();
  return COACH_ZH[n] ?? n;
}

/** 位置代码 → 中文;未知码原样返回(不编)。 */
export function translatePosition(code) {
  if (code == null || code === "") return "";
  const c = String(code).trim().toUpperCase();
  return POSITION_ZH[c] ?? code;
}

/** 球员名 → 中文(知名才转);无权威中文名→保留拉丁原名(不瞎音译)。 */
export function translatePlayer(name) {
  if (name == null) return "";
  const n = String(name).trim();
  return PLAYER_ZH[n] ?? n;
}

/**
 * 单人显示:中文名(位置中文·X/N首发·铁主力)。知名→中文名,生僻→原名;位置确定性中文。
 * @param {{name,position?,starts?}} p
 * @param {number|null} n 预测首发样本场数(近N场);给了且有 starts→显示首发频次(细胞级·可追溯)
 */
export function playerDisplay(p, n = null) {
  if (!p) return "";
  const nm = translatePlayer(p.name);
  const pos = p.position ? translatePosition(p.position) : "";
  const N = Number(n), st = Number(p.starts);
  let freq = "";
  if (N > 0 && Number.isFinite(st)) freq = `${pos ? "·" : ""}${st}/${N}首发${st >= N ? "·铁主力" : st <= N / 2 ? "·轮换" : ""}`;
  const inner = `${pos}${freq}`;
  return inner ? `${nm}(${inner})` : nm;
}

export { POSITION_ZH, PLAYER_ZH, COACH_ZH };
