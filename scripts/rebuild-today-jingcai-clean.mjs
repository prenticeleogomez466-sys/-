import { saveFixtures } from "../src/fixture-store.js";
import { saveMarketSnapshots } from "../src/market-data-store.js";
import { recommendFixtures } from "../src/prediction-engine.js";
const DATE = process.argv[2] || "2026-06-02", KICK = "2026-06-03";
const now = new Date().toISOString();
// [num, 主, 客, 胜平负(主/平/客), 让球胜平负(主-1)(主/平/客)] —— 2026-06-02 修正:胜平负=不让球盘,让球=主队-1
const M = [
  ["2201","克罗地亚","比利时",[2.57,2.85,2.57],[5.50,4.48,1.38]],
  ["2202","格鲁吉亚","罗马尼亚",[2.07,3.02,3.17],[4.66,3.65,1.56]],
  ["2203","威尔士","加纳",[2.09,2.86,3.32],[4.65,3.71,1.55]],
];
const od = (a) => ({ home:a[0], draw:a[1], away:a[2] });
const fixtures = M.map(([n,h,a]) => ({ id:`jc-${DATE}-${n}-${h}-${a}`, sequence:n, date:DATE, homeTeam:h, awayTeam:a, competition:"国际赛", marketType:"jingcai", kickoff:`${KICK}T02:45:00+08:00` }));
const snaps = M.map(([n,h,a,spf,rang]) => ({ id:`jc-${DATE}-${n}`, date:DATE, fixtureId:`jc-${DATE}-${n}-${h}-${a}`, sequence:n, marketType:"jingcai", competition:"国际赛", homeTeam:h, awayTeam:a, collectedAt:now, source:"trade.500.com/jczq XML (Playwright, 胜平负/让球已校正)", europeanOdds:{ initial:od(spf), current:od(spf), final:od(spf) }, handicapOdds:{ initial:od(rang), current:od(rang), final:od(rang) }, jingcaiHandicap:{ line:-1 } }));
saveFixtures(DATE, fixtures, { source:"trade.500.com-jczq-corrected" });
saveMarketSnapshots(DATE, snaps, { source:"trade.500.com-jczq-corrected" });
const r = recommendFixtures(DATE);
const dv = (o) => { const i=1/o.home+1/o.draw+1/o.away; return {h:100/o.home/i,d:100/o.draw/i,a:100/o.away/i}; };
console.log(`重建 ${fixtures.length} 场(胜平负已校正)`);
for (const p of r.predictions) {
  const f=p.fixture, pr=p.probabilities, sc=p.scorePicks, hf=p.halfFullPicks, m=M.find(x=>x[1]===f.homeTeam), mk=dv(od(m[3]));
  console.log(`\n【${f.homeTeam} vs ${f.awayTeam}】胜平负 ${m[3].join("/")} 市场主${mk.h.toFixed(0)}/平${mk.d.toFixed(0)}/客${mk.a.toFixed(0)}`);
  console.log(`  胜平负方向: ${p.pick?.label} 主${(pr.home*100).toFixed(0)}/平${(pr.draw*100).toFixed(0)}/客${(pr.away*100).toFixed(0)} [${p.provenance}]`);
  console.log(`  让球(主-1) ${m[4].join("/")} → 让球方向: ${p.jingcaiLetqiu?.pick?.label||"-"}`);
  console.log(`  比分: ${sc?.primary}(${sc?.primaryProbability?(sc.primaryProbability*100).toFixed(1)+"%":"-"}) ${sc?.confidenceTier?.label||""} | 半全场: ${hf?.primary}(${hf?.primaryProbability?(hf.primaryProbability*100).toFixed(1)+"%":"-"}) ${hf?.confidenceTier?.label||""}`);
}
