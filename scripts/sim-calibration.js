#!/usr/bin/env node
"use strict";

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

const SEEDS = [42, 123, 7, 999, 31415];
const RETRIEVAL_THRESHOLD = 1500;
const KW_SPACE = 300;
const EPOCH_MULTIPLIER = 5;
const Q_SWEEP = [1, 2, 4, 6, 10, 15, 30, 45];

const BASE_SCENARIO = {
  initMem: 100,
  epochs: 60,
  qSize: 3,
  servePer: 3,
  badRate: 0.12,
  tpDeny: 0.55,
  fpDeny: 0.04,
  contRate: 2,
  maxKw: 7,
  contStops: null,
};

const SCENARIOS = [
  ...Q_SWEEP.map((qPerEpoch) => ({
    ...BASE_SCENARIO,
    kind: "steady",
    name: `steady-q${qPerEpoch}`,
    qPerEpoch,
    qSchedule: null,
  })),
  {
    ...BASE_SCENARIO,
    kind: "ramp",
    name: "ramp-low-then-steady",
    qPerEpoch: null,
    qSchedule: (epoch, actualEpochs) => {
      const lowTrafficEpochs = Math.floor(actualEpochs * 0.7);
      return epoch < lowTrafficEpochs ? 0 : 15;
    },
  },
];

const ADAPTATIONS = {
  none: {
    key: "none",
    label: "none",
    idleMultiplier(ctx) {
      return ctx.trustEarned ? ctx.model.idleProtect : ctx.model.idleUntrusted;
    },
  },
  scaledUntrusted: {
    key: "scaledUntrusted",
    label: "scaled_untrusted",
    idleMultiplier(ctx) {
      if (ctx.trustEarned) {
        return ctx.model.idleProtect;
      }
      const scaled = clamp(ctx.tEpoch / ctx.constants.tRef, ctx.constants.floor, 1);
      return ctx.model.idleUntrusted * scaled;
    },
  },
  zeroSignalGuard: {
    key: "zeroSignalGuard",
    label: "zero_signal_guard",
    idleMultiplier(ctx) {
      if (ctx.orgEvents === 0) {
        return 0;
      }
      return ctx.trustEarned ? ctx.model.idleProtect : ctx.model.idleUntrusted;
    },
  },
  hybrid: {
    key: "hybrid",
    label: "hybrid_guard_plus_scale",
    idleMultiplier(ctx) {
      if (ctx.orgEvents === 0) {
        return 0;
      }
      if (ctx.trustEarned) {
        return ctx.model.idleProtect;
      }
      const scaled = clamp(ctx.tEpoch / ctx.constants.tRef, ctx.constants.floor, 1);
      return ctx.model.idleUntrusted * scaled;
    },
  },
};

const LOCKED_GOLDILOCKS = {
  adaptation: "hybrid",
  tRef: 0.22,
  floor: 1.0,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

function applyDecay(m, epoch, servesThisEpoch, denialsThisEpoch, kwIdsMatched, model, idleContext, adaptation) {
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
      const idleMult = adaptation.idleMultiplier({
        trustEarned,
        model,
        tEpoch: idleContext.tEpoch,
        orgEvents: idleContext.orgEvents,
        constants: idleContext.constants,
      });
      k.w -= model.idleD * idleMult;
    }
    k.w = Math.max(0, Math.min(MAX_W, k.w));
  }
}

function getQPerEpoch(scenario, epoch, actualEpochs) {
  if (typeof scenario.qSchedule === "function") {
    return scenario.qSchedule(epoch, actualEpochs);
  }
  return scenario.qPerEpoch;
}

