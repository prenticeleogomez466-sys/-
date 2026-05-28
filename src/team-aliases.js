/**
 * 球队别名表
 * ──────────────────────────────────────────────────
 * 把不同数据源(竞彩官方/Sina/API-Football/ClubElo/英文 BBC)
 * 的球队中英文写法归一到同一个 canonical key,
 * 让 prediction-engine / dixon-coles-engine 在跨源 join 时不漏匹配。
 *
 * 设计原则:
 *   - normalizeRaw() 把任意原始字符串做"无符号、无空格、小写"处理,
 *     得到 lookup key。再到 ALIAS_TABLE 查 canonical。
 *   - canonical 也会落到 normalizeRaw 之后的形态(全小写、无符号),
 *     这样 fixture-store 的 id 生成、market-data-store 的 fixture 匹配,
 *     都不会再因为 "拜仁" / "拜仁慕尼黑" / "Bayern" / "FC Bayern München" 分裂。
 *   - 不在表里的球队,直接返回 normalizeRaw 后的原值,行为与旧代码兼容,
 *     不影响未覆盖的小联赛。
 *
 * 维护规则:每加一个联赛或一支队,在 ALIAS_TABLE 里写一行映射,
 * 不要在调用方再写 if/switch。
 */

export function normalizeRaw(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9一-鿿]+/g, "");
}

export function canonicalTeamName(value) {
  const key = normalizeRaw(value);
  return ALIAS_TABLE[key] ?? key;
}

