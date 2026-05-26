import { beforeAll, describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generate_dek, seal_to_pubkey, sign } from 'wevibe-sdk-wasm';
import { HubClient } from '../lib/hub-client.js';
import { buildWeVibeSignedHeaders } from '../lib/auth.js';
import { CONFIG } from '../lib/config.js';
import { uint8ToHex, type TestIdentity } from '../lib/identity.js';
import { generateFreshState, getIdentity } from '../lib/state.js';
import { encryptMemory } from '../lib/crypto.js';
import * as canonical from '../lib/canonical.js';

// CO-023: full denial-loop end-to-end smoke test.
//
// Two flows, both end-to-end against the real dogfood stack:
//   Flow 1 (Task A) — Moderation happy path. A memory progresses
//     pending → pending_keyword → pending_chain via leader override,
//     keyword results, verify-keywords, and batch-submit. The test then
//     waits for the real chain watcher to move the submission to
//     `committed` (no test-mode commit bypass), recalls the memory, and
//     captures the post-decay ranking score
//     (Breakdown.CombinedScore) as `baselineScore`.
//
//   Flow 2 (Task B) — Consumer denial feedback loop. Two distinct
//     consumer denials (different nullifiers, same memory) are recorded.
//     After each, recall is re-run and the post-denial CombinedScore is
//     compared to baselineScore. Each denial must reduce the score by
//     exactly DenialDecayBPS / 10000 = 0.05 (within float epsilon).

const DENIAL_DROP_PER_DENIAL = 0.05;
const SCORE_EPSILON = 1e-9; // float-precision epsilon; per-denial drop is exact 0.05.

// Module-level HubClient: used both by helper functions and within the
// describe block. Constructor reads CONFIG.hubUrl at instantiation, which
// happens once when this module loads.
const hub = new HubClient();

interface QueryScoringBreakdown {
  keyword_score?: number;
  vector_score?: number;
  gamma?: number;
  delta?: number;
  capped_boost?: number;
  combined_score: number;
}

interface QueryMemoryResult {
  cid: string;
  org_id?: string;
  epoch_id?: number;
  memory_type?: string;
  scoring_breakdown?: QueryScoringBreakdown;
  keywords?: Array<{ keyword: string; weight: number }>;
}

interface QueryResponse {
  results: QueryMemoryResult[];
  contested: boolean;
  receipt_id: string;
}

interface PendingCountResponse {
  pending_count: number;
}

interface SubmissionsListResponse {
  submissions: Array<{ submission_hash: string; status: string }> | null;
  total: number;
}

interface DenialRecordedResponse {
  status: string;
  nullifier?: string;
}

function randomHex32(): string {
  return randomBytes(32).toString('hex');
}

function fail(step: string, detail: string): never {
  throw new Error(`[CO-023 ${step}] ${detail}`);
}

async function readBody(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '<unreadable body>';
  }
}

async function parseJSON<T>(step: string, response: Response): Promise<T> {
  const body = await readBody(response);
  try {
    return JSON.parse(body) as T;
  } catch {
    fail(step, `expected JSON response; got: ${body}`);
  }
}

async function postJSON(
  step: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  acceptStatuses: number[] = [200, 201],
): Promise<{ resp: Response; bodyText: string }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bodyText = await readBody(resp);
  if (!acceptStatuses.includes(resp.status)) {
    fail(step, `HTTP ${resp.status} on ${url} → ${bodyText}`);
  }
  return { resp, bodyText };
}

async function getJSON(
  step: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ resp: Response; bodyText: string }> {
  const resp = await fetch(url, { method: 'GET', headers });
  const bodyText = await readBody(resp);
  if (!resp.ok) {
    fail(step, `HTTP ${resp.status} on ${url} → ${bodyText}`);
  }
  return { resp, bodyText };
}

async function recall(
  orgID: string,
  keyword: string,
  consumer: TestIdentity,
): Promise<QueryResponse> {
  const headers = buildWeVibeSignedHeaders(consumer);
  // Qdrant requires a non-empty vector of the indexed dimension (nomic-embed-text:
  // 768d). The dogfood production path computes this client-side via MCP; for the
  // smoke test we use the WEVIBE_TEST_MODE /v1/test/embed endpoint which calls the
  // same embed package the chain watcher would use.
  const vec = await hub.testEmbed(keyword);
  const { bodyText } = await postJSON(
    'recall',
    `${CONFIG.hubUrl}/v1/orgs/${orgID}/query`,
    headers,
    {
      org_id: orgID,
      agent_pubkey: consumer.pubkeyHex,
      pre_pubkey: consumer.xPubkeyHex,
      keyword_weights: [{ keyword, weight: 1.0 }],
      vector: vec.vector,
      limit: 10,
      agent_sig: '',
    },
  );
  return JSON.parse(bodyText) as QueryResponse;
}

