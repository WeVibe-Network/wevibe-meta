import { describe, it, expect, beforeAll } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { generateFreshState, saveState, getIdentity } from '../lib/state.js';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';
import { uint8ToHex } from '../lib/identity.js';

describe('leader: create-org', () => {
  const client = new HubClient();

  it('resets DB and creates org with canonical signatures', async () => {
    await client.testReset();

    const state = generateFreshState();
    const leader = getIdentity(state, 'leader');

    const modPubkey = leader.xPub;
    const encDek = generate_dek();
    const encEnvelope = uint8ToHex(seal_to_pubkey(encDek, modPubkey));
    const searchDek = generate_dek();
    const searchEnvelope = uint8ToHex(seal_to_pubkey(searchDek, modPubkey));
    const modDek = generate_dek();
    const modEnvelope = uint8ToHex(seal_to_pubkey(modDek, modPubkey));

    state.envelopes = { enc: encEnvelope, search: searchEnvelope, mod: modEnvelope };
    state.pkModHex = leader.xPubkeyHex;

    const result = await client.createOrg(
      state.orgId, state.orgName, state.domain,
      leader.xPubkeyHex, encEnvelope, searchEnvelope, modEnvelope,
      { tier: 'starter', monthly_credits: 1000, per_query_cost: 1, currency: 'USD' },
      leader,
    );

    expect(result.org_id).toBe(state.orgId);
    saveState(state);
  });

  it('verifies org was created correctly', async () => {
    const { loadState, getIdentity } = await import('../lib/state.js');
    const state = loadState();
    const leader = getIdentity(state, 'leader');

    const org = await client.getOrg(state.orgId) as Record<string, unknown>;
    expect(org.leader_pubkey).toBe(leader.pubkeyHex);
  });
});