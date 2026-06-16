import { ScenarioRunner } from '../lib/scenario.js';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';
import { signData, uint8ToHex } from '../lib/identity.js';
import { seedFullScenario } from '../lib/seeder.js';
import { hexToUint8 } from '../lib/identity.js';

const client = new HubClient();

let state: ReturnType<typeof loadState>;
let contributor: ReturnType<typeof getIdentity>;
let modPubkey: Uint8Array;

async function init() {
  console.log('Initializing contributor test suite...');

  try {
    state = loadState();
    console.log(`  Loaded existing state for org: ${state.orgId}`);
  } catch {
    console.log('  No existing state found. Seeding full scenario...');
    const result = await seedFullScenario();
    state = result.state;
    console.log(`  Seeded new org: ${state.orgId}`);
  }

  contributor = getIdentity(state, 'contributor');
  modPubkey = hexToUint8(state.pkModHex);

  console.log(`  Contributor pubkey: ${contributor.pubkeyHex.slice(0, 16)}...`);
}

const runner = new ScenarioRunner('Contributor');
await runner.header();
await init();

await runner.scenario('Submit encrypted memory', async () => {
  const plaintext = 'TypeScript generics allow you to write reusable, type-safe code. Use <T> for generic types, extends for constraints, and infer for conditional type extraction. Always prefer generics over any when building library code.';
  const stackHint = ['typescript', 'generics', 'type-safety'];

  runner.print('Encrypting memory with moderator x25519 pubkey...');
  const enc = encryptMemory(plaintext, modPubkey);

  const sig = signSubmission(contributor, enc.submissionHash);

  runner.print(`  Ciphertext: ${enc.ciphertextHex.slice(0, 32)}...`);
  runner.print(`  DEK sealed to moderator pubkey`);
  runner.print(`  Submission hash: ${enc.submissionHash.slice(0, 16)}...`);

  runner.print('Submitting to /v1/orgs/{orgId}/submit...');
  const resp = await client.submitMemory(state.orgId, {
    org_id: state.orgId,
    epoch_id: state.currentEpoch,
    ciphertext: enc.ciphertextHex,
    wrapped_dek_mod: enc.wrappedDekModHex,
    submission_hash: enc.submissionHash,
    contributor_pubkey: contributor.pubkeyHex,
    contributor_sig: sig,
    stack_hint: stackHint,
    memory_type: 'memory',
  }, contributor);

  runner.print(`  Response status: ${resp.status}`);
  runner.print(`  Submission hash: ${resp.submission_hash.slice(0, 16)}...`);

  if (resp.status !== 'pending') {
    throw new Error(`Expected status=pending, got ${resp.status}`);
  }

  runner.print('');
  runner.print('Open localhost:3000/moderation — your submission should appear');

  return `Submitted encrypted memory, status=${resp.status}`;
});

await runner.scenario('Submit memory with different stack hints', async () => {
  const memories = [
    {
      text: 'AWS Lambda cold starts can be reduced by using provisioned concurrency, keeping handler functions lightweight, and avoiding heavy dependencies in the initialization code. Use lambda-powertools for structured logging and tracing.',
      stack: ['aws', 'lambda', 'serverless'],
    },
    {
      text: 'TensorFlow model training: always use tf.data.Dataset for efficient data pipeline. Use mixed precision training (float16) on V100/A100 GPUs for 2-3x speedup. Implement early stopping with patience=3 to prevent overfitting.',
      stack: ['tensorflow', 'ml', 'training'],
    },
    {
      text: 'React hooks best practices: use useCallback for functions passed to child components, useMemo for expensive computations, and always list all dependencies in useEffect. Custom hooks should start with "use" prefix and handle cleanup.',
      stack: ['react', 'hooks', 'frontend'],
    },
  ];

  runner.print(`Submitting ${memories.length} memories with different topics...`);
  const hashes: string[] = [];

  for (const mem of memories) {
    const enc = encryptMemory(mem.text, modPubkey);
    const sig = signSubmission(contributor, enc.submissionHash);

    const resp = await client.submitMemory(state.orgId, {
      org_id: state.orgId,
      epoch_id: state.currentEpoch,
      ciphertext: enc.ciphertextHex,
      wrapped_dek_mod: enc.wrappedDekModHex,
      submission_hash: enc.submissionHash,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: sig,
      stack_hint: mem.stack,
      memory_type: 'memory',
    }, contributor);

    hashes.push(resp.submission_hash);
    runner.print(`  Submitted: ${mem.stack.join(', ')} → ${resp.status}`);
  }

  runner.print('');
  runner.print('Checking queue via client.testGetQueue...');
  const queue = await client.testGetQueue(state.orgId);
  runner.print(`  Queue length: ${queue.length}`);
  runner.print(`  Recent submissions: ${hashes.slice(0, 3).map(h => h.slice(0, 12) + '...').join(', ')}`);

  return `Submitted ${memories.length} memories, queue has ${queue.length} items`;
});