async function recordDenial(
  orgID: string,
  memoryHash: string,
  nullifier: string,
  reason: string,
  consumer: TestIdentity,
): Promise<DenialRecordedResponse> {
  const headers = buildWeVibeSignedHeaders(consumer);
  const { bodyText } = await postJSON(
    'recordDenial',
    `${CONFIG.hubUrl}/v1/orgs/${orgID}/denials`,
    headers,
    { memory_hash: memoryHash, nullifier, reason },
  );
  return JSON.parse(bodyText) as DenialRecordedResponse;
}

async function pendingDenialCount(
  orgID: string,
  reader: TestIdentity,
): Promise<number> {
  const headers = buildWeVibeSignedHeaders(reader);
  const { bodyText } = await getJSON(
    'pendingDenialCount',
    `${CONFIG.hubUrl}/v1/orgs/${orgID}/denials/pending-count`,
    headers,
  );
  const parsed = JSON.parse(bodyText) as PendingCountResponse;
  if (typeof parsed.pending_count !== 'number') {
    fail('pendingDenialCount', `expected pending_count to be a number; got ${bodyText}`);
  }
  return parsed.pending_count;
}

async function fetchSubmissionStatus(
  orgID: string,
  submissionHash: string,
  leader: TestIdentity,
): Promise<string | null> {
  // /moderation/queue is hardcoded to status='pending' rows only, so it is
  // useless once a row advances. /submissions (leader-only) returns rows in
  // all statuses including committed, which is what this test needs.
  const headers = buildWeVibeSignedHeaders(leader);
  const { bodyText } = await getJSON(
    'fetchSubmissionStatus',
    `${CONFIG.hubUrl}/v1/orgs/${orgID}/submissions`,
    headers,
  );
  const list = JSON.parse(bodyText) as SubmissionsListResponse;
  const submissions = list.submissions ?? [];
  const row = submissions.find(r => r.submission_hash === submissionHash);
  return row ? row.status : null;
}

