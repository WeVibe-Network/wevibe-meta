import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { signData, uint8ToHex } from '../lib/identity.js';
import { createHash } from 'node:crypto';

describe('consumer: reject-memory', () => {
  const client = new HubClient();

  it('rejects a memory', async () => {
    const state = loadState();
    const consumer = getIdentity(state, 'consumer');

    const fakeCid = createHash('sha256').update('test-memory-to-reject').digest('hex');
    const rejectData = new TextEncoder().encode(`${fakeCid}:${state.orgId}:reject:${consumer.pubkeyHex}`);
    const sig = uint8ToHex(signData(consumer, rejectData));

    const result = await client.rejectMemory(state.orgId, {
      cid: fakeCid,
      org_id: state.orgId,
      reason: 'inappropriate',
      agent_pubkey: consumer.pubkeyHex,
      signature: sig,
    });

    expect(result).toBeTruthy();
  });
});
