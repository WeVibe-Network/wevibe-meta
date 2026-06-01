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
// The traffic regime is parameterized so one script can emit references for
// every replay regime. The sim config MUST match the replay run exactly:
//
//   STEADY:    qPerEpoch=15 contRate=0
//   BOOTSTRAP: qPerEpoch=4  contRate=0
//   HEAVY:     qPerEpoch=45 contRate=6
//
// Usage:
//   node scripts/sim-trajectory.js --regime steady --epochs 300 > /tmp/sim-trajectory-steady.json
//   SIM_REGIME=bootstrap node scripts/sim-trajectory.js --epochs 300 > /tmp/sim-trajectory-bootstrap.json
//   node scripts/sim-trajectory.js --regime heavy 300 > /tmp/sim-trajectory-heavy.json

const MAX_W = 10000;
const ET = {
  denialD: 900, serveD: 220, idleD: 600, grace: 20,
  serveFloor: 0.4, denialFloor: 0.3, idleProtect: 0.05, idleUntrusted: 1.0,
  trustMinServes: 1, trustMaxRate: 0.30,
};
const SEEDS = [42, 123, 7, 999, 31415];
const RETRIEVAL_THRESHOLD = 1500;

const REGIMES = {
  steady: { qPerEpoch: 15, contRate: 0 },
  bootstrap: { qPerEpoch: 4, contRate: 0 },
  heavy: { qPerEpoch: 45, contRate: 6 },
};

function parseArgs(argv) {
  let regime = (process.env.SIM_REGIME || "steady").trim().toLowerCase() || "steady";
  let epochsRaw = process.env.SIM_EPOCHS;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--regime") {
      regime = ((argv[i + 1] || "").trim().toLowerCase() || regime);
      i++;
      continue;
    }
    if (a.startsWith("--regime=")) {
      regime = (a.slice("--regime=".length).trim().toLowerCase() || regime);
      continue;
    }
    if (a === "--epochs") {
      epochsRaw = argv[i + 1] || epochsRaw;
      i++;
      continue;
    }
    if (a.startsWith("--epochs=")) {
      epochsRaw = a.slice("--epochs=".length) || epochsRaw;
      continue;
    }
    if (!a.startsWith("--") && epochsRaw == null) {
      epochsRaw = a;
    }
  }

  if (!Object.prototype.hasOwnProperty.call(REGIMES, regime)) {
    throw new Error(`invalid regime \"${regime}\"; expected one of: ${Object.keys(REGIMES).join(", ")}`);
  }
  const epochs = parseInt(epochsRaw || "300", 10);
  if (!Number.isFinite(epochs) || epochs <= 0) {
    throw new Error(`invalid epochs \"${epochsRaw}\"; expected positive integer`);
  }
  return { regime, epochs };
}

// Matches wevibe-meta/scripts/empirical_replay constants. kwSpace=50 because
// the replay draws memory + query keywords from a 50-word fixtureVocabulary.
function makeScenario(regime) {
  return {
    initMem: 100,
    qSize: 3,
    servePer: 3,
    badRate: 0.12,
    tpDeny: 0.55,
    fpDeny: 0.04,
    maxKw: 7,
    kwSpace: 50,
    ...REGIMES[regime],
  };
}

function mb(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pick(n, max, r) { const p = Array.from({ length: max }, (_, i) => i); const o = []; for (let i = 0; i < Math.min(n, max); i++) o.push(p.splice(Math.floor(r() * p.length), 1)[0]); return o; }
function mm(id, e, r, sc) { const nk = 3 + Math.floor(r() * Math.max(1, sc.maxKw - 2)); return { id, ce: e, arch: false, good: r() >= sc.badRate, sv: 0, dn: 0, kws: pick(nk, sc.kwSpace, r).map((k) => ({ id: k, w: MAX_W })) }; }
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
function runSeed(seed, epochs, sc) {
  const r = mb(seed);
  const M = [];
  for (let i = 0; i < sc.initMem; i++) M.push(mm(i, 0, r, sc));
  const perEpoch = [];
  for (let e = 0; e < epochs; e++) {
    for (let c = 0; c < sc.contRate; c++) M.push(mm(M.length, e, r, sc));
    const act = M.filter((m) => !m.arch);
    const ec = new Map();
    for (let q = 0; q < sc.qPerEpoch; q++) {
      const qk = new Set(pick(sc.qSize, sc.kwSpace, r));
      const rk = act.map((m) => ({ m, s: qscore(m, qk) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, sc.servePer);
      rk.forEach(({ m }) => {
        const c = ec.get(m.id) || { sv: 0, dn: 0, k: new Set() };
        c.sv++; for (const k of m.kws) if (qk.has(k.id)) c.k.add(k.id);
        ec.set(m.id, c); m.sv++;
        const pd = m.good ? sc.fpDeny : sc.tpDeny;
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
  const { regime, epochs } = parseArgs(process.argv);
  const sc = makeScenario(regime);
  const acc = Array.from({ length: epochs }, () => ({ good: 0, bad: 0 }));
  for (const s of SEEDS) {
    const tr = runSeed(s, epochs, sc);
    for (let e = 0; e < epochs; e++) { acc[e].good += tr[e].good; acc[e].bad += tr[e].bad; }
  }
  const out = acc.map((a, e) => {
    const good = a.good / SEEDS.length;
    const bad = a.bad / SEEDS.length;
    return { epoch: e + 1, good: +good.toFixed(4), bad: +bad.toFixed(4), gap: +(good - bad).toFixed(4) };
  });
  const scenario = `${regime}-q${sc.qPerEpoch}-cont${sc.contRate}-kw${sc.kwSpace}`;
  process.stdout.write(JSON.stringify({ scenario, regime, grace: ET.grace, epochs, qPerEpoch: sc.qPerEpoch, contRate: sc.contRate, trajectory: out }, null, 0) + "\n");
}

main();
