#!/usr/bin/env node
/**
 * 核实 judge① 翻案主张:无盘口场"纯模型对决"——state-space(动态,先预测后更新自带leak-safe)
 * vs Dixon-Coles(按季 leak-safe 拟合)。不与市场比(那是 state-space 自带回测的错对照)。
 * 若 state-space 在命中率/RPS/Brier 显著优于 DC → judge① 成立,state-space 在无盘口冷门场该接;否则维持 skip。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { runStateSpaceRatings } from "../src/state-space-ratings.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const LEAGUES = ["E0", "SP1", "D1", "I1", "F1"];
const SEASONS = ["2526", "2425", "2324", "2223", "2122"];
const TEST = new Set(["2425", "2526"]);
const OUT = ["home", "draw", "away"];
function seasonOf(d) { const [y, m] = d.split("-").map(Number); const s = m >= 7 ? y : y - 1; return String(s % 100).padStart(2, "0") + String((s + 1) % 100).padStart(2, "0"); }
function resultOf(h, a) { return h > a ? "home" : h === a ? "draw" : "away"; }
function brier(p, y) { return OUT.reduce((s, o) => s + ((p[o] || 0) - (o === y ? 1 : 0)) ** 2, 0); }
function rps(p, y) { const o = ["home", "draw", "away"]; const yi = o.indexOf(y); let cP = 0, cY = 0, s = 0; for (let i = 0; i < 3; i++) { cP += p[o[i]] || 0; cY += i === yi ? 1 : 0; s += (cP - cY) ** 2; } return s / 2; }
function accum(a, p, y) { a.n++; a.hit += (OUT.reduce((b, o) => ((p[o] || 0) > (p[b] || 0) ? o : b), "home") === y) ? 1 : 0; a.brier += brier(p, y); a.rps += rps(p, y); }

async function main() {
  const res = await loadFootballDataMatches({ leagues: LEAGUES, seasons: SEASONS });
  if (!res.ok) { console.error("无数据"); process.exit(1); }
  const matches = res.matches;
  console.log("matches[0]字段:", Object.keys(matches[0]).join(","));
  const gOf = (m) => ({ hg: m.homeGoals ?? m.fthg ?? m.home, ag: m.awayGoals ?? m.ftag ?? m.away });
  const { predictions } = runStateSpaceRatings(matches, { lr: 0.06, decayToMean: 0.0008 });

  // DC 按测试季 leak-safe 拟合(训练=严格早于该季的所有场)
  const dcCache = {};
  function dcFor(season) {
    if (dcCache[season]) return dcCache[season];
    const train = matches.filter((m) => seasonOf(m.date) < season).map((m) => { const g = gOf(m); return { home: m.home, away: m.away, homeGoals: g.hg, awayGoals: g.ag, date: m.date }; });
    dcCache[season] = fitFromMatches(train, {});
    return dcCache[season];
  }

  const arms = { "state-space动态": { n: 0, hit: 0, brier: 0, rps: 0 }, "DC(按季leak-safe)": { n: 0, hit: 0, brier: 0, rps: 0 } };
  let paired = 0;
  for (const p of predictions) {
    if (!p.warmed || !TEST.has(seasonOf(p.date))) continue;
    const y = resultOf(p.actual.home, p.actual.away);
    const fit = dcFor(seasonOf(p.date));
    const dc = fit?.usable ? predictFromFitted(fit, { homeTeam: p.home, awayTeam: p.away }) : null;
    if (!dc || !dc.probabilities) continue; // 只在两模型都能预测的同一批场对比(apples-to-apples)
    paired++;
    accum(arms["state-space动态"], p.probs, y);
    accum(arms["DC(按季leak-safe)"], dc.probabilities, y);
  }

  console.log(`\n配对评估场次(两模型都出预测,warmed+测试季)=${paired}\n`);
  console.log("臂                   样本   命中率   Brier    RPS");
  for (const [name, a] of Object.entries(arms)) {
    if (!a.n) continue;
    console.log(`${name.padEnd(20)} ${String(a.n).padEnd(6)} ${((a.hit / a.n) * 100).toFixed(1).padStart(5)}%   ${(a.brier / a.n).toFixed(4)}   ${(a.rps / a.n).toFixed(4)}`);
  }
  const S = arms["state-space动态"], D = arms["DC(按季leak-safe)"];
  const dHit = (S.hit / S.n - D.hit / D.n) * 100, dRps = S.rps / S.n - D.rps / D.n, dBrier = S.brier / S.n - D.brier / D.n;
  console.log(`\nstate-space vs DC: 命中 ${dHit >= 0 ? "+" : ""}${dHit.toFixed(1)}pp | RPS ${dRps >= 0 ? "+" : ""}${dRps.toFixed(4)}(负=ss更准) | Brier ${dBrier >= 0 ? "+" : ""}${dBrier.toFixed(4)}`);
  console.log(`judge①主张: 命中+3.6pp / RPS-0.0077 / Brier-0.0164。`);
  console.log(dRps < -0.002 && dHit > 1.5
    ? "✅ 复现judge①:state-space在纯模型对决显著优于DC→无盘口冷门场值得接(回测证净增益)"
    : "❌ 未复现judge①的幅度:state-space对DC无显著净增益→维持skip(judge①数字夸大)");
}
main().catch((e) => { console.error(e); process.exit(1); });
