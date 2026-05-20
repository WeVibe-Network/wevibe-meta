import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { createHash } from 'node:crypto';

describe('contributor: report-memory', () => {
  const client = new HubClient();

  it('files a report against a memory', async () => {
    const state = loadState();
    const consumer = getIdentity(state, 'consumer');

    const fakeCid = createHash('sha256').update('fake-memory-content').digest('hex');
    const result = await client.createReport(state.orgId, {
      memory_cid: fakeCid,
      reason: 'inappropriate content',
      note: 'Test report',
    }, consumer);

    expect(result).toBeTruthy();
  });
});
