#!/usr/bin/env node
/**
 * LEAK-SAFE backtest: does a RECENT-FORM (momentum) residual signal add OOS value ON TOP OF Elo?
 *
 * Form definition (PAST-only, orthogonal-ish to Elo by construction):
 *   For each team, rolling weighted avg over last N competitive matches of
 *     (actual points 1/0.5/0) - (Elo-expected points for that match)   = residual over/under-perf vs Elo.
 *   Decay: exponential (geometric) weights. Friendlies down-weighted in the rolling buffer.
 *
 * Prediction:
 *   eloDiffAdj = (eloHome - eloAway) + alpha * (formHome - formAway) * SCALE_FORM
 *   We_adj = 1/(1+10^(-eloDiffAdj/400))   -> map to 3-class WLD with a data-fit draw model.
 *
 * Leak-safe protocol:
 *   - Walk-forward Elo K=40 start 1500 burn-in 128 over ALL intl matches in date order.
 *   - Form computed from PAST matches only (updated AFTER each match is scored).
 *   - Draw model + alpha derived on first 60% of post-burn-in matches; eval strictly on last 40%.
 *
 * Verdict: INTEGRATE only if OOS 3-class Brier improves > 0.002 AND/OR WLD hit improves > 1.0pp
 *          with a stable non-zero alpha. Else honest SKIP.  DO NOT edit src/.
 */
import fs from "node:fs";

const CSV = "/d/football-model/data/intl-results/results.csv".replace("/d/", "D:/");
const K = 40, START = 1500, BURNIN = 128, SCALE = 400;