function simulate(scenario, model, seed, retrievalThreshold, kwSpace, epochMultiplier, adaptation, constants) {
  const rand = mulberry32(seed);
  const sc = { ...scenario, kwSpace };
  const mems = [];
  const actualEpochs = scenario.epochs * epochMultiplier;
  let tEpochTotal = 0;

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
    const qPerEpoch = getQPerEpoch(scenario, e, actualEpochs);

    let epochServes = 0;
    let epochDenials = 0;

    for (let q = 0; q < qPerEpoch; q++) {
      const qkws = new Set(pickN(scenario.qSize, kwSpace, rand));
      const ranked = active
        .map((m) => ({ m, s: queryScore(m, qkws) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, scenario.servePer);

      ranked.forEach(({ m }) => {
        const ec = eventCounts.get(m.id) || { serves: 0, denials: 0, kwIds: new Set() };
        ec.serves++;
        epochServes++;
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
          epochDenials++;
          m.denials++;
        }
      });
    }

    const activeCount = active.length || 1;
    const tEpoch = (epochServes + epochDenials) / activeCount;
    tEpochTotal += tEpoch;

    for (const m of active) {
      const ec = eventCounts.get(m.id) || { serves: 0, denials: 0, kwIds: new Set() };
      for (const k of m.kws) {
        if (ec.kwIds.has(k.id)) {
          k.serves += ec.serves;
          k.denials += ec.denials;
        }
      }
      applyDecay(
        m,
        e,
        ec.serves,
        ec.denials,
        ec.kwIds,
        model,
        { tEpoch, orgEvents: epochServes + epochDenials, constants },
        adaptation
      );
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
    avgT: tEpochTotal / actualEpochs,
  };
}

function runScenarioSet(adaptationKey, constants) {
  const adaptation = ADAPTATIONS[adaptationKey];
  if (!adaptation) {
    throw new Error(`Unknown adaptation: ${adaptationKey}`);
  }

  const model = { ...ET_BASE, queryStrategy: "topN" };
  const results = [];

  for (const scenario of SCENARIOS) {
    const totals = { goodSurv: 0, badPersist: 0, gap: 0, avgT: 0 };
    for (const seed of SEEDS) {
      const r = simulate(
        scenario,
        model,
        seed,
        RETRIEVAL_THRESHOLD,
        KW_SPACE,
        EPOCH_MULTIPLIER,
        adaptation,
        constants
      );
      totals.goodSurv += r.goodSurv;
      totals.badPersist += r.badPersist;
      totals.gap += r.gap;
      totals.avgT += r.avgT;
    }

    const n = SEEDS.length;
    results.push({
      scenario: scenario.name,
      kind: scenario.kind,
      qPerEpoch: scenario.qPerEpoch,
      adaptation: adaptation.label,
      goodSurv: totals.goodSurv / n,
      badPersist: totals.badPersist / n,
      gap: totals.gap / n,
      avgT: totals.avgT / n,
    });
  }

  return results;
}

function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function fixed(v, d = 4) {
  return v.toFixed(d);
}

function printTable(title, rows, baselineRows) {
  console.log(`\n${title}`);
  console.log(
    "scenario                 mode   qPerEpoch  adaptation               goodSurv  badPersist  gap       avgT    badDeltaVsNone"
  );
  console.log(
    "-----------------------  -----  ---------  -----------------------  --------  ----------  --------  ------  --------------"
  );
  for (const row of rows) {
    const baseline = baselineRows.find((b) => b.scenario === row.scenario);
    const badDelta = baseline ? row.badPersist - baseline.badPersist : 0;
    const qLabel = row.qPerEpoch == null ? "ramp" : String(row.qPerEpoch);
    console.log(
      `${row.scenario.padEnd(23)}  ${row.kind.padEnd(5)}  ${qLabel.padStart(9)}  ${row.adaptation.padEnd(23)}  ${pct(
        row.goodSurv
      ).padStart(8)}  ${pct(row.badPersist).padStart(10)}  ${pct(row.gap).padStart(8)}  ${fixed(row.avgT, 4).padStart(6)}  ${pct(
        badDelta
      ).padStart(14)}`
    );
  }
}

function evaluateGoldilocksCandidate(candidate, baselineRows) {
  const rows = runScenarioSet(candidate.adaptation, { tRef: candidate.tRef, floor: candidate.floor });
  const byScenario = new Map(rows.map((r) => [r.scenario, r]));
  const baseByScenario = new Map(baselineRows.map((r) => [r.scenario, r]));
  const q15 = byScenario.get("steady-q15");
  const q15Base = baseByScenario.get("steady-q15");
  const ramp = byScenario.get("ramp-low-then-steady");
  const rampBase = baseByScenario.get("ramp-low-then-steady");

  let maxBadInflation = -Infinity;
  for (const row of rows) {
    const base = baseByScenario.get(row.scenario);
    if (!base) {
      continue;
    }
    maxBadInflation = Math.max(maxBadInflation, row.badPersist - base.badPersist);
  }

  const q15GapDelta = Math.abs((q15?.gap ?? 0) - (q15Base?.gap ?? 0));
  const rampGoodDelta = (ramp?.goodSurv ?? 0) - (rampBase?.goodSurv ?? 0);

  return {
    rows,
    q15GapDelta,
    rampGoodDelta,
    maxBadInflation,
    pass:
      q15GapDelta <= 0.01 &&
      rampGoodDelta > 0 &&
      maxBadInflation <= 0.03,
  };
}

function main() {
  console.log("== ET idle-decay calibration ==");
  console.log(`Deterministic seeds: ${SEEDS.join(", ")}`);
  console.log(`Q sweep: ${Q_SWEEP.join(", ")}`);
  console.log("Ramp scenario: 70% epochs at qPerEpoch=0, then 30% at qPerEpoch=15");

  const baselineRows = runScenarioSet("none", { tRef: LOCKED_GOLDILOCKS.tRef, floor: LOCKED_GOLDILOCKS.floor });
  printTable("Candidate: none", baselineRows, baselineRows);

  const scaledRows = runScenarioSet("scaledUntrusted", {
    tRef: LOCKED_GOLDILOCKS.tRef,
    floor: LOCKED_GOLDILOCKS.floor,
  });
  printTable("Candidate: scale untrusted idle", scaledRows, baselineRows);

  const guardRows = runScenarioSet("zeroSignalGuard", {
    tRef: LOCKED_GOLDILOCKS.tRef,
    floor: LOCKED_GOLDILOCKS.floor,
  });
  printTable("Candidate: zero-signal guard", guardRows, baselineRows);

  const hybridEval = evaluateGoldilocksCandidate(LOCKED_GOLDILOCKS, baselineRows);
  printTable(
    `Candidate: hybrid (locked) tRef=${LOCKED_GOLDILOCKS.tRef} floor=${LOCKED_GOLDILOCKS.floor}`,
    hybridEval.rows,
    baselineRows
  );

  const q15Base = baselineRows.find((r) => r.scenario === "steady-q15");
  const q15Locked = hybridEval.rows.find((r) => r.scenario === "steady-q15");
  const rampBase = baselineRows.find((r) => r.scenario === "ramp-low-then-steady");
  const rampLocked = hybridEval.rows.find((r) => r.scenario === "ramp-low-then-steady");

  console.log("\nLocked Goldilocks selection");
  console.log(
    `function = hybrid_guard_plus_scale(T, T_ref=${LOCKED_GOLDILOCKS.tRef}, floor=${LOCKED_GOLDILOCKS.floor})`
  );
  console.log(
    `steady-q15 gap: baseline=${pct(q15Base.gap)} locked=${pct(q15Locked.gap)} |delta|=${pct(hybridEval.q15GapDelta)}`
  );
  console.log(
    `ramp goodSurv: baseline=${pct(rampBase.goodSurv)} locked=${pct(rampLocked.goodSurv)} delta=${pct(
      hybridEval.rampGoodDelta
    )}`
  );
  console.log(`max badPersist inflation vs none: ${pct(hybridEval.maxBadInflation)}`);
  console.log(`criteria pass: ${hybridEval.pass ? "YES" : "NO"}`);
}

main();