await runner.scenario('Submit memory during rotation (edge case)', async () => {
  runner.print('Checking rotation status via GET /v1/orgs/{orgId}...');
  const orgDetails = await client.getOrg(state.orgId) as Record<string, unknown>;
  const rotationPending = orgDetails['rotation_pending'] as boolean | undefined;

  runner.print(`  rotation_pending: ${rotationPending}`);

  if (!rotationPending) {
    runner.print('');
    runner.print('No rotation in progress — skipping edge case test');
    return 'Skipped: no rotation pending';
  }

  runner.print('Rotation is pending — submitting memory...');
  const plaintext = 'Memory submitted during epoch rotation. Should be buffered until rotation completes.';
  const enc = encryptMemory(plaintext, modPubkey);
  const sig = signSubmission(contributor, enc.submissionHash);

  try {
    const resp = await client.submitMemory(state.orgId, {
      org_id: state.orgId,
      epoch_id: state.currentEpoch + 1,
      ciphertext: enc.ciphertextHex,
      wrapped_dek_mod: enc.wrappedDekModHex,
      submission_hash: enc.submissionHash,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: sig,
      stack_hint: ['rotation', 'edge-case'],
      memory_type: 'memory',
    }, contributor);

    runner.print(`  Response status: ${resp.status}`);
    return `Submitted during rotation, status=${resp.status}`;
  } catch (e) {
    runner.print(`  Expected failure during rotation: ${e instanceof Error ? e.message : String(e)}`);
    return 'Handled rotation edge case';
  }
});

await runner.scenario('File a report', async () => {
  runner.print('Fetching approved memories to get a memory_cid...');
  const approvedMemories = state.submissions.filter(s => s.status === 'approved');

  if (approvedMemories.length === 0) {
    throw new Error('No approved memories found. Run seeder or complete scenario 1 first.');
  }

  const memoryCid = approvedMemories[0].approvedCid!;
  runner.print(`  Using memory_cid: ${memoryCid.slice(0, 16)}...`);

  runner.print('Filing report via POST /v1/orgs/{orgId}/reports...');
  const resp = await client.createReport(state.orgId, {
    memory_cid: memoryCid,
    reason: 'outdated',
    note: 'This memory information is no longer current and should be reviewed.',
  }, contributor);

  runner.print(`  Report created with id: ${resp['id']}`);

  runner.print('');
  runner.print('Open localhost:3000/reports — your report should appear');

  return `Report filed for memory ${memoryCid.slice(0, 12)}...`;
});

await runner.scenario('View own org membership', async () => {
  runner.print('Fetching orgs for contributor pubkey via GET /v1/members/{pubkey}/orgs...');
  const headers = {
    'x-pubkey': contributor.pubkeyHex,
    'x-signature': uint8ToHex(signData(contributor, new TextEncoder().encode(contributor.pubkeyHex))),
  };

  const url = `/v1/members/${contributor.pubkeyHex}/orgs`;
  const resp = await fetch(`${client['baseUrl']}${url}`, { headers }) as { json: () => Promise<{ orgs: Array<Record<string, unknown>> }> };
  const data = await resp.json();
  const orgs = data.orgs || [];

  runner.print(`  Member belongs to ${orgs.length} org(s)`);

  for (const org of orgs) {
    runner.print(`    - ${org['org_id']} (role: ${org['role']})`);
  }

  const found = orgs.some(o => o['org_id'] === state.orgId);
  if (!found) {
    throw new Error(`Org ${state.orgId} not found in member's org list`);
  }

  return `Verified membership in org ${state.orgId}`;
});

await runner.scenario('Check org credits', async () => {
  runner.print('Fetching credits via GET /v1/orgs/{orgId}/credits...');
  const credits = await client.getCredits(state.orgId) as Record<string, unknown>;

  runner.print(`  Balance: ${credits['balance']}`);
  runner.print(`  Currency: ${credits['currency']}`);
  runner.print(`  Tier: ${credits['tier']}`);

  return `Org has ${credits['balance']} ${credits['currency']} credits`;
});

await runner.needsInfra(
  'Extract memories from session via dashboard',
  'Sessions page reads from local SQLite at ~/.local/share/opencode/opencode.db. Test would need synthetic session data injected into the DB. Extraction calls /api/extract which runs local LLM (Ollama).'
);

await runner.needsInfra(
  'Submit via MCP contribute tool',
  'Requires wevibe-mcp running with keytar identity. MCP contribute tool handles encryption internally.'
);

runner.summary();
runner.close();
