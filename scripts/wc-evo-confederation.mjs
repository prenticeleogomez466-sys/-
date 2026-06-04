#!/usr/bin/env node
/**
 * LEAK-SAFE backtest: does a CONFEDERATION-BIAS correction to Elo improve OOS
 * prediction of INTER-confederation international matches?
 *
 * Hypothesis (Lasek et al.): pure Elo over-rates UEFA / under-rates CONMEBOL in
 * inter-confed games because Elo is mostly fed by intra-confed matches.
 *
 * Method:
 *  - Walk-forward Elo (K=40 flat, start 1500, burn-in 128) over ALL intl matches,
 *    date order, neutral-aware home advantage. Predictions use only past data.
 *  - Snapshot the Elo diff at prediction time for every inter-confed match.
 *  - Time-split the inter-confed matches: first 60% TRAIN, last 40% TEST.
 *  - On TRAIN, grid-search per-confed additive deltas minimizing 3-class Brier
 *    (CONMEBOL pinned to 0 as reference). Apply (delta_home - delta_away) to the
 *    Elo diff before mapping to We. Draw model from a fitted Elo-diff -> P(draw).
 *  - Evaluate strictly OOS on TEST: 3-class Brier + WLD hit (argmax), all + competitive.
 *
 * Does NOT modify src/. Self-contained.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(__dirname, "..", "data", "intl-results", "results.csv");

// ---- Confederation map (country the team represents) ----
// Focused on teams that actually appear in inter-confederation matches.
const CONFED = {
  // UEFA
  "Albania":"UEFA","Austria":"UEFA","Belgium":"UEFA","Bosnia and Herzegovina":"UEFA","Bulgaria":"UEFA",
  "Croatia":"UEFA","Czech Republic":"UEFA","Czechoslovakia":"UEFA","Denmark":"UEFA","England":"UEFA",
  "France":"UEFA","Germany":"UEFA","West Germany":"UEFA","East Germany":"UEFA","Greece":"UEFA","Hungary":"UEFA",
  "Iceland":"UEFA","Republic of Ireland":"UEFA","Northern Ireland":"UEFA","Italy":"UEFA","Netherlands":"UEFA",
  "Norway":"UEFA","Poland":"UEFA","Portugal":"UEFA","Romania":"UEFA","Russia":"UEFA","Soviet Union":"UEFA",
  "Scotland":"UEFA","Serbia":"UEFA","Yugoslavia":"UEFA","Serbia and Montenegro":"UEFA","Slovakia":"UEFA",
  "Slovenia":"UEFA","Spain":"UEFA","Sweden":"UEFA","Switzerland":"UEFA","Turkey":"UEFA","Ukraine":"UEFA",
  "Wales":"UEFA","Finland":"UEFA","Montenegro":"UEFA","North Macedonia":"UEFA","Macedonia":"UEFA",
  "Georgia":"UEFA","Armenia":"UEFA","Azerbaijan":"UEFA","Belarus":"UEFA","Estonia":"UEFA","Latvia":"UEFA",
  "Lithuania":"UEFA","Luxembourg":"UEFA","Malta":"UEFA","Cyprus":"UEFA","Israel":"UEFA","Moldova":"UEFA",
  "Kazakhstan":"UEFA","Liechtenstein":"UEFA","Andorra":"UEFA","San Marino":"UEFA","Faroe Islands":"UEFA",
  "Gibraltar":"UEFA","Kosovo":"UEFA",
  // CONMEBOL
  "Argentina":"CONMEBOL","Bolivia":"CONMEBOL","Brazil":"CONMEBOL","Chile":"CONMEBOL","Colombia":"CONMEBOL",
  "Ecuador":"CONMEBOL","Paraguay":"CONMEBOL","Peru":"CONMEBOL","Uruguay":"CONMEBOL","Venezuela":"CONMEBOL",
  // CONCACAF
  "United States":"CONCACAF","Mexico":"CONCACAF","Canada":"CONCACAF","Costa Rica":"CONCACAF",
  "Honduras":"CONCACAF","Panama":"CONCACAF","Jamaica":"CONCACAF","El Salvador":"CONCACAF",
  "Guatemala":"CONCACAF","Trinidad and Tobago":"CONCACAF","Haiti":"CONCACAF","Cuba":"CONCACAF",
  "Nicaragua":"CONCACAF","Curaçao":"CONCACAF","Suriname":"CONCACAF","Guadeloupe":"CONCACAF",
  "Martinique":"CONCACAF","Dominican Republic":"CONCACAF","Bermuda":"CONCACAF",
  // CAF
  "Algeria":"CAF","Angola":"CAF","Burkina Faso":"CAF","Cameroon":"CAF","Cape Verde":"CAF","DR Congo":"CAF",
  "Congo DR":"CAF","Congo":"CAF","Ivory Coast":"CAF","Egypt":"CAF","Equatorial Guinea":"CAF","Gabon":"CAF",
  "Ghana":"CAF","Guinea":"CAF","Kenya":"CAF","Mali":"CAF","Morocco":"CAF","Mozambique":"CAF","Nigeria":"CAF",
  "Senegal":"CAF","South Africa":"CAF","Sudan":"CAF","Togo":"CAF","Tunisia":"CAF","Uganda":"CAF",
  "Zambia":"CAF","Zimbabwe":"CAF","Benin":"CAF","Guinea-Bissau":"CAF","Madagascar":"CAF","Mauritania":"CAF",
  "Namibia":"CAF","Tanzania":"CAF","Ethiopia":"CAF","Libya":"CAF","Malawi":"CAF","Niger":"CAF","Gambia":"CAF",
  "Comoros":"CAF","Sierra Leone":"CAF","Liberia":"CAF","Rwanda":"CAF","Burundi":"CAF","Chad":"CAF",
  "Central African Republic":"CAF","Botswana":"CAF","Lesotho":"CAF","Eswatini":"CAF","Swaziland":"CAF",
  // AFC
  "Japan":"AFC","South Korea":"AFC","Korea Republic":"AFC","North Korea":"AFC","Iran":"AFC","Saudi Arabia":"AFC",
  "Australia":"AFC","Qatar":"AFC","Iraq":"AFC","United Arab Emirates":"AFC","China PR":"AFC","China":"AFC",
  "Uzbekistan":"AFC","Bahrain":"AFC","Jordan":"AFC","Kuwait":"AFC","Oman":"AFC","Syria":"AFC","Lebanon":"AFC",
  "Thailand":"AFC","Vietnam":"AFC","Indonesia":"AFC","Malaysia":"AFC","Singapore":"AFC","India":"AFC",
  "Philippines":"AFC","Myanmar":"AFC","Hong Kong":"AFC","Tajikistan":"AFC","Turkmenistan":"AFC",
  "Kyrgyzstan":"AFC","Palestine":"AFC","Yemen":"AFC","Afghanistan":"AFC","Bangladesh":"AFC","Maldives":"AFC",
  "Nepal":"AFC","Sri Lanka":"AFC","Cambodia":"AFC","Laos":"AFC","Bhutan":"AFC","Guam":"AFC","Macau":"AFC",
  "Chinese Taipei":"AFC","Pakistan":"AFC","Mongolia":"AFC","Brunei":"AFC","Timor-Leste":"AFC",
  // OFC
  "New Zealand":"OFC","Fiji":"OFC","Papua New Guinea":"OFC","New Caledonia":"OFC","Tahiti":"OFC",
  "Solomon Islands":"OFC","Vanuatu":"OFC","Samoa":"OFC","Tonga":"OFC","Cook Islands":"OFC","American Samoa":"OFC",
};
const confOf = (t) => CONFED[t] || "UNK";

function parseCSV(path) {
  const txt = fs.readFileSync(path, "utf8");
  const lines = txt.split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const c = ln.split(",");
    if (c.length < 9) continue;
    rows.push({
      date: c[0], home: c[1], away: c[2],
      hg: +c[3], ag: +c[4], tournament: c[5],
      neutral: c[8] === "TRUE",
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

const SCALE = 400, K = 40, BURNIN = 128, HOME_ADV = 60; // home adv only when not neutral
const we = (diff) => 1 / (Math.pow(10, -diff / SCALE) + 1);

function main() {
  const rows = parseCSV(CSV);
  const elo = {};
  const getElo = (t) => (elo[t] ?? 1500);

  // Walk-forward Elo; snapshot diff for inter-confed matches (post burn-in).
  const inter = []; // {date, eloDiff(home-away incl home adv), result(H/D/A), comp, ch, ca}
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const eh = getElo(m.home), ea = getElo(m.away);
    const adv = m.neutral ? 0 : HOME_ADV;
    const diff = (eh + adv) - ea;
    const p = we(diff);
    if (i >= BURNIN && Number.isFinite(m.hg) && Number.isFinite(m.ag)) {
      const ch = confOf(m.home), ca = confOf(m.away);
      if (ch !== "UNK" && ca !== "UNK" && ch !== ca) {
        const res = m.hg > m.ag ? "H" : m.hg === m.ag ? "D" : "A";
        inter.push({
          date: m.date, eloDiff: diff, res,
          comp: m.tournament !== "Friendly",
          ch, ca,
        });
      }
    }
    // update (actual / We on raw, home-adv-aware diff so ratings stay consistent)
    if (Number.isFinite(m.hg) && Number.isFinite(m.ag)) {
      const sH = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
      elo[m.home] = eh + K * (sH - p);
      elo[m.away] = ea + K * ((1 - sH) - (1 - p));
    }
  }

  console.log(`Inter-confed matches (post burn-in, both confed known): ${inter.length}`);
  // per-confed appearance counts (how many inter-confed matches each confed is in)
  const cnt = {};
  for (const m of inter) { cnt[m.ch] = (cnt[m.ch]||0)+1; cnt[m.ca] = (cnt[m.ca]||0)+1; }
  console.log("Confed appearances in inter-confed set:", JSON.stringify(cnt));

  // Time split
  const split = Math.floor(inter.length * 0.6);
  const train = inter.slice(0, split);
  const test = inter.slice(split);
  console.log(`TRAIN ${train.length}  TEST ${test.length}  (split date ~ ${test[0]?.date})`);

  // Fit P(draw) as a function of |adjDiff| on TRAIN (logistic-ish via binned base rate);
  // simpler & robust: a single draw-rate parameter modulated by |diff|.
  // We model 3-class probs from We and a draw component:
  //   pD = dBase * exp(-|adjDiff|/dScale); pH = (1-pD)*We; pA = (1-pD)*(1-We)
  // Fit dBase,dScale on TRAIN by grid minimizing Brier (baseline deltas=0), reuse for both.
  function brierFor(set, deltas, dBase, dScale) {
    let sum = 0;
    for (const m of set) {
      const adj = m.eloDiff + ((deltas[m.ch] || 0) - (deltas[m.ca] || 0));
      const w = we(adj);
      const pD = dBase * Math.exp(-Math.abs(adj) / dScale);
      const pH = (1 - pD) * w, pA = (1 - pD) * (1 - w);
      const tH = m.res === "H" ? 1 : 0, tD = m.res === "D" ? 1 : 0, tA = m.res === "A" ? 1 : 0;
      sum += (pH - tH) ** 2 + (pD - tD) ** 2 + (pA - tA) ** 2;
    }
    return sum / set.length;
  }
  function hitFor(set, deltas) {
    let hit = 0;
    for (const m of set) {
      const adj = m.eloDiff + ((deltas[m.ch] || 0) - (deltas[m.ca] || 0));
      const w = we(adj);
      const pD = 0; // argmax over H/D/A; include draw via pD model below
      // use fitted draw for argmax fairness:
      const _pD = DBASE * Math.exp(-Math.abs(adj) / DSCALE);
      const pH = (1 - _pD) * w, pA = (1 - _pD) * (1 - w);
      const arr = [["H", pH], ["D", _pD], ["A", pA]].sort((a, b) => b[1] - a[1]);
      if (arr[0][0] === m.res) hit++;
    }
    return hit / set.length;
  }

  // Fit draw params on TRAIN (baseline, deltas=0)
  let DBASE = 0.27, DSCALE = 600, bestDB = 1e9;
  for (const db of [0.18,0.20,0.22,0.24,0.26,0.28,0.30,0.32]) {
    for (const ds of [300,400,500,600,800,1000,1500]) {
      const b = brierFor(train, {}, db, ds);
      if (b < bestDB) { bestDB = b; DBASE = db; DSCALE = ds; }
    }
  }
  console.log(`Fitted draw model on TRAIN: dBase=${DBASE} dScale=${DSCALE} (train Brier baseline ${bestDB.toFixed(4)})`);

  // Grid-search per-confed deltas on TRAIN. CONMEBOL pinned to 0 (reference).
  const CANDS = [-80, -60, -40, -20, 0, 20, 40, 60, 80];
  const confeds = ["UEFA", "CONCACAF", "CAF", "AFC", "OFC"]; // CONMEBOL fixed 0
  let best = { deltas: {}, brier: brierFor(train, {}, DBASE, DSCALE) };
  // Coordinate-descent over the grid (full 5^5 = 3125 is fine too — do full).
  const idx = [0,0,0,0,0];
  const total = Math.pow(CANDS.length, confeds.length);
  for (let n = 0; n < total; n++) {
    let x = n;
    const deltas = { CONMEBOL: 0 };
    for (let j = 0; j < confeds.length; j++) { deltas[confeds[j]] = CANDS[x % CANDS.length]; x = Math.floor(x / CANDS.length); }
    const b = brierFor(train, deltas, DBASE, DSCALE);
    if (b < best.brier) best = { deltas: { ...deltas }, brier: b };
  }
  console.log("\nDerived per-confed deltas (Elo points, +=Elo under-rates so boost; CONMEBOL=0 ref):");
  for (const c of ["CONMEBOL", ...confeds]) console.log(`  ${c.padEnd(9)} ${best.deltas[c] >= 0 ? "+" : ""}${best.deltas[c]}`);
  console.log(`  (TRAIN Brier: baseline ${brierFor(train, {}, DBASE, DSCALE).toFixed(4)} -> adjusted ${best.brier.toFixed(4)})`);

  // OOS evaluation
  function report(label, set) {
    if (!set.length) { console.log(`${label}: (empty)`); return; }
    const bBase = brierFor(set, {}, DBASE, DSCALE);
    const bAdj = brierFor(set, best.deltas, DBASE, DSCALE);
    const hBase = hitFor(set, {});
    const hAdj = hitFor(set, best.deltas);
    console.log(`\n${label} (n=${set.length})`);
    console.log(`  Brier  baseline ${bBase.toFixed(4)}  adjusted ${bAdj.toFixed(4)}  Δ ${((bBase - bAdj) >= 0 ? "-" : "+")}${Math.abs(bBase - bAdj).toFixed(4)} ${bAdj < bBase ? "(better)" : "(worse)"}`);
    console.log(`  WLDhit baseline ${(hBase*100).toFixed(2)}%  adjusted ${(hAdj*100).toFixed(2)}%  Δ ${((hAdj - hBase)*100 >= 0 ? "+" : "")}${((hAdj - hBase)*100).toFixed(2)}pp`);
    return { bBase, bAdj, hBase, hAdj };
  }

  console.log("\n========== OUT-OF-SAMPLE (held-out last 40%) ==========");
  const all = report("TEST all inter-confed", test);
  const comp = report("TEST competitive only", test.filter(m => m.comp));

  // Verdict
  const dB = all.bBase - all.bAdj;       // positive = improvement
  const dH = (all.hAdj - all.hBase) * 100;
  const dBc = comp.bBase - comp.bAdj;
  const dHc = (comp.hAdj - comp.hBase) * 100;
  const pass = (dB > 0.002 || dH > 1.0) || (dBc > 0.002 || dHc > 1.0);
  console.log("\n========== VERDICT ==========");
  console.log(`all:  ΔBrier ${dB>=0?"+":""}${dB.toFixed(4)} (need >0.002)  ΔWLD ${dH>=0?"+":""}${dH.toFixed(2)}pp (need >1.0)`);
  console.log(`comp: ΔBrier ${dBc>=0?"+":""}${dBc.toFixed(4)}  ΔWLD ${dHc>=0?"+":""}${dHc.toFixed(2)}pp`);
  console.log(pass ? "RESULT: gate passed on a metric — review deltas for direction." : "RESULT: SKIP — no metric clears threshold OOS.");

  // ---- Robustness: constrain grid to ±40 (literature-plausible) and re-eval OOS ----
  console.log("\n========== ROBUSTNESS: constrained deltas ∈ {-40..+40} ==========");
  const C2 = [-40,-20,0,20,40];
  let best2 = { deltas:{}, brier: brierFor(train, {}, DBASE, DSCALE) };
  const tot2 = Math.pow(C2.length, confeds.length);
  for (let n=0;n<tot2;n++){ let x=n; const d={CONMEBOL:0};
    for (let j=0;j<confeds.length;j++){ d[confeds[j]]=C2[x%C2.length]; x=Math.floor(x/C2.length); }
    const b=brierFor(train,d,DBASE,DSCALE); if(b<best2.brier) best2={deltas:{...d},brier:b}; }
  console.log("Constrained deltas:", JSON.stringify(best2.deltas));
  const b2Base = brierFor(test,{},DBASE,DSCALE), b2Adj = brierFor(test,best2.deltas,DBASE,DSCALE);
  const h2Base = hitFor(test,{}), h2Adj = hitFor(test,best2.deltas);
  console.log(`TEST all: ΔBrier ${(b2Base-b2Adj>=0?"+":"")}${(b2Base-b2Adj).toFixed(4)}  ΔWLD ${((h2Adj-h2Base)*100>=0?"+":"")}${((h2Adj-h2Base)*100).toFixed(2)}pp`);
}

main();
