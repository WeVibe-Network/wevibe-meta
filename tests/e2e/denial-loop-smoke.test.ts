import { beforeAll, describe, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';
import { HubClient } from '../lib/hub-client.js';
import { buildWeVibeSignedHeaders } from '../lib/auth.js';
import { CONFIG } from '../lib/config.js';
import { uint8ToHex } from '../lib/identity.js';
import { generateFreshState, getIdentity } from '../lib/state.js';

interface PendingCountResponse {
  pending_count: number;
}

interface PendingDenialsResponse {
  denials: Array<{
    nullifier: string;
    memory_hash: string;
    reason: string;
    created_at: string;
  }>;
  total_count: number;
}

const scoreDropAssertionBlockReason = [
  'Score-drop recall assertion intentionally omitted in this reduced CO-018 smoke test.',
  'Blocked by a pre-existing status mismatch outside Sprint 30 denial-loop changes:',
  "schema check allows pending|pending_keyword|pending_chain|committed, while moderation handlers write/read ready and write approved.",
  'References: moderation.go:203, moderation.go:709, moderation.go:781, schema.sql:101.',
].join(' ');

function randomHex32(): string {
  return randomBytes(32).toString('hex');
}

function fail(step: string, detail: string): never {
  throw new Error(`[${step}] ${detail}`);
}

async function parseJSON(step: string, response: Response): Promise<unknown> {
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    fail(step, `expected JSON response; got: ${body}`);
  }
}

describe('denial loop smoke test (reduced scope)', () => {
  const client = new HubClient();

  let orgID = '';
  let leaderHeaders: Record<string, string>;
  let memberHeaders: Record<string, string>;

  beforeAll(async () => {
    try {
      const health = await client.health();
      if (health.status !== 'ok' || health.db !== 'connected') {
        fail(
          'Step 0 - stack preflight',
          `hub health mismatch. expected status=ok/db=connected, got ${JSON.stringify(health)}`,
        );
      }
    } catch (error) {
      fail(
        'Step 0 - stack preflight',
        `cannot reach hub at ${CONFIG.hubUrl}. Start the real dogfood stack first (make -C /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-meta docker-up). cause=${String(error)}`,
      );
    }

    let stackHealth: Awaited<ReturnType<HubClient['testHealth']>>;
    try {
      stackHealth = await client.testHealth();
    } catch (error) {
      fail(
        'Step 0 - stack preflight',
        `cannot reach /v1/test/health on hub. This smoke test requires real dogfood stack services. cause=${String(error)}`,
      );
    }

    if (stackHealth.qdrant !== 'connected') {
      fail('Step 0 - stack preflight', `qdrant is not connected: ${JSON.stringify(stackHealth)}`);
    }

    const state = generateFreshState();
    const leader = getIdentity(state, 'leader');
    const member = getIdentity(state, 'consumer');

    orgID = state.orgId;
    leaderHeaders = buildWeVibeSignedHeaders(leader);
    memberHeaders = buildWeVibeSignedHeaders(member);

    const modPubkey = leader.xPub;
    const encEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const searchEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const modEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));

    await client.createOrg(
      state.orgId,
      state.orgName,
      state.domain,
      leader.xPubkeyHex,
      encEnvelope,
      searchEnvelope,
      modEnvelope,
      { tier: 'starter', monthly_credits: 1000, per_query_cost: 1, currency: 'USD' },
      leader,
    );

    await client.inviteMember(
      orgID,
      member.pubkeyHex,
      member.xPubkeyHex,
      'member',
      encEnvelope,
      searchEnvelope,
      modEnvelope,
      leader,
    );
  }, 120000);

  it('records denial and increments pending count via hub API', async () => {
    console.info(`[CO-018 reduced scope] ${scoreDropAssertionBlockReason}`);

    const memoryHash = randomHex32();
    const nullifier = randomHex32();

    const baselineResp = await fetch(`${CONFIG.hubUrl}/v1/orgs/${orgID}/denials/pending-count`, {
      method: 'GET',
      headers: leaderHeaders,
    });
    if (!baselineResp.ok) {
      const body = await baselineResp.text();
      fail('Step 1 - baseline pending count', `expected HTTP 200, got ${baselineResp.status}. response=${body}`);
    }
    const baseline = await parseJSON('Step 1 - baseline pending count', baselineResp) as PendingCountResponse;
    if (typeof baseline.pending_count !== 'number' || baseline.pending_count < 0) {
      fail('Step 1 - baseline pending count', `expected non-negative pending_count, got ${JSON.stringify(baseline)}`);
    }

    const denialResp = await fetch(`${CONFIG.hubUrl}/v1/orgs/${orgID}/denials`, {
      method: 'POST',
      headers: memberHeaders,
      body: JSON.stringify({
        memory_hash: memoryHash,
        nullifier,
        reason: 'test denial',
      }),
    });

    if (denialResp.status !== 200 && denialResp.status !== 201) {
      const body = await denialResp.text();
      fail('Step 2 - record denial', `expected HTTP 200/201, got ${denialResp.status}. response=${body}`);
    }

    const denialPayload = await parseJSON('Step 2 - record denial', denialResp) as Record<string, unknown>;
    if (denialPayload.status !== 'recorded') {
      fail('Step 2 - record denial', `expected status=recorded, got ${JSON.stringify(denialPayload)}`);
    }

    const afterResp = await fetch(`${CONFIG.hubUrl}/v1/orgs/${orgID}/denials/pending-count`, {
      method: 'GET',
      headers: leaderHeaders,
    });
    if (!afterResp.ok) {
      const body = await afterResp.text();
      fail('Step 3 - verify pending count increment', `expected HTTP 200, got ${afterResp.status}. response=${body}`);
    }

    const after = await parseJSON('Step 3 - verify pending count increment', afterResp) as PendingCountResponse;
    if (typeof after.pending_count !== 'number') {
      fail('Step 3 - verify pending count increment', `expected numeric pending_count, got ${JSON.stringify(after)}`);
    }

    const expected = baseline.pending_count + 1;
    if (after.pending_count !== expected) {
      fail(
        'Step 3 - verify pending count increment',
        `expected pending_count=${expected} after one denial, got ${after.pending_count} (baseline=${baseline.pending_count})`,
      );
    }

    const listResp = await fetch(`${CONFIG.hubUrl}/v1/orgs/${orgID}/denials/pending`, {
      method: 'GET',
      headers: leaderHeaders,
    });
    if (!listResp.ok) {
      const body = await listResp.text();
      fail('Step 4 - verify pending denial listing', `expected HTTP 200, got ${listResp.status}. response=${body}`);
    }

    const listing = await parseJSON('Step 4 - verify pending denial listing', listResp) as PendingDenialsResponse;
    const found = listing.denials?.some(entry => entry.nullifier === nullifier && entry.memory_hash === memoryHash) ?? false;
    if (!found) {
      fail(
        'Step 4 - verify pending denial listing',
        `expected denial nullifier=${nullifier} memory_hash=${memoryHash} in pending list; got ${JSON.stringify(listing)}`,
      );
    }
  }, 120000);
});
