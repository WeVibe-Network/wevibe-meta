import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';

describe('moderator: review-queue', () => {
  const client = new HubClient();

  it('can access the moderation queue', async () => {
    const state = loadState();
    const moderator = getIdentity(state, 'moderator');
    const queue = await client.getModerationQueue(state.orgId, moderator);
    expect(Array.isArray(queue)).toBe(true);
  });
});