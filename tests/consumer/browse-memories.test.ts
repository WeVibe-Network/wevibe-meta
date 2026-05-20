import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { buildWeVibeSignedHeaders } from '../lib/auth.js';

describe('consumer: browse-memories', () => {
  const client = new HubClient();

  it('lists all approved memories', async () => {
    const state = loadState();
    const consumer = getIdentity(state, 'consumer');

    const result = await client.listMemories(state.orgId);
    expect(result).toHaveProperty('memories');
    expect(result).toHaveProperty('count');
    expect(Array.isArray(result.memories)).toBe(true);
  });
});
