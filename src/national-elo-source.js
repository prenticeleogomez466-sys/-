// 国家队 Elo 源(World Football Elo,2026-06-01)——补国家队赛模型支撑,解 odds-only 缺口。
// ───────────────────────────────────────────────────────────────────────────
// 数据:eloratings.net/World.tsv(免授权 HTTP 200,244 国;col2=ISO代码 col3=Elo)。
// 用途:历史库无该国家队(俱乐部联赛源不含国家队友谊/资格赛)→ 用两队 Elo 差转期望进球 λ,
//   喂进同一 DC-τ 矩阵,产 胜平负+比分+半全场(优于纯 odds-only)。
// 诚实边界:友谊赛仍难测(练兵/轮换),Elo 只给"实力差"先验,信心不夸大;主场优势对友谊赛取小值。
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./paths.js";
import { canonicalTeamName } from "./team-aliases.js";

const TSV_URL = "https://www.eloratings.net/World.tsv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const STALE_WARN_DAYS = 7; // 超过即 console ⚠️ 提醒(不阻断 —— 铁律:提示不替用户弃数据)

// ISO 2 字母代码 → 中文国家队名(竞彩常见 + eloratings 代码)。team-aliases 再归一中文短名。
const ISO_CN = {
  ES: "西班牙", AR: "阿根廷", FR: "法国", BR: "巴西", EN: "英格兰", PT: "葡萄牙", NL: "荷兰",
  BE: "比利时", IT: "意大利", DE: "德国", HR: "克罗地亚", CO: "哥伦比亚", MA: "摩洛哥", UY: "乌拉圭",
  CH: "瑞士", US: "美国", MX: "墨西哥", SN: "塞内加尔", DK: "丹麦", JP: "日本", IR: "伊朗",
  KR: "韩国", AT: "奥地利", UA: "乌克兰", SE: "瑞典", PL: "波兰", WA: "威尔士", S3: "塞尔维亚",
  EC: "厄瓜多尔", AU: "澳大利亚", TR: "土耳其", NO: "挪威", RU: "俄罗斯", CZ: "捷克", NG: "尼日利亚",
  EG: "埃及", PE: "秘鲁", SCO: "苏格兰", HU: "匈牙利", PY: "巴拉圭", CR: "哥斯达黎加", TN: "突尼斯",
  CM: "喀麦隆", CL: "智利", CA: "加拿大", RS: "塞尔维亚", DZ: "阿尔及利亚", SK: "斯洛伐克",
  VE: "委内瑞拉", GR: "希腊", CI: "科特迪瓦", QA: "卡塔尔", SA: "沙特阿拉伯", RO: "罗马尼亚",
  SI: "斯洛文尼亚", GH: "加纳", ML: "马里", BA: "波黑", IE: "爱尔兰", FI: "芬兰", IS: "冰岛",
  ZA: "南非", BF: "布基纳法索", CV: "佛得角", UZ: "乌兹别克斯坦", IQ: "伊拉克", JO: "约旦",
  OM: "阿曼", AE: "阿联酋", BH: "巴林", CN: "中国", TH: "泰国", VN: "越南", PA: "巴拿马",
  JM: "牙买加", HN: "洪都拉斯", BG: "保加利亚", ME: "黑山", MK: "北马其顿", MKD: "北马其顿",
  AL: "阿尔巴尼亚", GE: "格鲁吉亚", LU: "卢森堡", KZ: "哈萨克斯坦", BY: "白俄罗斯", AM: "亚美尼亚",
  AZ: "阿塞拜疆", IL: "以色列", CY: "塞浦路斯", NZ: "新西兰", BO: "玻利维亚", GT: "危地马拉",
  SV: "萨尔瓦多", AO: "安哥拉", ZM: "赞比亚", UG: "乌干达", GN: "几内亚", GA: "加蓬", BJ: "贝宁",
};

function eloCachePath() { return join(getDataDir(), "national-elo.json"); }

function parseTsv(text) {
  const map = {};
  for (const line of text.trim().split("\n")) {
    const c = line.split("\t");
    const iso = c[2], elo = Number(c[3]);
    if (iso && Number.isFinite(elo) && ISO_CN[iso]) map[ISO_CN[iso]] = elo;
  }
  return map;
}

// 读缓存;缺失返回 null(由 sync 脚本刷新,预测路径只读不抓网)。
// 2026-06-10 审计rank8:原 `ageH = (Date.now ? null : null)` 恒 null 死代码,TTL 从未生效、
// Elo 陈旧无人知;改真实 mtime 检查,>STALE_WARN_DAYS 天只 console ⚠️ 提醒不阻断(提示不替用户弃数据)。
export function loadNationalElo(path) {
  try {
    const p = path ?? eloCachePath();
    if (!existsSync(p)) return null;
    const ageH = (Date.now() - statSync(p).mtimeMs) / 36e5;
    if (ageH > STALE_WARN_DAYS * 24) {
      console.warn(
        `⚠️ [national-elo] national-elo.json 已 ${(ageH / 24).toFixed(1)} 天未刷新(>${STALE_WARN_DAYS}天),` +
        `Elo 先验可能过期;跑 node scripts/sync-national-elo.mjs 刷新(不阻断,仍使用)。`
      );
    }
    const obj = JSON.parse(readFileSync(p, "utf8"));
    return obj && obj.elo ? obj : null;
  } catch { return null; }
}

// 抓 + 写盘(sync 脚本用)。返回 {ok, count, path}。
export async function syncNationalElo(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const r = await fetchImpl(TSV_URL, { headers: { "User-Agent": UA } });
  if (!r.ok) return { ok: false, status: r.status };
  const text = await r.text();
  const elo = parseTsv(text);
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });
  const out = { source: "eloratings.net/World.tsv", builtAt: opts.builtAt ?? null, count: Object.keys(elo).length, elo };
  const path = eloCachePath();
  writeFileSync(path, JSON.stringify(out, null, 0), "utf8");
  return { ok: true, count: out.count, path };
}

// 查某队 Elo(经 team-aliases 归一中文名)。
export function nationalEloFor(memory, teamName) {
  if (!memory?.elo || !teamName) return null;
  const direct = memory.elo[teamName];
  if (Number.isFinite(direct)) return direct;
  const canon = canonicalTeamName(teamName);
  return Number.isFinite(memory.elo[canon]) ? memory.elo[canon] : null;
}

/**
 * 两队 Elo → 期望进球 λ(国家队赛先验)。
 *   supremacy(净胜球) = (eloHome - eloAway + homeAdv) / eloPerGoal;
 *   total = 市场大小球线优先,否则国家队均值 2.5;λ = (total ± supremacy)/2,夹 [0.2, 3.2]。
 * @param {Object} opts { homeAdv=35(友谊赛取小), eloPerGoal=170, totalGoals }
 */
export function eloToLambdas(eloHome, eloAway, opts = {}) {
  if (!Number.isFinite(eloHome) || !Number.isFinite(eloAway)) return null;
  const homeAdv = opts.homeAdv ?? 35;
  const eloPerGoal = opts.eloPerGoal ?? 170;
  const total = Number.isFinite(opts.totalGoals) && opts.totalGoals > 0.5 ? opts.totalGoals : 2.5;
  const supremacy = (eloHome - eloAway + homeAdv) / eloPerGoal;
  const clamp = (x) => Math.min(3.2, Math.max(0.2, x));
  return { home: clamp((total + supremacy) / 2), away: clamp((total - supremacy) / 2), supremacy: Math.round(supremacy * 100) / 100, eloDiff: eloHome - eloAway };
}
