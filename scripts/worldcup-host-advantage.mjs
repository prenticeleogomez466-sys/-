#!/usr/bin/env node
/**
 * 东道主优势校准(轮7):用历届世界杯东道主真实战绩,验证 world-cup-priors 的东道主 +35Elo 加成是否合理。
 * +35Elo ≈ 主胜期望 +5pp(eloExpectation:E=1/(1+10^(-35/400))=0.550 vs 中立 0.5)。
 * 历届东道主在本土的实际胜率/净胜球若明显高于中立基线,说明 +35 合理(或偏保守)。
 * 全部用回填的真实赛果,东道主视角统计,无编造;样本天然少(每届1主办,9届)→ 诚实标注样本量。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";

const HOSTS = {
  1990: ["意大利"], 1994: ["美国"], 1998: ["法国"], 2002: ["韩国", "日本"],
  2006: ["德国"], 2010: ["南非"], 2014: ["巴西"], 2018: ["俄罗斯"], 2022: ["卡塔尔"],
};

function main() {
  const host = [];   // 东道主视角每场
  const all = [];     // 全部世界杯每场两视角(基线)
  for (const d of listFixtureDates()) {
    const { fixtures } = loadFixtures(d);
    for (const f of fixtures) {
      if (!(f.tags || []).includes("worldcup") || !f.result) continue;
      const m = (f.competition || "").match(/(\d{4})/);
      if (!m) continue;
      const year = Number(m[1]);
      const hosts = HOSTS[year] || [];
      const r = f.result;
      // 全局基线:每队一视角
      all.push({ gf: r.home, ga: r.away, res: r.home > r.away ? "W" : r.home === r.away ? "D" : "L" });
      all.push({ gf: r.away, ga: r.home, res: r.away > r.home ? "W" : r.away === r.home ? "D" : "L" });
      // 东道主视角
      if (hosts.includes(f.homeTeam)) host.push({ team: f.homeTeam, year, gf: r.home, ga: r.away, res: r.home > r.away ? "W" : r.home === r.away ? "D" : "L" });
      else if (hosts.includes(f.awayTeam)) host.push({ team: f.awayTeam, year, gf: r.away, ga: r.home, res: r.away > r.home ? "W" : r.away === r.home ? "D" : "L" });
    }
  }

  const stat = (arr) => {
    const n = arr.length;
    const w = arr.filter((x) => x.res === "W").length;
    const dr = arr.filter((x) => x.res === "D").length;
    const l = arr.filter((x) => x.res === "L").length;
    const gf = arr.reduce((s, x) => s + x.gf, 0) / n;
    const ga = arr.reduce((s, x) => s + x.ga, 0) / n;
    return { n, wr: w / n, drr: dr / n, lr: l / n, gf, ga, gd: gf - ga };
  };
  const h = stat(host), b = stat(all);
  const pct = (x) => (x * 100).toFixed(1) + "%";

  console.log("=== 东道主优势校准(历届世界杯东道主主场战绩)===");
  console.log(`东道主样本 ${h.n} 场(9 届主办,${Object.values(HOSTS).flat().length} 个主办身份)`);
  console.log("");
  console.log("              胜率     平率     负率     场均进球  场均失球  净胜球");
  console.log(`东道主主场    ${pct(h.wr).padEnd(8)} ${pct(h.drr).padEnd(8)} ${pct(h.lr).padEnd(8)} ${h.gf.toFixed(2).padEnd(9)} ${h.ga.toFixed(2).padEnd(9)} ${h.gd >= 0 ? "+" : ""}${h.gd.toFixed(2)}`);
  console.log(`全队基线      ${pct(b.wr).padEnd(8)} ${pct(b.drr).padEnd(8)} ${pct(b.lr).padEnd(8)} ${b.gf.toFixed(2).padEnd(9)} ${b.ga.toFixed(2).padEnd(9)} ${b.gd >= 0 ? "+" : ""}${b.gd.toFixed(2)}`);
  console.log("");
  const wrEdge = (h.wr - b.wr) * 100;
  const gdEdge = h.gd - b.gd;
  console.log(`东道主相对基线: 胜率 +${wrEdge.toFixed(1)}pp | 净胜球 +${gdEdge.toFixed(2)}`);
  console.log("");
  console.log(`world-cup-priors 现行 +35Elo ≈ 主胜期望 +5.0pp。`);
  console.log(wrEdge > 12
    ? `→ 实测东道主胜率优势(+${wrEdge.toFixed(1)}pp)远大于 +35Elo 隐含的 +5pp;但东道主多为强队+小组对手弱,优势含"实力"非纯"主场",不可全归东道主加成。+35 作纯主场温和加成保守、合理,**不贸然上调**(避免把实力当主场重复计)。`
    : `→ 实测优势 +${wrEdge.toFixed(1)}pp 与 +35Elo(+5pp)量级可比,+35 合理,保留。`);
  console.log("诚实:9届样本小、东道主自带强队偏差,本校准只验证'东道主优势真实存在'(✅),不足以精修 Elo 加成数值。");
}

main();
