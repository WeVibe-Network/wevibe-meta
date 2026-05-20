import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';

describe('moderator: deny-flow', () => {
  const client = new HubClient();

  it('denies a submission', async () => {
    const state = loadState();
    const contributor = getIdentity(state, 'contributor');
    const moderator = getIdentity(state, 'moderator');

    const modPubkey = moderator.xPub;
    const encResult = encryptMemory('Test memory to deny', modPubkey);
    const contributorSig = signSubmission(contributor, encResult.submissionHash);

    await client.submitMemory(state.orgId, {
      org_id: state.orgId,
      epoch_id: 1,
      ciphertext: encResult.ciphertextHex,
      wrapped_dek_mod: encResult.wrappedDekModHex,
      submission_hash: encResult.submissionHash,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: contributorSig,
      stack_hint: ['test'],
    });

    const result = await client.denySubmission(
      state.orgId, encResult.submissionHash, 'spam content', moderator,
    );
    expect(result).toBeTruthy();
  });
});