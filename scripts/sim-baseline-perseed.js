#!/usr/bin/env node
"use strict";

// sim-baseline-perseed.js
// Emits a single seed+regime baseline line for the empirical replay gate:
//   BASELINE regime=<r> seed=<n> sim.goodSurv=<pp> sim.badPersist=<pp> sim.gap=<pp>
//
// This is decay-only Earned Trust with top-N retrieval, using the same regime
// table as sim-trajectory.js and a 300 effective-epoch run (60 * 5).

const MAX_W = 10000;
const RETRIEVAL_THRESHOLD = 1500;
const KW_SPACE = 50;
const EPOCH_MULTIPLIER = 5;

const ET_BASE = {
  dMode: "earnedTrust",
  denialD: 900,
  serveD: 220,
  idleD: 600,
  grace: 20,
  serveFloor: 0.4,
  denialFloor: 0.3,
  idleProtect: 0.05,
  idleUntrusted: 1.0,
  trustMinServes: 1,
  trustMaxRate: 0.30,
  queryStrategy: "topN",
};

const REGIMES = {
  steady: { qPerEpoch: 15, contRate: 0 },
  bootstrap: { qPerEpoch: 4, contRate: 0 },
  heavy: { qPerEpoch: 45, contRate: 6 },
};

const BASE_SCENARIO = {
  initMem: 100,
  epochs: 60,
  qSize: 3,
  servePer: 3,
  badRate: 0.12,
  tpDeny: 0.55,
  fpDeny: 0.04,
  maxKw: 7,
};

function parseArgs(argv) {
  let regime = (process.env.SIM_REGIME || "steady").trim().toLowerCase() || "steady";
  let seedRaw = process.env.SIM_SEED || "42";

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
    if (a === "--seed") {
      seedRaw = argv[i + 1] || seedRaw;
      i++;
      continue;
    }
    if (a.startsWith("--seed=")) {
      seedRaw = a.slice("--seed=".length) || seedRaw;
      continue;
    }
  }

  if (!Object.prototype.hasOwnProperty.call(REGIMES, regime)) {
    throw new Error(`invalid regime "${regime}"; expected one of: ${Object.keys(REGIMES).join(", ")}`);
  }

  const seed = Number.parseInt(seedRaw, 10);
  if (!Number.isFinite(seed)) {
    throw new Error(`invalid seed "${seedRaw}"; expected integer`);
  }

  return { regime, seed };
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickN(n, max, rand) {
  const pool = Array.from({ length: max }, (_, i) => i);
  const out = [];
  for (let i = 0; i < Math.min(n, max); i++) {
    const idx = Math.floor(rand() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function makeMemory(id, scenario, createdEpoch, rand) {
  const nk = 3 + Math.floor(rand() * Math.max(1, scenario.maxKw - 2));
  return {
    id,
    createdEpoch,
    archived: false,
    isGood: rand() >= scenario.badRate,
    serves: 0,
    denials: 0,
    kws: pickN(nk, KW_SPACE, rand).map((kid) => ({ id: kid, w: MAX_W })),
  };
}

function queryScore(memory, qset) {
  let score = 0;
  for (const k of memory.kws) {
    if (qset.has(k.id)) {
      score += k.w;
    }
  }
  return score;
}

function applyDecay(memory, epoch, servesThisEpoch, denialsThisEpoch, kwIdsMatched, model) {
  if (epoch - memory.createdEpoch < model.grace) {
    return;
  }

  const totalEvents = memory.serves + memory.denials;
  const denialRate = totalEvents > 0 ? memory.denials / totalEvents : 0;
  const trust = Math.max(0, 1 - denialRate);
  const trustSq = trust * trust;
  const trustEarned = memory.serves >= model.trustMinServes && denialRate < model.trustMaxRate;

  for (const k of memory.kws) {
    const matchedThisEpoch = kwIdsMatched.has(k.id);
    if (servesThisEpoch > 0 && matchedThisEpoch) {
      k.w += model.serveD * servesThisEpoch * (model.serveFloor + (1 - model.serveFloor) * trustSq);
    }
    if (denialsThisEpoch > 0 && matchedThisEpoch) {
      k.w -= model.denialD * denialsThisEpoch * (model.denialFloor + (1 - model.denialFloor) * denialRate);
    }
    if (!matchedThisEpoch || (servesThisEpoch === 0 && denialsThisEpoch === 0)) {
      const idleMult = trustEarned ? model.idleProtect : model.idleUntrusted;
      k.w -= model.idleD * idleMult;
    }
    k.w = Math.max(0, Math.min(MAX_W, k.w));
  }
}

function makeScenario(regime) {
  return {
    ...BASE_SCENARIO,
    ...REGIMES[regime],
  };
}

function simulate(regime, seed) {
  const model = ET_BASE;
  const scenario = makeScenario(regime);
  const rand = mulberry32(seed);
  const mems = [];

  for (let i = 0; i < scenario.initMem; i++) {
    mems.push(makeMemory(i, scenario, 0, rand));
  }

  const actualEpochs = scenario.epochs * EPOCH_MULTIPLIER;
  for (let e = 0; e < actualEpochs; e++) {
    for (let c = 0; c < scenario.contRate; c++) {
      mems.push(makeMemory(mems.length, scenario, e, rand));
    }

    const active = mems.filter((m) => !m.archived);
    const eventCounts = new Map();

    for (let q = 0; q < scenario.qPerEpoch; q++) {
      const qkws = new Set(pickN(scenario.qSize, KW_SPACE, rand));
      const ranked = active
        .map((m) => ({ m, s: queryScore(m, qkws) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, scenario.servePer);

      ranked.forEach(({ m }) => {
        const ec = eventCounts.get(m.id) || { serves: 0, denials: 0, kwIds: new Set() };
        ec.serves++;
        for (const k of m.kws) {
          if (qkws.has(k.id)) {
            ec.kwIds.add(k.id);
          }
        }
        eventCounts.set(m.id, ec);

        m.serves++;
        const denialProb = m.isGood ? scenario.fpDeny : scenario.tpDeny;
        if (rand() < denialProb) {
          ec.denials++;
          m.denials++;
        }
      });
    }

    for (const m of active) {
      const ec = eventCounts.get(m.id) || { serves: 0, denials: 0, kwIds: new Set() };
      applyDecay(m, e, ec.serves, ec.denials, ec.kwIds, model);
      if (m.kws.every((k) => k.w <= RETRIEVAL_THRESHOLD)) {
        m.archived = true;
      }
    }
  }

  const cohort = mems.filter((m) => m.createdEpoch === 0);
  const totalGood = cohort.filter((m) => m.isGood).length || 1;
  const totalBad = cohort.filter((m) => !m.isGood).length || 1;
  const aliveGood = cohort.filter((m) => m.isGood && !m.archived).length;
  const aliveBad = cohort.filter((m) => !m.isGood && !m.archived).length;

  const goodSurv = aliveGood / totalGood;
  const badPersist = aliveBad / totalBad;
  return {
    goodSurv,
    badPersist,
    gap: goodSurv - badPersist,
  };
}

function formatPercent(value) {
  return (value * 100).toFixed(2);
}

function main() {
  const { regime, seed } = parseArgs(process.argv);
  const result = simulate(regime, seed);
  process.stdout.write(
    `BASELINE regime=${regime} seed=${seed} sim.goodSurv=${formatPercent(result.goodSurv)} sim.badPersist=${formatPercent(result.badPersist)} sim.gap=${formatPercent(result.gap)}\n`
  );
}

main();