async function waitForSubmissionStatus(
  orgID: string,
  submissionHash: string,
  leader: TestIdentity,
  targetStatus: string,
  timeoutMs = 30_000,
  pollMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | null = null;

  while (Date.now() < deadline) {
    lastStatus = await fetchSubmissionStatus(orgID, submissionHash, leader);
    if (lastStatus === targetStatus) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  fail(
    'waitForSubmissionStatus',
    `timed out after ${timeoutMs}ms waiting for ${targetStatus}; last_status=${String(lastStatus)}`,
  );
}

function findMemoryByCID(results: QueryMemoryResult[], cid: string): QueryMemoryResult | undefined {
  return results.find(r => r.cid.toLowerCase() === cid.toLowerCase());
}

describe('CO-023: full denial-loop end-to-end smoke test', () => {
  const client = hub;

  let orgID = '';
  let leader: TestIdentity;
  let consumer: TestIdentity;

  const EPOCH_ID = 0;
  const QUERY_KEYWORD = 'nginx';
  const MEMORY_TYPE = 'correct_implementation';

  let submissionHash = '';
  let baselineScore = 0;

  beforeAll(async () => {
    // R-DOGFOOD-REAL-STACK: hub MUST be running and healthy.
    try {
      const health = await client.health();
      if (health.status !== 'ok' || health.db !== 'connected') {
        fail('preflight.health', `hub /health returned ${JSON.stringify(health)}`);
      }
    } catch (e) {
      fail(
        'preflight.health',
        `cannot reach hub at ${CONFIG.hubUrl}. Bring up the dogfood stack: \`make -C wevibe-meta docker-up\`. cause=${String(e)}`,
      );
    }

    let stackHealth: Awaited<ReturnType<HubClient['testHealth']>>;
    try {
      stackHealth = await client.testHealth();
    } catch (e) {
      fail(
        'preflight.testHealth',
        `cannot reach /v1/test/health. The stack must be in test mode (WEVIBE_TEST_MODE=true). cause=${String(e)}`,
      );
    }
    if (stackHealth.qdrant !== 'connected') {
      fail('preflight.qdrant', `qdrant not connected: ${JSON.stringify(stackHealth)}`);
    }
    if (stackHealth.chain !== 'connected') {
      fail('preflight.chain', `chain not connected: ${JSON.stringify(stackHealth)}`);
    }

    const state = generateFreshState();
    leader = getIdentity(state, 'leader');
    consumer = getIdentity(state, 'consumer');
    orgID = state.orgId;

    const modPubkey = leader.xPub;
    const encEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const searchEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
    const modEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));

    await client.createOrg(
      state.orgId,
      state.orgName,
      state.domain,
      leader.xPubkeyHex,
      encEnvelope,
      searchEnvelope,
      modEnvelope,
      { tier: 'starter', monthly_credits: 1000, per_query_cost: 1, currency: 'USD' },
      leader,
    );

    await client.inviteMember(
      orgID,
      consumer.pubkeyHex,
      consumer.xPubkeyHex,
      'member',
      encEnvelope,
      searchEnvelope,
      modEnvelope,
      leader,
    );
  }, 120_000);

  describe('Task A — memory lifecycle: pending → committed', () => {
    it('Step 1: submit memory → pending', async () => {
      const plaintext =
        'When configuring Nginx as a reverse proxy, always set proxy_set_header X-Real-IP $remote_addr to preserve client IP addresses through the forwarding chain.';
      const enc = encryptMemory(plaintext, leader.xPub);
      submissionHash = enc.submissionHash;

      const canonicalMsg = canonical.submitMemoryMessage(
        orgID,
        EPOCH_ID,
        submissionHash,
        consumer.pubkeyHex,
        MEMORY_TYPE,
      );
      const sig = uint8ToHex(sign(consumer.edPriv, canonicalMsg));

      const r = await client.submitMemory(
        orgID,
        {
          org_id: orgID,
          epoch_id: EPOCH_ID,
          ciphertext: enc.ciphertextHex,
          wrapped_dek_mod: enc.wrappedDekModHex,
          submission_hash: submissionHash,
          contributor_pubkey: consumer.pubkeyHex,
          contributor_sig: sig,
          // Keep stack_hint to a single keyword that we register in
          // org_keywords below. memory_keywords has an FK on org_keywords,
          // so this keeps chain-watcher bookkeeping clean.
          stack_hint: [QUERY_KEYWORD],
          memory_type: MEMORY_TYPE,
        },
        consumer,
      );
      expect(r.submission_hash).toBe(submissionHash);
      expect(r.status).toBe('pending');
    });

    it('Step 2: leader vote → pending_keyword (override)', async () => {
      const r = (await client.voteOnSubmission(orgID, submissionHash, leader)) as {
        status?: string;
        ready?: boolean;
      };
      // moderation.CastApprovalVote for role=leader sets status=pending_keyword and ready=true.
      expect(r.ready).toBe(true);
      expect(r.status).toBe('pending_keyword');
    });

    it('Step 3: register keyword in org_keywords (required by verify-keywords)', async () => {
      await client.addKeyword(orgID, QUERY_KEYWORD, leader);
    });

    it('Step 4: submit-keyword-results (store extraction_result)', async () => {
      const headers = buildWeVibeSignedHeaders(leader);
      const { bodyText } = await postJSON(
        'submitKeywordResults',
        `${CONFIG.hubUrl}/v1/orgs/${orgID}/submit-keyword-results`,
        headers,
        {
          memories: [
            {
              submission_hash: submissionHash,
              classified: [{ keyword: QUERY_KEYWORD, weight: 1.0 }],
              suggestions: [],
            },
          ],
        },
      );
      const data = JSON.parse(bodyText) as { results: Array<{ error?: string }> };
      if (data.results[0]?.error) {
        fail('submitKeywordResults', `error: ${data.results[0].error}`);
      }
    });

    it('Step 5: verify-keywords → pending_chain', async () => {
      const verifyResp = await client.verifyKeywords(
        orgID,
        [
          {
            submission_hash: submissionHash,
            classified: [{ keyword: QUERY_KEYWORD, weight: 1.0 }],
            suggestions: [],
          },
        ],
        leader,
      );
      if (verifyResp.results[0]?.error) {
        fail('verifyKeywords', `error: ${verifyResp.results[0].error}`);
      }
      const status = await fetchSubmissionStatus(orgID, submissionHash, leader);
      expect(status).toBe('pending_chain');
    });

    it('Step 6: batch-submit to chain → tx sent', async () => {
      const headers = buildWeVibeSignedHeaders(leader);
      const { bodyText } = await postJSON(
        'batchSubmit',
        `${CONFIG.hubUrl}/v1/orgs/${orgID}/moderation/batch-submit`,
        headers,
        {},
      );
      const data = JSON.parse(bodyText) as {
        submitted: number;
        failed: number;
        results: Array<{ submission_hash: string; tx_hash?: string; error?: string }> | null;
      };
      const resultsArr = data.results ?? [];
      if (resultsArr.length === 0) {
        fail('batchSubmit', `handler returned 0 results despite our row being pending_chain. body=${bodyText}`);
      }
      const row = resultsArr.find(r => r.submission_hash === submissionHash);
      if (!row) {
        fail('batchSubmit', `no result for our hash; full response=${bodyText}`);
      }
      if (row.error) {
        fail('batchSubmit', `chain submit errored: ${row.error}. full response=${bodyText}`);
      }
      expect(data.submitted).toBeGreaterThanOrEqual(1);
      expect(row.tx_hash).toBeTruthy();
    });

    it('Step 7: wait for chain watcher confirmation → committed', async () => {
      await waitForSubmissionStatus(orgID, submissionHash, leader, 'committed', 30_000, 1_000);
      expect(await fetchSubmissionStatus(orgID, submissionHash, leader)).toBe('committed');
    });

    it('Step 8: baseline recall → memory present, capture baseline score', async () => {
      // Allow the watcher a moment to push the Qdrant payload + memory_keywords
      // rows before the first recall; these writes are separate statements.
      await new Promise(r => setTimeout(r, 1_500));

      const data = await recall(orgID, QUERY_KEYWORD, consumer);
      const match = findMemoryByCID(data.results, submissionHash);
      if (!match) {
        fail(
          'baselineRecall',
          `committed memory not returned by recall; results=${JSON.stringify(data.results.map(r => r.cid))}`,
        );
      }
      const score = match.scoring_breakdown?.combined_score;
      if (typeof score !== 'number') {
        fail(
          'baselineRecall',
          `recall result missing scoring_breakdown.combined_score; entry=${JSON.stringify(match)}`,
        );
      }
      expect(score).toBeGreaterThan(0);
      baselineScore = score;
      console.info(`[CO-023] baselineScore=${baselineScore}`);
    });
  });

  describe('Task B — consumer denial loop: deny → score drop', () => {
    it('Step 9: record denial #1 (status=recorded)', async () => {
      const data = await recordDenial(
        orgID,
        submissionHash,
        randomHex32(),
        'CO-021-smoke-denial-1',
        consumer,
      );
      expect(data.status).toBe('recorded');
    });

    it('Step 10: recall after 1 denial → score dropped by exactly 0.05', async () => {
      const data = await recall(orgID, QUERY_KEYWORD, consumer);
      const match = findMemoryByCID(data.results, submissionHash);
      if (!match) {
        fail('postDenial1Recall', `memory disappeared from recall; results=${JSON.stringify(data.results)}`);
      }
      const score = match.scoring_breakdown?.combined_score;
      if (typeof score !== 'number') {
        fail('postDenial1Recall', `missing scoring_breakdown.combined_score; entry=${JSON.stringify(match)}`);
      }
      console.info(`[CO-023] postDenial1Score=${score}; drop=${baselineScore - score}`);
      expect(score).toBeLessThan(baselineScore);
      expect(Math.abs(baselineScore - score - DENIAL_DROP_PER_DENIAL)).toBeLessThan(SCORE_EPSILON);
    });

    it('Step 11: pending denial count ≥ 1', async () => {
      const count = await pendingDenialCount(orgID, leader);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('Step 12: record denial #2 with a fresh nullifier (status=recorded)', async () => {
      const data = await recordDenial(
        orgID,
        submissionHash,
        randomHex32(),
        'CO-021-smoke-denial-2',
        consumer,
      );
      expect(data.status).toBe('recorded');
    });

    it('Step 13: recall after 2 denials → cumulative drop ≈ 0.10', async () => {
      const data = await recall(orgID, QUERY_KEYWORD, consumer);
      const match = findMemoryByCID(data.results, submissionHash);
      if (!match) {
        fail('postDenial2Recall', `memory disappeared from recall; results=${JSON.stringify(data.results)}`);
      }
      const score = match.scoring_breakdown?.combined_score;
      if (typeof score !== 'number') {
        fail('postDenial2Recall', `missing scoring_breakdown.combined_score; entry=${JSON.stringify(match)}`);
      }
      const cumulativeDrop = baselineScore - score;
      console.info(`[CO-023] postDenial2Score=${score}; cumulativeDrop=${cumulativeDrop}`);
      expect(score).toBeLessThan(baselineScore);
      expect(Math.abs(cumulativeDrop - 2 * DENIAL_DROP_PER_DENIAL)).toBeLessThan(SCORE_EPSILON);
    });

    it('Step 14: pending denial count ≥ 2', async () => {
      const count = await pendingDenialCount(orgID, leader);
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });
});
