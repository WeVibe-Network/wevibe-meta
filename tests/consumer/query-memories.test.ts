import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { signData, uint8ToHex } from '../lib/identity.js';

describe('consumer: query-memories', () => {
  const client = new HubClient();

  it('queries memories with keywords and vector', async () => {
    const state = loadState();
    const consumer = getIdentity(state, 'consumer');

    const embedResp = await client.testEmbed('docker containers');
    const vector = embedResp.vector.map(Number);

    const queryData = new TextEncoder().encode(`query:${consumer.pubkeyHex}:${Date.now()}`);
    const agentSig = uint8ToHex(signData(consumer, queryData));

    const result = await client.queryMemories(state.orgId, {
      org_id: state.orgId,
      agent_pubkey: consumer.pubkeyHex,
      keyword_weights: [{ keyword: 'docker', weight: 0.8 }],
      vector,
      limit: 10,
      agent_sig: agentSig,
    });

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('contested');
    expect(result).toHaveProperty('receipt_id');
  });
});