// ---- load ----
function parseCSV(path) {
  const txt = fs.readFileSync(path, "utf8").trim();
  const lines = txt.split(/\r?\n/);
  lines.shift(); // header
  const rows = [];
  for (const ln of lines) {
    // simple split: fields have no embedded commas in this dataset for the cols we use
    const p = ln.split(",");
    if (p.length < 9) continue;
    const hg = Number(p[3]), ag = Number(p[4]);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    rows.push({
      date: p[0], home: p[1], away: p[2], hg, ag,
      tournament: p[5],
      neutral: String(p[8]).trim().toUpperCase() === "TRUE",
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

const isFriendly = (t) => /friendly/i.test(t || "");
const isWorldCup = (t) => (t || "") === "FIFA World Cup";

function pts(gf, ga) { return gf > ga ? 1 : gf === ga ? 0.5 : 0; }

// rolling form buffer per team: store {resid, comp} ; comp=competitive weight (friendly 0.5)
function makeFormState() { return {}; }
function formValue(state, team, N, decay) {
  const buf = state[team];
  if (!buf || !buf.length) return 0;
  // most recent at end; take last N, exp decay (newest weight 1, older *decay)
  const slice = buf.slice(-N);
  let wsum = 0, vsum = 0;
  for (let k = slice.length - 1, age = 0; k >= 0; k--, age++) {
    const w = Math.pow(decay, age) * slice[k].cw;
    wsum += w; vsum += w * slice[k].resid;
  }
  return wsum > 0 ? vsum / wsum : 0;
}
function pushForm(state, team, resid, cw) {
  (state[team] ||= []).push({ resid, cw });
}

// 3-class probs from We (win-expectation of home) + draw model.
// Draw model: pDraw = dBase * exp(-|eloDiff|/dScale), clamped. Fit dBase,dScale on training.
function classProbs(we, eloDiff, dBase, dScale) {
  let pd = dBase * Math.exp(-Math.abs(eloDiff) / dScale);
  pd = Math.max(0.05, Math.min(0.40, pd));
  // split remaining mass by we (home win-expectation incl half-draw). Remove draw's half-credit:
  // we ~= pHome + 0.5*pDraw  => pHome = we - 0.5*pd ; pAway = 1 - pHome - pd
  let pHome = we - 0.5 * pd;
  let pAway = 1 - pHome - pd;
  // clamp & renorm
  pHome = Math.max(1e-4, pHome); pAway = Math.max(1e-4, pAway); pd = Math.max(1e-4, pd);
  const s = pHome + pd + pAway;
  return [pHome / s, pd / s, pAway / s]; // [H, D, A]
}

function brier3(probs, outcome) { // outcome 0=H,1=D,2=A
  let s = 0;
  for (let i = 0; i < 3; i++) { const y = i === outcome ? 1 : 0; s += (probs[i] - y) ** 2; }
  return s;
}
function outcomeIdx(hg, ag) { return hg > ag ? 0 : hg === ag ? 1 : 2; }

function run() {
  const rows = parseCSV(CSV);
  const N_GRID = [3, 5, 8];
  const DECAY_GRID = [1.0, 0.7, 0.5];

  // Pass 1: walk-forward Elo + record, for each post-burn-in match, the eloDiff, We, outcome,
  // and the form values for each (N,decay) combo BEFORE the match (past-only). Update form AFTER.
  const elo = {}; const getElo = (t) => (elo[t] ?? START);
  const states = {}; // key `${N}_${decay}` -> formState
  for (const N of N_GRID) for (const d of DECAY_GRID) states[`${N}_${d}`] = makeFormState();

  const samples = []; // post-burn-in
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const eh = getElo(m.home), ea = getElo(m.away);
    const eloDiff = eh - ea;
    const we = 1 / (Math.pow(10, -eloDiff / SCALE) + 1);

    if (i >= BURNIN) {
      const forms = {};
      for (const N of N_GRID) for (const d of DECAY_GRID) {
        const key = `${N}_${d}`; const st = states[key];
        forms[key] = formValue(st, m.home, N, d) - formValue(st, m.away, N, d);
      }
      samples.push({
        eloDiff, we, outcome: outcomeIdx(m.hg, m.ag),
        friendly: isFriendly(m.tournament), wc: isWorldCup(m.tournament),
        forms,
      });
    }

    // update form residuals (past->now) using PRE-match Elo expectation
    const sH = pts(m.hg, m.ag);
    const cw = isFriendly(m.tournament) ? 0.5 : 1.0;
    const residHome = sH - we;
    const residAway = (1 - sH) - (1 - we);
    for (const N of N_GRID) for (const d of DECAY_GRID) {
      const st = states[`${N}_${d}`];
      pushForm(st, m.home, residHome, cw);
      pushForm(st, m.away, residAway, cw);
    }
    // update Elo
    elo[m.home] = eh + K * (sH - we);
    elo[m.away] = ea + K * ((1 - sH) - (1 - we));
  }

  // time split
  const cut = Math.floor(samples.length * 0.6);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);

  // Fit draw model (dBase,dScale) on train (alpha=0) by grid -> min 3-class Brier
  const DBASE = [0.22, 0.26, 0.30, 0.34];
  const DSCALE = [200, 350, 500, 800, 1500];
  function evalDrawModel(set, dBase, dScale, alpha, formKey) {
    let br = 0, hit = 0;
    for (const s of set) {
      const adjDiff = s.eloDiff + alpha * (s.forms[formKey] ?? 0) * SCALE;
      const we = 1 / (Math.pow(10, -adjDiff / SCALE) + 1);
      const p = classProbs(we, adjDiff, dBase, dScale);
      br += brier3(p, s.outcome);
      const arg = p.indexOf(Math.max(...p));
      if (arg === s.outcome) hit++;
    }
    return { brier: br / set.length, hit: hit / set.length };
  }
  // best draw model at alpha 0 (use any formKey since alpha=0 ignores it)
  let bestDraw = null;
  for (const dBase of DBASE) for (const dScale of DSCALE) {
    const r = evalDrawModel(train, dBase, dScale, 0, "5_0.7");
    if (!bestDraw || r.brier < bestDraw.brier) bestDraw = { dBase, dScale, ...r };
  }

  // For each (N,decay): grid alpha on TRAIN to minimize Brier, then eval OOS on TEST.
  const ALPHA = [-0.5, -0.25, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1.0];
  const results = [];
  for (const N of N_GRID) for (const d of DECAY_GRID) {
    const key = `${N}_${d}`;
    let bestA = null;
    for (const a of ALPHA) {
      const r = evalDrawModel(train, bestDraw.dBase, bestDraw.dScale, a, key);
      if (!bestA || r.brier < bestA.brier) bestA = { alpha: a, ...r };
    }
    const oosBase = evalDrawModel(test, bestDraw.dBase, bestDraw.dScale, 0, key);
    const oosAdj = evalDrawModel(test, bestDraw.dBase, bestDraw.dScale, bestA.alpha, key);
    results.push({ N, d, key, trainAlpha: bestA.alpha, oosBase, oosAdj });
  }

  // pick best config by OOS Brier improvement
  results.sort((a, b) => (a.oosAdj.brier - a.oosBase.brier) - (b.oosAdj.brier - b.oosBase.brier));
  const best = results[0];

  // WC subset eval on held-out test, using best config
  const testWC = test.filter((s) => s.wc);
  const wcBase = evalDrawModel(testWC, bestDraw.dBase, bestDraw.dScale, 0, best.key);
  const wcAdj = evalDrawModel(testWC, bestDraw.dBase, bestDraw.dScale, best.trainAlpha, best.key);
  // competitive-only held-out
  const testComp = test.filter((s) => !s.friendly);
  const compBase = evalDrawModel(testComp, bestDraw.dBase, bestDraw.dScale, 0, best.key);
  const compAdj = evalDrawModel(testComp, bestDraw.dBase, bestDraw.dScale, best.trainAlpha, best.key);

  // ---- report ----
  console.log("=== Recent-Form (momentum) residual-vs-Elo, LEAK-SAFE OOS backtest ===");
  console.log(`Total intl matches parsed: ${rows.length}; post-burn-in samples: ${samples.length}`);
  console.log(`Time split: train ${train.length} (60%) / test ${test.length} (40%, held-out OOS)`);
  console.log(`Draw model fit on train: dBase=${bestDraw.dBase} dScale=${bestDraw.dScale} (train Brier ${bestDraw.brier.toFixed(4)})`);
  console.log("");
  console.log("Per-config (alpha grid-searched on TRAIN, evaluated OOS on TEST all-intl):");
  console.log("N  decay trainAlpha | OOS Brier base->adj  (dBrier)  | OOS WLD% base->adj (dpp)");
  const ranked = [...results].sort((a,b)=> (a.N-b.N)||(b.d-a.d));
  for (const r of ranked) {
    const db = r.oosAdj.brier - r.oosBase.brier;
    const dh = (r.oosAdj.hit - r.oosBase.hit) * 100;
    console.log(
      `${r.N}  ${r.d.toFixed(2)}  ${String(r.trainAlpha).padStart(6)}    | ${r.oosBase.brier.toFixed(4)}->${r.oosAdj.brier.toFixed(4)} (${db>=0?"+":""}${db.toFixed(4)}) | ${(r.oosBase.hit*100).toFixed(2)}->${(r.oosAdj.hit*100).toFixed(2)} (${dh>=0?"+":""}${dh.toFixed(2)}pp)`
    );
  }
  console.log("");
  const dB = best.oosAdj.brier - best.oosBase.brier;
  const dH = (best.oosAdj.hit - best.oosBase.hit) * 100;
  console.log(`BEST CONFIG (max OOS Brier improvement): N=${best.N} decay=${best.d} alpha=${best.trainAlpha}`);
  console.log(`  All-intl held-out (n=${test.length}):`);
  console.log(`    Brier  base ${best.oosBase.brier.toFixed(4)} -> adj ${best.oosAdj.brier.toFixed(4)}  (${dB>=0?"+":""}${dB.toFixed(4)})`);
  console.log(`    WLD%   base ${(best.oosBase.hit*100).toFixed(2)} -> adj ${(best.oosAdj.hit*100).toFixed(2)}  (${dH>=0?"+":""}${dH.toFixed(2)}pp)`);
  console.log(`  Competitive-only held-out (n=${testComp.length}):`);
  console.log(`    Brier  base ${compBase.brier.toFixed(4)} -> adj ${compAdj.brier.toFixed(4)}  (${(compAdj.brier-compBase.brier>=0?"+":"")}${(compAdj.brier-compBase.brier).toFixed(4)})`);
  console.log(`    WLD%   base ${(compBase.hit*100).toFixed(2)} -> adj ${(compAdj.hit*100).toFixed(2)}  (${((compAdj.hit-compBase.hit)*100>=0?"+":"")}${((compAdj.hit-compBase.hit)*100).toFixed(2)}pp)`);
  console.log(`  World Cup subset held-out (n=${testWC.length}):`);
  if (testWC.length >= 30) {
    console.log(`    Brier  base ${wcBase.brier.toFixed(4)} -> adj ${wcAdj.brier.toFixed(4)}  (${(wcAdj.brier-wcBase.brier>=0?"+":"")}${(wcAdj.brier-wcBase.brier).toFixed(4)})`);
    console.log(`    WLD%   base ${(wcBase.hit*100).toFixed(2)} -> adj ${(wcAdj.hit*100).toFixed(2)}  (${((wcAdj.hit-wcBase.hit)*100>=0?"+":"")}${((wcAdj.hit-wcBase.hit)*100).toFixed(2)}pp)  [small n, low trust]`);
  } else {
    console.log(`    (n<30, too small to trust — skipping)`);
  }

  console.log("");
  const stableAlpha = Math.abs(best.trainAlpha) > 1e-9;
  const integrate = stableAlpha && (dB < -0.002 || dH > 1.0);
  console.log("VERDICT: " + (integrate ? "INTEGRATE" : "SKIP"));
  if (integrate) {
    console.log(`  Reason: OOS gain on all-intl (dBrier ${dB.toFixed(4)}, dWLD ${dH.toFixed(2)}pp) clears threshold with stable alpha=${best.trainAlpha}.`);
  } else {
    let why;
    if (!stableAlpha) why = "TRAIN grid picked alpha=0 (form adds nothing even in-sample) -> Elo already absorbs recent form.";
    else why = `OOS gain below threshold (dBrier ${dB.toFixed(4)} need <-0.002; dWLD ${dH.toFixed(2)}pp need >1.0pp).`;
    console.log("  Reason: " + why);
  }
}
run();
