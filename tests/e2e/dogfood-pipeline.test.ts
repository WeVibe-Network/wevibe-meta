import { describe, it, expect, beforeAll } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { generateFreshState, saveState, getIdentity } from '../lib/state.js';
import { encryptMemory } from '../lib/crypto.js';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';
import { signData, uint8ToHex } from '../lib/identity.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG } from '../lib/config.js';
import { createHash, randomBytes } from 'node:crypto';
import * as canonical from '../lib/canonical.js';

describe('dogfood pipeline', () => {
  const client = new HubClient();

  let state: ReturnType<typeof generateFreshState>;
  let leader: ReturnType<typeof getIdentity>;
  let moderator: ReturnType<typeof getIdentity>;
  let contributor: ReturnType<typeof getIdentity>;
  let orgId: string;
  let currentEpoch = 0;
  let submissionHash: string;
  let plaintextMemory: string;
  let queryKeyword: string;
  const memoryType = 'correct_implementation';

  beforeAll(async () => {
    state = generateFreshState();
    leader = getIdentity(state, 'leader');
    moderator = getIdentity(state, 'moderator');
    contributor = getIdentity(state, 'contributor');
    orgId = state.orgId;

    // Per CO-253: state is wiped via `docker compose down -v` before each make dogfood run.
    const modPubkey = leader.xPub;
    const encEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const searchEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const modEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    state.envelopes = { enc: encEnvelope, search: searchEnvelope, mod: modEnvelope };
    state.pkModHex = leader.xPubkeyHex;

    await client.createOrg(
      state.orgId, state.orgName, state.domain,
      leader.xPubkeyHex, encEnvelope, searchEnvelope, modEnvelope,
      { tier: 'starter', monthly_credits: 1000, per_query_cost: 1, currency: 'USD' },
      leader,
    );

    await client.inviteMember(orgId, moderator.pubkeyHex, moderator.xPubkeyHex, 'moderator', encEnvelope, searchEnvelope, modEnvelope, leader);
    await client.inviteMember(orgId, contributor.pubkeyHex, contributor.xPubkeyHex, 'member', encEnvelope, searchEnvelope, modEnvelope, leader);

    const identityRawFromEnv = process.env.WEVIBE_MCP_IDENTITY_JSON;
    let identityRaw = identityRawFromEnv;
    if (!identityRaw) {
      const keystoreDir = process.env.WEVIBE_KEYSTORE_PATH ?? '/tmp/wevibe-mcp-keys';
      const keystoreRaw = readFileSync(`${keystoreDir}/keys.json`, 'utf-8');
      const keystore = JSON.parse(keystoreRaw) as Record<string, Record<string, string>>;
      identityRaw = keystore['wevibe-network']?.['identity-v1'];
    }
    if (!identityRaw) {
      throw new Error('wevibe-mcp identity not found');
    }

    const identity = JSON.parse(identityRaw) as { edPubkeyB64: string; xPubkeyB64: string };
    const mcpPubkeyHex = Buffer.from(identity.edPubkeyB64, 'base64').toString('hex');
    const mcpX25519PubkeyHex = Buffer.from(identity.xPubkeyB64, 'base64').toString('hex');
    await client.inviteMember(orgId, mcpPubkeyHex, mcpX25519PubkeyHex, 'member', encEnvelope, searchEnvelope, modEnvelope, leader);
  });

  it('step 1: submit a memory', async () => {
    plaintextMemory = 'When configuring Nginx as a reverse proxy, always set proxy_set_header X-Real-IP $remote_addr to preserve client IP addresses through the forwarding chain.';

    const modPubkey = moderator.xPub;
    const enc = encryptMemory(plaintextMemory, modPubkey);
    submissionHash = enc.submissionHash;
    queryKeyword = 'nginx';

    const salt = randomBytes(32).toString('hex');
    const plaintextHash = createHash('sha256').update(plaintextMemory, 'utf-8').digest('hex');
    const ciphertextHash = createHash('sha256').update(Buffer.from(enc.ciphertextHex, 'hex')).digest('hex');
    const wrappedDekHash = createHash('sha256').update(Buffer.from(enc.wrappedDekModHex, 'hex')).digest('hex');

    const canonicalMsg = canonical.submitMemoryMessage(
      orgId,
      currentEpoch,
      submissionHash,
      contributor.pubkeyHex,
      memoryType,
      plaintextHash,
      salt,
      ciphertextHash,
      wrappedDekHash,
    );
    const sig = uint8ToHex(signData(contributor, canonicalMsg));

    const r = await client.submitMemory(orgId, {
      org_id: orgId,
      epoch_id: currentEpoch,
      ciphertext: enc.ciphertextHex,
      wrapped_dek_mod: enc.wrappedDekModHex,
      submission_hash: submissionHash,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: sig,
      stack_hint: ['nginx', 'proxy', 'networking'],
      memory_type: memoryType,
      plaintext_hash: plaintextHash,
      salt: salt,
      ciphertext_hash: ciphertextHash,
      wrapped_dek_hash: wrappedDekHash,
    }, contributor);

    expect(r.status).toBe('pending');
    expect(r.submission_hash).toBe(submissionHash);
    saveState(state);
  });

  it('step 2: moderator approves submission', async () => {
    const approveCanonical = canonical.approveSubmissionMessageSimple(
      orgId,
      submissionHash,
      currentEpoch,
      memoryType,
      moderator.pubkeyHex,
    );
    const moderatorSig = uint8ToHex(signData(moderator, approveCanonical));

    const r = await client.approveSubmission(orgId, submissionHash, {
      epoch_id: currentEpoch,
      memory_type: memoryType,
      moderator_sig: moderatorSig,
      signed_by: moderator.pubkeyHex,
    }, moderator);
    expect(r).toBeTruthy();
  });

  it('step 3: leader verifies keywords and submits batch to chain', async () => {
    await client.addKeyword(orgId, queryKeyword, leader);

    const verifyResp = await client.verifyKeywords(orgId, [
      {
        submission_hash: submissionHash,
        classified: [{ keyword: queryKeyword, weight: 1.0 }],
        suggestions: [],
      },
    ], leader);
    expect(verifyResp.results[0]?.error).toBeFalsy();

    const batchResp = await client.batchChainSubmit(orgId, [submissionHash], leader);
    console.log('debug-batchResp', batchResp);
    expect(batchResp.committed_count).toBeGreaterThan(0);
    expect(batchResp.errors?.length ?? 0).toBe(0);
  });

  it('step 4: recall via wevibe-mcp HTTP', async () => {
    const sessionToken = process.env.WEVIBE_MCP_SESSION_TOKEN?.trim() ??
      readFileSync(join(homedir(), '.wevibe', 'mcp-session-token'), 'utf-8').trim();
    const recallUrl = `${CONFIG.wevibeMcpHttpUrl}/v1/recall`;

    let lastStatus = 0;
    let lastRespText = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const resp = await fetch(recallUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ query: queryKeyword, org_id: orgId }),
      });

      lastStatus = resp.status;
      lastRespText = await resp.text();
      if (resp.ok) {
        const data = JSON.parse(lastRespText) as { status: string; memories: Array<{ cid?: string; text?: string; guard?: { passed: boolean; detections?: string[]; flags?: string[] } }> };
        expect(data.memories).toBeTruthy();
        expect(Array.isArray(data.memories)).toBe(true);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect.fail(`Recall failed after retries: ${lastStatus} ${lastRespText}`);
  });
});
