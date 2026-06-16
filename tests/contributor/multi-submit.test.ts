import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';

describe('contributor: multi-submit', () => {
  const client = new HubClient();

  it('submits multiple memories', async () => {
    const state = loadState();
    const contributor = getIdentity(state, 'contributor');
    const moderator = getIdentity(state, 'moderator');
    const modPubkey = moderator.xPub;

    const memories = [
      'First test memory about docker containers',
      'Second test memory about nginx configuration',
      'Third test memory about kubernetes ingress',
    ];

    const hashes: string[] = [];
    for (const text of memories) {
      const enc = encryptMemory(text, modPubkey);
      const sig = signSubmission(contributor, enc.submissionHash);
      const result = await client.submitMemory(state.orgId, {
        org_id: state.orgId,
        epoch_id: state.currentEpoch,
        ciphertext: enc.ciphertextHex,
        wrapped_dek_mod: enc.wrappedDekModHex,
        submission_hash: enc.submissionHash,
        contributor_pubkey: contributor.pubkeyHex,
        contributor_sig: sig,
        stack_hint: text.split(' ').slice(0, 2),
        memory_type: 'memory',
      }, contributor);
      expect(result.status).toBe('pending');
      hashes.push(enc.submissionHash);
    }
    expect(hashes.length).toBe(3);
  });
});
