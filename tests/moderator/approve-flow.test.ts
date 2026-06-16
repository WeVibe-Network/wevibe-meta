import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';
import { EMBEDDING_MODEL_ID } from '../lib/config.js';
import { createHash } from 'node:crypto';

describe('moderator: approve-flow', () => {
  const client = new HubClient();

  it('approves a pending submission', async () => {
    const state = loadState();
    const contributor = getIdentity(state, 'contributor');
    const moderator = getIdentity(state, 'moderator');
    const leader = getIdentity(state, 'leader');

    const modPubkey = moderator.xPub;
    const encResult = encryptMemory('Test memory for approval', modPubkey);
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
      memory_type: 'memory',
    }, contributor);

    const queue = await client.getModerationQueue(state.orgId, moderator);
    expect(queue.length).toBeGreaterThan(0);

    const pending = queue.find((item: Record<string, unknown>) =>
      item.submission_hash === encResult.submissionHash
    );
    expect(pending).toBeDefined();

    const approvedCid = createHash('sha256').update('approved_content').digest('hex');
    const embedResp = await client.testEmbed('Test memory for approval');
    const vector = embedResp.vector.map(Number);

    const approveBody = {
      epoch_id: 1,
      approved_cid: approvedCid,
      wrapped_dek_enc: encResult.wrappedDekModHex,
      keywords: [{ keyword: 'test', weight: 0.9 }],
      keyword_weights: { test: 0.9 },
      vector,
      embedding_model_id: EMBEDDING_MODEL_ID,
      moderator_sig: signSubmission(moderator, encResult.submissionHash),
      signed_by: moderator.pubkeyHex,
    };

    const result = await client.approveSubmission(state.orgId, encResult.submissionHash, approveBody, moderator);
    expect(result).toBeTruthy();
  });
});
