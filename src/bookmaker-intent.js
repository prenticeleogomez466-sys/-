/**
 * bookmaker-intent.js —— 庄家意图研判(纯函数·全用真实可得数据·缺维度诚实标)。
 * ──────────────────────────────────────────────────────────────────────────
 * 怎么"搞清庄家意图"而不编(2026-06-18):庄家意图藏在盘口里,但能暴露它的真实数据只有几路——
 *   ① 跨源 sharp 偏离(核心·最硬):国际 sharp 盘(DraftKings 亚盘 / The Odds API 大小球)最接近真实概率;
 *      竞彩(500)盘口系统偏离 sharp 的方向 = 庄家/公众的定价倾向。竞彩比 sharp"更看好"某边=那边被压价
 *      (庄家收公众钱/公众 side);竞彩比 sharp"看淡"某边=那边相对有价值。
 *   ② 1X2 初→即时移动(500 自带两时点·多数场静态·少数真动):热门隐含上升=资金压热门(公众 side=热门)。
 *   诚实边界:1X2 无国际 sharp 对照、收盘线(final)未采集、WC 时序源不刷新 → 移动维度数据弱,不夸大。
 *      sharp 盘 ≠ 收盘线;意图研判只揭示盘口倾向/相对价值方向,公开盘仍打不过收盘线、不保证盈利、只标注。
 *
 * 全纯函数无 IO。复用比例隐含(看方向足够);跨源阈值取与盘口合理性⑦一致(亚盘0.13球/大小球4pp)。
 */
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

function imp1x2(o) {
  if (!o) return null;
  const h = num(o.home), d = num(o.draw), a = num(o.away);
  if (!(h > 1 && d > 1 && a > 1)) return null;
  const s = 1 / h + 1 / d + 1 / a;
  return { home: 1 / h / s, draw: 1 / d / s, away: 1 / a / s };
}

/**
 * @param {{euroInit,euroCur,jcAhLine,dkAsianLine,dkSrc,jcOver,intlOver,intlBooks}} inp
 * @returns {{signals,intent,publicSide,valueHint,dataStrength,caveat}|null}
 */
export function bookmakerIntent(inp) {
  if (!inp) return null;
  const signals = [];
  let publicSide = null, valueHint = null;

  // 热门方(用即时 1X2 隐含定)
  const pc = imp1x2(inp.euroCur);
  const favKey = pc ? (pc.home >= pc.away ? "home" : "away") : null;
  const favZh = favKey === "home" ? "主队" : favKey === "away" ? "客队" : "热门";
  const dogZh = favKey === "home" ? "客队" : "主队";

  // ① 1X2 初→即时移动(500 自带)
  const pi = imp1x2(inp.euroInit);
  if (pi && pc && favKey) {
    const drift = (pc[favKey] - pi[favKey]) * 100;
    if (Math.abs(drift) >= 2) {
      const up = drift > 0;
      signals.push({ type: "1X2移动", dir: up ? "热门被加注" : "热门退烧",
        read: `热门隐含 ${up ? "+" : ""}${drift.toFixed(1)}pp → ${up ? `资金压${favZh}(公众 side=热门)·5年实证该类56.4%胜` : `资金离开${favZh}·5年实证退烧热门仅45.5%胜`}` });
      if (up) publicSide = `${favZh}(热门·被加注)`;
    }
  }

  // ② 亚盘跨源(竞彩 vs DraftKings sharp)——核心意图信号(线可为0=平手盘,合法)
  const jc = num(inp.jcAhLine), dk = num(inp.dkAsianLine);
  const ahValid = jc != null && dk != null;
  if (ahValid) {
    const gap = Math.abs(dk) - Math.abs(jc);
    if (Math.abs(gap) >= 0.13) {
      const deeper = Math.abs(dk) > Math.abs(jc);
      signals.push({ type: "亚盘跨源", dir: deeper ? "sharp更看好热门" : "sharp更看淡热门",
        read: deeper
          ? `${inp.dkSrc || "国际盘"}让球更深(${dk} vs 竞彩${jc})→ sharp 更看好${favZh}、竞彩线偏浅(或滞后)→ 竞彩受让方(${dogZh})相对有值`
          : `${inp.dkSrc || "国际盘"}让球更浅(${dk} vs 竞彩${jc})→ sharp 更看淡${favZh}、竞彩把${favZh}抬高→ 谨慎追${favZh}` });
      valueHint = deeper ? `${dogZh}(竞彩受让方·sharp 暗示竞彩低估)` : `${favZh}方被竞彩抬高·价值差`;
    } else {
      signals.push({ type: "亚盘跨源", dir: "一致", read: `竞彩亚盘线(${jc})与 ${inp.dkSrc || "国际盘"}(${dk})一致 → 竞彩此盘无明显偏离` });
    }
  }

  // ③ 大小球跨源(竞彩 vs 国际多家)——真概率必须 0<p<1,0/null=缺失不当 0 编(遵 feedback_no_fabrication)
  const jo = num(inp.jcOver), io = num(inp.intlOver);
  const ouValid = jo != null && jo > 0 && jo < 1 && io != null && io > 0 && io < 1;
  if (ouValid) {
    const g = io - jo;
    if (Math.abs(g) >= 0.04) {
      signals.push({ type: "大小球跨源", dir: g > 0 ? "sharp更看大球" : "sharp更看小球",
        read: `竞彩大球 ${(jo * 100).toFixed(0)}% vs ${inp.intlBooks || "国际"}家 ${(io * 100).toFixed(0)}% → sharp 更看${g > 0 ? "大" : "小"}球、竞彩偏${g > 0 ? "小" : "大"}` });
    } else {
      signals.push({ type: "大小球跨源", dir: "一致", read: `竞彩大球 ${(jo * 100).toFixed(0)}% 与国际 ${(io * 100).toFixed(0)}% 一致` });
    }
  }

  // 数据强度(看有几路真实跨源对照)
  const crossN = (ahValid ? 1 : 0) + (ouValid ? 1 : 0);
  const dataStrength = crossN >= 2 ? "强(亚盘+大小球双跨源 sharp 对照)"
    : crossN === 1 ? "中(单路跨源 sharp 对照)"
    : (signals.length ? "弱(仅竞彩自身初→即时移动·无 sharp 对照)" : "无(仅单时点快照·1X2无sharp·收盘未采)");

  const diverged = signals.filter((s) => s.dir !== "一致");
  const intent = diverged.length
    ? diverged.map((s) => `${s.type}:${s.dir}`).join(" ｜ ")
    : "竞彩与可得 sharp 盘基本一致 → 此场庄家定价无明显偏离(公众/价值倾向不显)";

  return {
    signals, intent, publicSide, valueHint, dataStrength,
    caveat: "sharp盘(DraftKings/国际)更接近真实概率但≠收盘线;意图研判只揭示盘口倾向与相对价值方向,公开盘仍打不过收盘线、不保证盈利、只标注供判断。",
  };
}
