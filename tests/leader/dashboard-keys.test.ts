import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { buildWeVibeSignedHeaders } from '../lib/auth.js';

describe('leader: dashboard-keys', () => {
  const client = new HubClient();

  it('registers a dashboard key', async () => {
    const state = loadState();
    const leader = getIdentity(state, 'leader');

    const timestamp = new Date().toISOString();
    const sigData = new TextEncoder().encode(timestamp);
    const { signData, uint8ToHex } = await import('../lib/identity.js');
    const sig = signData(leader, sigData);

    const body = {
      pubkey: leader.pubkeyHex,
      label: 'test-dashboard-key',
      signed_by: leader.pubkeyHex,
      signature: uint8ToHex(sig),
    };

    const result = await client.registerDashboardKey(state.orgId, body, leader);
    expect(result).toBeTruthy();
  });
});