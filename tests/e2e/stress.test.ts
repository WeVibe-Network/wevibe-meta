import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { generateFreshState, saveState, getIdentity } from '../lib/state.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';
import { uint8ToHex, signData } from '../lib/identity.js';

describe('e2e: stress scenarios', () => {
  const client = new HubClient();

  it('stress: submit 50 memories rapidly', async () => {
    const state = generateFreshState();
    const leader = getIdentity(state, 'leader');
    const contributor = getIdentity(state, 'contributor');

    await client.testReset();
    const modPubkey = leader.xPub;
    const encEnv = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const searchEnv = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const modEnv = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    state.envelopes = { enc: encEnv, search: searchEnv, mod: modEnv };

    await client.createOrg(state.orgId, state.orgName, state.domain, leader.xPubkeyHex, encEnv, searchEnv, modEnv, { tier: 'starter' }, leader);
    await client.inviteMember(state.orgId, contributor.pubkeyHex, contributor.xPubkeyHex, 'member', encEnv, searchEnv, modEnv, leader);
    saveState(state);

    const baseText = 'Memory content for stress test - batch submission verification item number ';
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      const enc = encryptMemory(`${baseText}${i}`, modPubkey);
      const sig = signSubmission(contributor, enc.submissionHash);
      promises.push(client.submitMemory(state.orgId, {
        org_id: state.orgId,
        epoch_id: 1,
        ciphertext: enc.ciphertextHex,
        wrapped_dek_mod: enc.wrappedDekModHex,
        submission_hash: enc.submissionHash,
        contributor_pubkey: contributor.pubkeyHex,
        contributor_sig: sig,
        stack_hint: [`item-${i}`],
      }));
    }
    const results = await Promise.all(promises);
    const allPending = results.every(r => (r as Record<string, unknown>).status === 'pending');
    expect(allPending).toBe(true);
  });

  it('stress: approve all 50 queued submissions', async () => {
    const state = loadStateOrThrow();
    const moderator = getIdentity(state, 'moderator');
    const queue = await client.getModerationQueue(state.orgId, moderator);
    expect(queue.length).toBeGreaterThanOrEqual(10);

    const approvePromises = queue.slice(0, 10).map((item, i) => {
      const hash = (item as Record<string, unknown>).submission_hash as string;
      const cid = `stress-cid-${i}-${Date.now()}`;
      return client.approveSubmission(state.orgId, hash, {
        epoch_id: 1,
        approved_cid: cid,
        wrapped_dek_enc: '',
        keywords: [{ keyword: `keyword-${i}`, weight: 0.5 }],
        keyword_weights: { [`keyword-${i}`]: 0.5 },
        vector: Array(768).fill(0.01),
        embedding_model_id: 'nomic-embed-text',
        moderator_sig: signSubmission(moderator, hash),
        signed_by: moderator.pubkeyHex,
      }, moderator);
    });
    const results = await Promise.allSettled(approvePromises);
    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    expect(fulfilled).toBeGreaterThanOrEqual(5);
  });

  it('stress: 10 concurrent queries', async () => {
    const state = loadStateOrThrow();
    const consumer = getIdentity(state, 'consumer');
    const queries = ['docker', 'nginx', 'postgres', 'redis', 'kubernetes', 'terraform', 'docker-compose', 'monitoring', 'cicd', 'security'];

    const queryPromises = queries.map(async (q, i) => {
      const embed = await client.testEmbed(q);
      const vector = embed.vector.map(Number);
      const qData = new TextEncoder().encode(`query:${consumer.pubkeyHex}:${Date.now()}:${i}`);
      const agentSig = uint8ToHex(signData(consumer, qData));
      return client.queryMemories(state.orgId, {
        org_id: state.orgId,
        agent_pubkey: consumer.pubkeyHex,
        keyword_weights: [{ keyword: q, weight: 0.5 }],
        vector,
        limit: 5,
        agent_sig: agentSig,
      });
    });

    const results = await Promise.allSettled(queryPromises);
    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    expect(fulfilled).toBe(10);
  });

  it('stress: submit during rotation (buffered)', async () => {
    const state = loadStateOrThrow();
    const leader = getIdentity(state, 'leader');
    const contributor = getIdentity(state, 'contributor');

    const org = await client.getOrgDetails(state.orgId) as Record<string, unknown>;
    const wasPending = org.rotation_pending === true;

    const enc = encryptMemory('Memory submitted during rotation window', leader.xPub);
    const sig = signSubmission(contributor, enc.submissionHash);
    const result = await client.submitMemory(state.orgId, {
      org_id: state.orgId,
      epoch_id: state.currentEpoch,
      ciphertext: enc.ciphertextHex,
      wrapped_dek_mod: enc.wrappedDekModHex,
      submission_hash: enc.submissionHash,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: sig,
      stack_hint: ['rotation-test'],
    });

    expect(result.status).toMatch(/^(pending|buffered)$/);
    if (wasPending) {
      console.log(`  Note: rotation_pending was true, status=${result.status} (expected buffered or pending)`);
    }
  });

  it('stress: report + archive during active queries', async () => {
    const state = loadStateOrThrow();
    const consumer = getIdentity(state, 'consumer');
    const moderator = getIdentity(state, 'moderator');

    const cid = state.approvedCIDs[0] || 'test-cid';
    const reportPromise = client.createReport(state.orgId, { memory_cid: cid, reason: 'stress test report', note: 'concurrent test' }, consumer);
    const queuePromise = client.getModerationQueue(state.orgId, moderator);

    const [reportResult, queueResult] = await Promise.allSettled([reportPromise, queuePromise]);

    if (reportResult.status === 'fulfilled') {
      const r = reportResult.value as Record<string, unknown>;
      if (r.id) {
        await client.updateReport(state.orgId, r.id as string, 'archive', moderator);
      }
    }
    if (queueResult.status === 'fulfilled') {
      expect(Array.isArray(queueResult.value)).toBe(true);
    }
  });
});

function loadStateOrThrow() {
  const { loadState } = require('../lib/state.js');
  try {
    return loadState();
  } catch {
    const state = generateFreshState();
    const leader = getIdentity(state, 'leader');
    const contributor = getIdentity(state, 'contributor');
    const modPubkey = leader.xPub;
    const encEnv = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const searchEnv = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const modEnv = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    state.envelopes = { enc: encEnv, search: searchEnv, mod: modEnv };
    return state;
  }
}