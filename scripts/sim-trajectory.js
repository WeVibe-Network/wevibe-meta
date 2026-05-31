#!/usr/bin/env node
"use strict";

// sim-trajectory.js — emits the sim's EXPECTED per-epoch good-survival /
// bad-persistence / gap trajectory for the empirical replay's exact scenario
// (kwSpace=50 to match the replay's 50-word fixtureVocabulary).
//
// The decay model and constants are byte-for-byte the canonical Earned-Trust
// model (sim-calibration.js ET_BASE). Output is a JSON array indexed by
// traffic epoch so the replay can, at each checkpoint, compare the chain's
// observed survival against the mathematically-expected value and flag
// divergence in real time instead of waiting for the full run.
//
// The traffic regime is parameterised so one script can emit the reference for
// every replay regime. The sim config MUST match the replay run it is the
// reference for (REPLAY_QPE ↔ SIM_QPE, REPLAY_CONT_RATE ↔ SIM_CONT_RATE):
//
//   STEADY:    SIM_QPE=15 SIM_CONT_RATE=2   (sim base contRate)
//   BOOTSTRAP: SIM_QPE=4  SIM_CONT_RATE=2   (only query volume drops)
//   HEAVY:     SIM_QPE=45 SIM_CONT_RATE=6   (more queries AND more contributions)
//
// Usage:
//   node scripts/sim-trajectory.js [epochs] > /tmp/sim-trajectory.json
//   SIM_QPE=4  node scripts/sim-trajectory.js 300 > /tmp/sim-trajectory-bootstrap.json
//   SIM_QPE=45 SIM_CONT_RATE=6 node scripts/sim-trajectory.js 300 > /tmp/sim-trajectory-heavy.json

function envInt(name, fallback) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const MAX_W = 10000;
const ET = {
  denialD: 900, serveD: 220, idleD: 600, grace: 20,
  serveFloor: 0.4, denialFloor: 0.3, idleProtect: 0.05, idleUntrusted: 1.0,
  trustMinServes: 1, trustMaxRate: 0.30,
};
const SEEDS = [42, 123, 7, 999, 31415];
const RETRIEVAL_THRESHOLD = 1500;

// Matches wevibe-meta/scripts/empirical_replay constants. kwSpace=50 because
// the replay draws memory + query keywords from a 50-word fixtureVocabulary.
// qPerEpoch and contRate are the per-regime traffic knobs (see header).
const SC = {
  initMem: 100, qSize: 3, servePer: 3, badRate: 0.12,
  tpDeny: 0.55, fpDeny: 0.04, maxKw: 7, kwSpace: 50,
  contRate: envInt("SIM_CONT_RATE", 2),
  qPerEpoch: envInt("SIM_QPE", 15),
};

function mb(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pick(n, max, r) { const p = Array.from({ length: max }, (_, i) => i); const o = []; for (let i = 0; i < Math.min(n, max); i++) o.push(p.splice(Math.floor(r() * p.length), 1)[0]); return o; }
function mm(id, e, r) { const nk = 3 + Math.floor(r() * Math.max(1, SC.maxKw - 2)); return { id, ce: e, arch: false, good: r() >= SC.badRate, sv: 0, dn: 0, kws: pick(nk, SC.kwSpace, r).map((k) => ({ id: k, w: MAX_W })) }; }
function qscore(m, q) { let s = 0; for (const k of m.kws) if (q.has(k.id)) s += k.w; return s; }
function decay(m, e, sv, dn, km) {
  if (e - m.ce < ET.grace) return;
  const t = m.sv + m.dn; const dr = t > 0 ? m.dn / t : 0; const tr = Math.max(0, 1 - dr); const trs = tr * tr;
  const te = m.sv >= ET.trustMinServes && dr < ET.trustMaxRate;
  for (const k of m.kws) {
    const mt = km.has(k.id);
    if (sv > 0 && mt) k.w += ET.serveD * sv * (ET.serveFloor + (1 - ET.serveFloor) * trs);
    if (dn > 0 && mt) k.w -= ET.denialD * dn * (ET.denialFloor + (1 - ET.denialFloor) * dr);
    if (!mt || (sv === 0 && dn === 0)) { const im = te ? ET.idleProtect : ET.idleUntrusted; k.w -= ET.idleD * im; }
    k.w = Math.max(0, Math.min(MAX_W, k.w));
  }
}

// Run one seed; record good/bad survival at the END of every epoch.
function runSeed(seed, epochs) {
  const r = mb(seed);
  const M = [];
  for (let i = 0; i < SC.initMem; i++) M.push(mm(i, 0, r));
  const perEpoch = [];
  for (let e = 0; e < epochs; e++) {
    for (let c = 0; c < SC.contRate; c++) M.push(mm(M.length, e, r));
    const act = M.filter((m) => !m.arch);
    const ec = new Map();
    for (let q = 0; q < SC.qPerEpoch; q++) {
      const qk = new Set(pick(SC.qSize, SC.kwSpace, r));
      const rk = act.map((m) => ({ m, s: qscore(m, qk) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, SC.servePer);
      rk.forEach(({ m }) => {
        const c = ec.get(m.id) || { sv: 0, dn: 0, k: new Set() };
        c.sv++; for (const k of m.kws) if (qk.has(k.id)) c.k.add(k.id);
        ec.set(m.id, c); m.sv++;
        const pd = m.good ? SC.fpDeny : SC.tpDeny;
        if (r() < pd) { c.dn++; m.dn++; }
      });
    }
    for (const m of act) { const c = ec.get(m.id) || { sv: 0, dn: 0, k: new Set() }; decay(m, e, c.sv, c.dn, c.k); if (m.kws.every((k) => k.w <= RETRIEVAL_THRESHOLD)) m.arch = true; }
    // Survival measured over the INITIAL cohort only (the replay seeds initMem
    // and never adds contributors mid-run), to match what the replay measures.
    const cohort = M.filter((m) => m.ce === 0);
    const tg = cohort.filter((m) => m.good).length || 1;
    const tb = cohort.filter((m) => !m.good).length || 1;
    const ag = cohort.filter((m) => m.good && !m.arch).length;
    const ab = cohort.filter((m) => !m.good && !m.arch).length;
    perEpoch.push({ good: ag / tg, bad: ab / tb });
  }
  return perEpoch;
}

function main() {
  const epochs = parseInt(process.argv[2] || "300", 10);
  const acc = Array.from({ length: epochs }, () => ({ good: 0, bad: 0 }));
  for (const s of SEEDS) {
    const tr = runSeed(s, epochs);
    for (let e = 0; e < epochs; e++) { acc[e].good += tr[e].good; acc[e].bad += tr[e].bad; }
  }
  const out = acc.map((a, e) => {
    const good = a.good / SEEDS.length;
    const bad = a.bad / SEEDS.length;
    return { epoch: e + 1, good: +good.toFixed(4), bad: +bad.toFixed(4), gap: +(good - bad).toFixed(4) };
  });
  const scenario = `q${SC.qPerEpoch}-cont${SC.contRate}-kw${SC.kwSpace}`;
  process.stdout.write(JSON.stringify({ scenario, grace: ET.grace, epochs, qPerEpoch: SC.qPerEpoch, contRate: SC.contRate, trajectory: out }, null, 0) + "\n");
}

main();
