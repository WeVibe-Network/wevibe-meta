import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity, updateState } from '../lib/state.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';

describe('contributor: submit-memory', () => {
  const client = new HubClient();

  it('encrypts and submits a memory', async () => {
    const state = loadState();
    const contributor = getIdentity(state, 'contributor');
    const moderator = getIdentity(state, 'moderator');

    const modPubkey = moderator.xPub;
    const encResult = encryptMemory('This is a test memory from the contributor', modPubkey);
    const contributorSig = signSubmission(contributor, encResult.submissionHash);

    const result = await client.submitMemory(state.orgId, {
      org_id: state.orgId,
      epoch_id: state.currentEpoch,
      ciphertext: encResult.ciphertextHex,
      wrapped_dek_mod: encResult.wrappedDekModHex,
      submission_hash: encResult.submissionHash,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: contributorSig,
      stack_hint: ['test', 'memory'],
    });

    expect(result.status).toBe('pending');
    expect(result.submission_hash).toBe(encResult.submissionHash);

    const hashes = [...(state.submissionHashes || []), encResult.submissionHash];
    updateState({ submissionHashes: hashes });
  });
});
