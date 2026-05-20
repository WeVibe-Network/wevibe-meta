import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { createHash } from 'node:crypto';

describe('consumer: serve-event', () => {
  const client = new HubClient();

  it('records a serve event', async () => {
    const state = loadState();
    const consumer = getIdentity(state, 'consumer');

    const fakeCid = createHash('sha256').update('test-memory').digest('hex');
    const result = await client.recordServe(state.orgId, {
      memory_cid: fakeCid,
      org_id: state.orgId,
      served_at: new Date().toISOString(),
    }, consumer);

    expect(result).toBeTruthy();
  });
});
