#!/usr/bin/env node
"use strict";

// Inlined from canonical wevibe-sim/ranking-fix.js because that file does not
// export ET_BASE/simulate/scenario functions for require().
const MAX_W = 10000;
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
};

const STEADY_SCENARIO = {
  name: "Steady State",
  initMem: 100,
  epochs: 60,
  qPerEpoch: 15,
  qSize: 3,
  servePer: 3,
  badRate: 0.12,
  tpDeny: 0.55,
  fpDeny: 0.04,
  contRate: 2,
  maxKw: 7,
  contStops: null,
};

const SEEDS = [42, 123, 7, 999, 31415];
const RETRIEVAL_THRESHOLD = 1500;
const KW_SPACE = 300;
const EPOCH_MULTIPLIER = 5;

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

function makeMemory(id, sc, epoch, rand) {
  const nk = 3 + Math.floor(rand() * Math.max(1, sc.maxKw - 2));
  return {
    id,
    createdEpoch: epoch,
    archived: false,
    archivedEpoch: -1,
    isGood: rand() >= sc.badRate,
    serves: 0,
    denials: 0,
    kws: pickN(nk, sc.kwSpace, rand).map((kid) => ({ id: kid, w: MAX_W, serves: 0, denials: 0 })),
  };
}

function rawScore(m, qset) {
  let s = 0;
  for (const k of m.kws) {
    if (qset.has(k.id)) {
      s += k.w;
    }
  }
  return s;
}

function queryScore(m, qset) {
  return rawScore(m, qset);
}

function applyDecay(m, epoch, servesThisEpoch, denialsThisEpoch, kwIdsMatched, model) {
  if (epoch - m.createdEpoch < model.grace) {
    return;
  }

  const totalEvents = m.serves + m.denials;
  const denialRate = totalEvents > 0 ? m.denials / totalEvents : 0;
  const trust = Math.max(0, 1 - denialRate);
  const trustSq = trust * trust;
  const trustEarned = m.serves >= (model.trustMinServes ?? 999) && denialRate < (model.trustMaxRate ?? 0);

  for (const k of m.kws) {
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

function simulate(scenario, model, seed, retrievalThreshold, kwSpace, epochMultiplier) {
  const rand = mulberry32(seed);
  const sc = { ...scenario, kwSpace };
  const mems = [];
  const actualEpochs = scenario.epochs * epochMultiplier;

  for (let i = 0; i < scenario.initMem; i++) {
    mems.push(makeMemory(i, sc, 0, rand));
  }

  for (let e = 0; e < actualEpochs; e++) {
    const stopE = scenario.contStops != null ? scenario.contStops * epochMultiplier : null;
    const cr = stopE != null && e >= stopE ? 0 : scenario.contRate;
    for (let c = 0; c < cr; c++) {
      mems.push(makeMemory(mems.length, sc, e, rand));
    }

    const active = mems.filter((m) => !m.archived);
    const eventCounts = new Map();

    for (let q = 0; q < scenario.qPerEpoch; q++) {
      const qkws = new Set(pickN(scenario.qSize, kwSpace, rand));
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
        const pD = m.isGood ? scenario.fpDeny : scenario.tpDeny;
        if (rand() < pD) {
          ec.denials++;
          m.denials++;
        }
      });
    }

    for (const m of active) {
      const ec = eventCounts.get(m.id) || { serves: 0, denials: 0, kwIds: new Set() };
      for (const k of m.kws) {
        if (ec.kwIds.has(k.id)) {
          k.serves += ec.serves;
          k.denials += ec.denials;
        }
      }
      applyDecay(m, e, ec.serves, ec.denials, ec.kwIds, model);
      if (m.kws.every((k) => k.w <= retrievalThreshold)) {
        m.archived = true;
        m.archivedEpoch = e;
      }
    }
  }

  const alive = mems.filter((m) => !m.archived);
  const tGood = mems.filter((m) => m.isGood).length || 1;
  const tBad = mems.filter((m) => !m.isGood).length || 1;
  const aGood = alive.filter((m) => m.isGood).length;
  const aBad = alive.filter((m) => !m.isGood).length;

  return {
    goodSurv: aGood / tGood,
    badPersist: aBad / tBad,
    gap: aGood / tGood - aBad / tBad,
  };
}

function formatPercent(v) {
  return (v * 100).toFixed(2);
}

function main() {
  const model = { ...ET_BASE, queryStrategy: "topN" };
  const totals = { goodSurv: 0, badPersist: 0, gap: 0 };

  for (const seed of SEEDS) {
    const r = simulate(STEADY_SCENARIO, model, seed, RETRIEVAL_THRESHOLD, KW_SPACE, EPOCH_MULTIPLIER);
    totals.goodSurv += r.goodSurv;
    totals.badPersist += r.badPersist;
    totals.gap += r.gap;
  }

  const n = SEEDS.length;
  const avgGoodSurv = totals.goodSurv / n;
  const avgBadPersist = totals.badPersist / n;
  const avgGap = totals.gap / n;

  console.log(
    `STEADY_STATE_ET sim.goodSurv=${formatPercent(avgGoodSurv)} sim.badPersist=${formatPercent(avgBadPersist)} sim.gap=${formatPercent(avgGap)}`
  );
}

main();