// 一对一映射:lookup-key(normalizeRaw 后) → canonical-key(也是 normalizeRaw 后形态)
// canonical 选用最常见的中文短名(无空格),英文源也一律归到这里。
const RAW_ALIASES = {
  // ───── 英超 ─────
  "曼联": "曼联", "曼彻斯特联": "曼联", "manunited": "曼联", "manchesterunited": "曼联",
  "曼城": "曼城", "曼彻斯特城": "曼城", "mancity": "曼城", "manchestercity": "曼城",
  "利物浦": "利物浦", "liverpool": "利物浦",
  "阿森纳": "阿森纳", "arsenal": "阿森纳",
  "切尔西": "切尔西", "chelsea": "切尔西",
  "热刺": "热刺", "托特纳姆": "热刺", "托特纳姆热刺": "热刺", "tottenham": "热刺", "spurs": "热刺",
  "纽卡斯尔": "纽卡斯尔", "纽卡": "纽卡斯尔", "newcastle": "纽卡斯尔",
  "维拉": "阿斯顿维拉", "阿斯顿维拉": "阿斯顿维拉", "astonvilla": "阿斯顿维拉",
  "西汉姆": "西汉姆", "westham": "西汉姆",
  "布莱顿": "布莱顿", "brighton": "布莱顿",
  "水晶宫": "水晶宫", "crystalpalace": "水晶宫",
  "富勒姆": "富勒姆", "fulham": "富勒姆",
  "狼队": "狼队", "wolves": "狼队", "wolverhampton": "狼队",
  "诺丁汉森林": "诺丁汉森林", "诺丁汉": "诺丁汉森林", "nottinghamforest": "诺丁汉森林",
  "埃弗顿": "埃弗顿", "everton": "埃弗顿",
  "布伦特福德": "布伦特福德", "brentford": "布伦特福德",
  "伯恩茅斯": "伯恩茅斯", "bournemouth": "伯恩茅斯",
  "莱斯特城": "莱斯特", "莱斯特": "莱斯特", "leicester": "莱斯特",
  "伊普斯维奇": "伊普斯维奇", "ipswich": "伊普斯维奇",
  "南安普顿": "南安普顿", "southampton": "南安普顿",

  // ───── 西甲 ─────
  "皇马": "皇马", "皇家马德里": "皇马", "realmadrid": "皇马",
  "巴萨": "巴萨", "巴塞罗那": "巴萨", "barcelona": "巴萨", "fcbarcelona": "巴萨",
  "马竞": "马竞", "马德里竞技": "马竞", "atleticomadrid": "马竞", "atletico": "马竞",
  "马洛卡": "马洛卡", "皇家马洛卡": "马洛卡", "mallorca": "马洛卡",
  "塞维利亚": "塞维利亚", "sevilla": "塞维利亚",
  "皇家社会": "皇家社会", "realsociedad": "皇家社会",
  "毕尔巴鄂": "毕尔巴鄂", "毕尔巴鄂竞技": "毕尔巴鄂", "athleticbilbao": "毕尔巴鄂", "athletic": "毕尔巴鄂",
  "维戈塞尔塔": "塞尔塔", "塞尔塔": "塞尔塔", "celtavigo": "塞尔塔", "celta": "塞尔塔",
  "皇家贝蒂斯": "贝蒂斯", "贝蒂斯": "贝蒂斯", "realbetis": "贝蒂斯",
  "比利亚雷亚尔": "比利亚雷亚尔", "黄潜": "比利亚雷亚尔", "villarreal": "比利亚雷亚尔",
  "瓦伦西亚": "瓦伦西亚", "valencia": "瓦伦西亚",
  "赫罗纳": "赫罗纳", "girona": "赫罗纳",
  "巴列卡诺": "巴列卡诺", "rayovallecano": "巴列卡诺",
  "莱加内斯": "莱加内斯", "leganes": "莱加内斯",
  "拉斯帕尔马斯": "拉斯帕尔马斯", "laspalmas": "拉斯帕尔马斯",
  "奥萨苏纳": "奥萨苏纳", "osasuna": "奥萨苏纳",
  "赫塔费": "赫塔费", "getafe": "赫塔费",
  "阿拉维斯": "阿拉维斯", "alaves": "阿拉维斯",
  "巴拉多利德": "巴拉多利德", "valladolid": "巴拉多利德",
  "西班牙人": "西班牙人", "espanyol": "西班牙人",

  // ───── 德甲 ─────
  "拜仁慕尼黑": "拜仁", "拜仁": "拜仁", "bayernmunich": "拜仁", "fcbayern": "拜仁", "bayern": "拜仁",
  "多特蒙德": "多特", "多特": "多特", "borussiadortmund": "多特", "dortmund": "多特", "bvb": "多特",
  "勒沃库森": "勒沃库森", "leverkusen": "勒沃库森", "bayer04": "勒沃库森",
  "莱比锡": "莱比锡", "rbleipzig": "莱比锡", "leipzig": "莱比锡",
  "斯图加特": "斯图加特", "stuttgart": "斯图加特", "vfbstuttgart": "斯图加特",
  "法兰克福": "法兰克福", "eintrachtfrankfurt": "法兰克福", "frankfurt": "法兰克福",
  "霍芬海姆": "霍芬海姆", "hoffenheim": "霍芬海姆",
  "门兴": "门兴", "门兴格拉德巴赫": "门兴", "monchengladbach": "门兴", "borussiamg": "门兴", "gladbach": "门兴",
  "沃尔夫斯堡": "沃尔夫斯堡", "wolfsburg": "沃尔夫斯堡",
  "云达不莱梅": "不莱梅", "不莱梅": "不莱梅", "werderbremen": "不莱梅",
  "美因茨": "美因茨", "mainz05": "美因茨", "mainz": "美因茨",
  "弗赖堡": "弗赖堡", "freiburg": "弗赖堡", "scfreiburg": "弗赖堡",
  "奥格斯堡": "奥格斯堡", "augsburg": "奥格斯堡",
  "波鸿": "波鸿", "bochum": "波鸿",
  "圣保利": "圣保利", "stpauli": "圣保利", "fcstpauli": "圣保利",
  "海登海姆": "海登海姆", "heidenheim": "海登海姆",
  "基尔": "基尔", "holsteinkiel": "基尔",
  "联合柏林": "联合柏林", "unionberlin": "联合柏林",
  "霍尔斯坦基尔": "基尔",
  "帕德博恩": "帕德博恩", "paderborn": "帕德博恩",

  // ───── 意甲 ─────
  "国际米兰": "国米", "国米": "国米", "inter": "国米", "intermilan": "国米",
  "ac米兰": "ac米兰", "米兰": "ac米兰", "acmilan": "ac米兰",
  "尤文图斯": "尤文", "尤文": "尤文", "juventus": "尤文", "juve": "尤文",
  "罗马": "罗马", "asroma": "罗马",
  "拉齐奥": "拉齐奥", "lazio": "拉齐奥",
  "那不勒斯": "那不勒斯", "napoli": "那不勒斯",
  "亚特兰大": "亚特兰大", "atalanta": "亚特兰大",
  "佛罗伦萨": "佛罗伦萨", "fiorentina": "佛罗伦萨",
  "博洛尼亚": "博洛尼亚", "bologna": "博洛尼亚",
  "都灵": "都灵", "torino": "都灵",
  "热那亚": "热那亚", "genoa": "热那亚",
  "莱切": "莱切", "lecce": "莱切",
  "卡利亚里": "卡利亚里", "cagliari": "卡利亚里",
  "维罗纳": "维罗纳", "hellasverona": "维罗纳", "verona": "维罗纳",
  "乌迪内斯": "乌迪内斯", "udinese": "乌迪内斯",
  "蒙扎": "蒙扎", "monza": "蒙扎",
  "恩波利": "恩波利", "empoli": "恩波利",
  "科莫": "科莫", "como": "科莫",
  "威尼斯": "威尼斯", "venezia": "威尼斯",
  "帕尔马": "帕尔马", "parma": "帕尔马",

  // ───── 法甲 ─────
  // 中文体彩官方用"圣日尔曼"(尔),通用译法用"圣日耳曼"(耳)。两种简繁/异译都归到"巴黎"。
  "巴黎圣日耳曼": "巴黎", "巴黎圣日尔曼": "巴黎", "巴黎圣日耳曼足球俱乐部": "巴黎", "巴黎圣日尔曼足球俱乐部": "巴黎",
  "巴黎": "巴黎", "psg": "巴黎", "parissaintgermain": "巴黎",
  "马赛": "马赛", "marseille": "马赛", "om": "马赛",
  "里昂": "里昂", "lyon": "里昂", "olympiquelyonnais": "里昂", "ol": "里昂",
  "里尔": "里尔", "lille": "里尔", "losc": "里尔",
  "摩纳哥": "摩纳哥", "monaco": "摩纳哥",
  "尼斯": "尼斯", "nice": "尼斯", "ognice": "尼斯",
  "雷恩": "雷恩", "rennes": "雷恩",
  "图卢兹": "图卢兹", "toulouse": "图卢兹",
  "斯特拉斯堡": "斯特拉斯堡", "strasbourg": "斯特拉斯堡",
  "南特": "南特", "nantes": "南特",
  "兰斯": "兰斯", "reims": "兰斯",
  "蒙彼利埃": "蒙彼利埃", "montpellier": "蒙彼利埃",
  "布雷斯特": "布雷斯特", "brest": "布雷斯特",
  "勒阿弗尔": "勒阿弗尔", "lehavre": "勒阿弗尔",
  "圣埃蒂安": "圣埃蒂安", "saintetienne": "圣埃蒂安", "asse": "圣埃蒂安",
  "欧塞尔": "欧塞尔", "auxerre": "欧塞尔",
  "昂热": "昂热", "angers": "昂热",
  "朗斯": "朗斯", "lens": "朗斯",

  // ───── 挪超(本季实际推荐覆盖) ─────
  "博多格林特": "博多格林特", "bodoglimt": "博多格林特",
  "莫尔德": "莫尔德", "molde": "莫尔德",
  "罗森博格": "罗森博格", "rosenborg": "罗森博格",
  "瓦勒伦加": "瓦勒伦加", "valerenga": "瓦勒伦加",
  "维京": "维京", "viking": "维京",
  "布兰": "布兰", "brann": "布兰", "sk布兰": "布兰",
  "斯达": "斯达", "stromsgodset": "斯达", "stromsgodsetif": "斯达",
  "特罗姆瑟": "特罗姆瑟", "tromso": "特罗姆瑟",
  "奥勒松": "奥勒松", "aalesund": "奥勒松",
  "汉肯": "汉肯", "汉坎": "汉肯", "haugesund": "汉肯",
  "利勒斯特罗姆": "利勒斯特", "利勒斯特": "利勒斯特", "lillestrom": "利勒斯特",
  "萨普斯堡": "萨普斯堡", "萨尔普斯堡": "萨普斯堡", "sarpsborg": "萨普斯堡", "sarpsborg08": "萨普斯堡",
  "奥斯kfum": "奥斯kfum", "kfumoslo": "奥斯kfum",
  "桑纳菲": "桑纳菲", "sandefjord": "桑纳菲",
  "腓特烈": "腓特烈", "腓特烈斯塔": "腓特烈", "fredrikstad": "腓特烈",

  // ───── 瑞超 ─────
  "马尔默": "马尔默", "malmoff": "马尔默", "malmofotbolltlsforening": "马尔默",
  "哥德堡": "哥德堡", "ifkgoteborg": "哥德堡", "goteborg": "哥德堡",
  "djurgardens": "尤尔加登", "尤尔加登": "尤尔加登",
  "aikstockholm": "aik", "aik": "aik",
  "哈马比": "哈马比", "hammarby": "哈马比",
  "埃尔夫斯堡": "埃夫斯堡", "埃夫斯堡": "埃夫斯堡", "elfsborg": "埃夫斯堡",
  "赫根": "赫根", "hacken": "赫根", "bkhacken": "赫根",
  "米亚尔比": "米亚尔比", "mjallby": "米亚尔比",
  "诺尔切平": "诺尔切平", "norrkoping": "诺尔切平",

  // ───── 中超 ─────
  "上海海港": "海港", "海港": "海港", "shanghaiport": "海港",
  "上海申花": "申花", "申花": "申花", "shanghaishenhua": "申花",
  "山东泰山": "山东泰山", "shandongtaishan": "山东泰山",
  "北京国安": "国安", "国安": "国安", "beijingguoan": "国安",
  "成都蓉城": "成都蓉城", "chengdurongcheng": "成都蓉城",
  "浙江队": "浙江", "浙江": "浙江", "zhejiangfc": "浙江",
  "天津津门虎": "津门虎", "津门虎": "津门虎", "tianjinjinmentiger": "津门虎",
  "武汉三镇": "武汉三镇", "wuhanthreetowns": "武汉三镇",
  "长春亚泰": "长春亚泰", "changchunyatai": "长春亚泰",
  "深圳新鹏城": "新鹏城", "新鹏城": "新鹏城", "shenzhenxinpengcheng": "新鹏城",

  // ───── 芬超(本季有推荐) ─────
  "坦佩雷山猫": "坦山猫", "坦山猫": "坦山猫", "ilves": "坦山猫", "ilvestampere": "坦山猫",
  "赫尔辛基火花": "赫尔火花", "赫尔火花": "赫尔火花", "hjkhelsinki": "赫尔火花", "hjk": "赫尔火花",
  "塞伊奈约基": "塞伊奈", "塞伊奈": "塞伊奈", "seinajoki": "塞伊奈", "spsjk": "塞伊奈",
  "ac奥卢": "ac奥卢", "acoulu": "ac奥卢",
  "kupskuopio": "kups", "kups": "kups",

  // ───── 沙特联(ledger 出现频繁) ─────
  "alittihad": "伊蒂哈德", "伊蒂哈德": "伊蒂哈德",
  "alettifaq": "艾蒂法克", "艾蒂法克": "艾蒂法克",
  "alqadsiah": "卡迪西亚", "卡迪西亚": "卡迪西亚",
  "alhazem": "哈兹姆", "哈兹姆": "哈兹姆",
  "alnassr": "利雅得胜利", "利雅得胜利": "利雅得胜利",
  "alhilal": "利雅得新月", "利雅得新月": "利雅得新月",

  // ───── 巴甲 / 阿甲(14 场常见) ─────
  "弗拉门戈": "弗拉门戈", "flamengo": "弗拉门戈",
  "帕尔梅拉斯": "帕尔梅拉斯", "palmeiras": "帕尔梅拉斯",
  "科林蒂安": "科林蒂安", "corinthians": "科林蒂安",
  "圣保罗": "圣保罗", "saopaulo": "圣保罗",
  "弗鲁米嫩塞": "弗鲁米嫩塞", "fluminense": "弗鲁米嫩塞",
  "博塔弗戈": "博塔弗戈", "botafogo": "博塔弗戈",
  "格雷米奥": "格雷米奥", "gremio": "格雷米奥",
  "国际": "巴西国际", "巴西国际": "巴西国际", "internacional": "巴西国际",
  "普拉滕斯": "普拉滕斯", "platense": "普拉滕斯",
  "库斯科": "库斯科", "cuscofc": "库斯科",

  // ───── 旧映射保留(向后兼容) ─────
  "拜仁慕尼黑": "拜仁",

  // ───── 长形式/带前缀变体(覆盖 NFKD 去重音后的拼写) ─────
  "fcbayernmunchen": "拜仁", "bayernmunchen": "拜仁", "fcbayernmunich": "拜仁",
  "borussiadortmund": "多特", "bvbborussiadortmund": "多特",
  "manchesterunitedfc": "曼联", "manunitedfc": "曼联", "manchutd": "曼联",
  "manchestercityfc": "曼城", "mcfc": "曼城",
  "fcliverpool": "利物浦", "liverpoolfc": "利物浦",
  "arsenalfc": "阿森纳",
  "chelseafc": "切尔西",
  "tottenhamhotspur": "热刺", "tottenhamhotspurfc": "热刺",
  "atleticodemadrid": "马竞", "atletico madrid": "马竞", "atleti": "马竞",
  "realmadridcf": "皇马", "realmadridfc": "皇马",
  "fcbarcelonafc": "巴萨", "barcelonafc": "巴萨",
  "internazionale": "国米", "internazionalemilano": "国米", "fcinternazionalemilano": "国米", "intermilan": "国米",
  "associazionecalciomilan": "ac米兰", "milanac": "ac米兰",
  "juventusfc": "尤文",
  "parissaintgermainfc": "巴黎", "psgparissaintgermain": "巴黎",
  "olympiquedemarseille": "马赛",
  "olympiquelyonnais": "里昂",
  "stadebrest": "布雷斯特", "stadebrestois29": "布雷斯特",
  "ssclazio": "拉齐奥",
  "ssnapoli": "那不勒斯", "sscnapoli": "那不勒斯",
};

const ALIAS_TABLE = Object.fromEntries(
  Object.entries(RAW_ALIASES).map(([raw, canonical]) => [normalizeRaw(raw), normalizeRaw(canonical)])
);

export function listKnownTeams() {
  return [...new Set(Object.values(ALIAS_TABLE))].sort();
}

export function aliasCoverage() {
  return {
    rawEntries: Object.keys(ALIAS_TABLE).length,
    canonicalTeams: listKnownTeams().length,
  };
}
