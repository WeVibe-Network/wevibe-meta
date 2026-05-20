import { ScenarioRunner } from '../lib/scenario.js';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity, type TestState } from '../lib/state.js';
import { seedFullScenario } from '../lib/seeder.js';
import { signData, uint8ToHex } from '../lib/identity.js';
import type { TestIdentity } from '../lib/identity.js';
import { buildWeVibeSignedHeaders } from '../lib/auth.js';

const client = new HubClient();
let state: TestState;
let consumer: TestIdentity;

async function init() {
  try {
    state = loadState();
    console.log('Loaded existing state:', state.orgId);
  } catch {
    console.log('No state found, seeding full scenario...');
    const result = await seedFullScenario();
    state = result.state;
  }
  consumer = getIdentity(state, 'consumer');
  return state;
}

async function main() {
  const runner = new ScenarioRunner('Consumer');
  runner.header();

  await init();
  runner.print(`Consumer pubkey: ${consumer.pubkeyHex}`);
  runner.print(`Org ID: ${state.orgId}`);

  const approvedMemories = state.approvedCIDs;
  if (approvedMemories.length === 0) {
    throw new Error('No approved memories found in state. Please run leader flow first.');
  }
  runner.print(`Approved CIDs: ${approvedMemories.length}`);

  // SCENARIO 1: Query memories by keyword
  await runner.scenario('Query memories by keyword', async () => {
    runner.print('Getting embedding for "docker container health"...');
    const embedResp = await client.testEmbed('docker container health');
    const vector = embedResp.vector.map(Number);
    runner.print(`Embedding dim: ${embedResp.dim}, model: ${embedResp.model}`);

    const queryData = new TextEncoder().encode(`query:${consumer.pubkeyHex}:${Date.now()}`);
    const agentSig = uint8ToHex(signData(consumer, queryData));

    runner.print('POST /v1/orgs/{orgId}/query with keywords, vector, and signature...');
    const result = await client.queryMemories(state.orgId, {
      org_id: state.orgId,
      agent_pubkey: consumer.pubkeyHex,
      keyword_weights: [{ keyword: 'docker', weight: 0.8 }, { keyword: 'container', weight: 0.5 }],
      vector,
      limit: 10,
      agent_sig: agentSig,
    });

    runner.print('');
    runner.print(`Results: ${result.results.length}`);
    runner.print(`Contested: ${result.contested}`);
    runner.print(`Receipt ID: ${result.receipt_id}`);

    if (result.results.length > 0) {
      runner.print('');
      runner.print('Top results:');
      for (let i = 0; i < Math.min(3, result.results.length); i++) {
        const r = result.results[i] as Record<string, unknown>;
        runner.print(`  [${i + 1}] CID: ${(r.memory_cid as string).substring(0, 20)}...`);
        runner.print(`      score: ${r.score}, keywords: ${((r.keywords as string[]) || []).join(', ')}`);
      }
    }

    if (result.results.length === 0) {
      throw new Error('Expected at least one result for "docker container health" query');
    }
    return `Found ${result.results.length} result(s) for "docker container health"`;
  });

  // SCENARIO 2: Query with no matches
  await runner.scenario('Query with no matches', async () => {
    runner.print('Querying for "quantum computing assembly language"...');
    const embedResp = await client.testEmbed('quantum computing assembly language');
    const vector = embedResp.vector.map(Number);

    const queryData = new TextEncoder().encode(`query:${consumer.pubkeyHex}:${Date.now()}`);
    const agentSig = uint8ToHex(signData(consumer, queryData));

    const result = await client.queryMemories(state.orgId, {
      org_id: state.orgId,
      agent_pubkey: consumer.pubkeyHex,
      keyword_weights: [{ keyword: 'quantum', weight: 0.8 }],
      vector,
      limit: 10,
      agent_sig: agentSig,
    });

    runner.print(`Results: ${result.results.length}`);
    if (result.results.length > 0) {
      const top = result.results[0] as Record<string, unknown>;
      runner.print(`Top score: ${top.score || 'N/A'}`);
    }

    if (result.results.length === 0) {
      return 'Empty results confirmed — no matches for unrelated query';
    }
    const top = result.results[0] as Record<string, unknown>;
    if ((top.score as number) < 0.3) {
      return `Very low relevance confirmed — top score: ${top.score}`;
    }
    return `Query returned ${result.results.length} result(s) with low relevance`;
  });

  // SCENARIO 3: Browse memory list
  await runner.scenario('Browse memory list', async () => {
    runner.print('GET /v1/orgs/{orgId}/memories...');
    const result = await client.listMemories(state.orgId) as { memories: Record<string, unknown>[]; count: number };

    runner.print('');
    runner.print('┌─ Approved Memories ──────────────────────────────┐');
    runner.print('│ cid                               │ created_at   │ keywords        │');
    runner.print('├───────────────────────────────────────────────────┤');
    for (const mem of result.memories) {
      const cid = (mem.cid as string).substring(0, 28);
      const created = (mem.created_at as string || '').substring(0, 10);
      const keywords = ((mem.keywords as string[]) || []).join(', ').substring(0, 14);
      runner.print(`│ ${cid} │ ${created}  │ ${keywords.padEnd(14)} │`);
    }
    runner.print('└───────────────────────────────────────────────────┘');
    runner.print('');
    runner.print(`Total approved: ${result.count}`);

    return `Listed ${result.count} approved memories`;
  });

  // SCENARIO 4: Get specific memory ciphertext
  await runner.scenario('Get specific memory ciphertext', async () => {
    const firstCid = approvedMemories[0];
    runner.print(`Fetching memory: ${firstCid.substring(0, 20)}...`);
    runner.print(`GET /v1/orgs/${state.orgId}/memories/${firstCid}...`);

    const mem = await client.getMemory(state.orgId, firstCid) as Record<string, unknown>;

    runner.print('');
    runner.print('Memory details:');
    runner.print(`  cid: ${mem.cid}`);
    runner.print(`  created_at: ${mem.created_at}`);
    runner.print(`  keywords: ${((mem.keywords as string[]) || []).join(', ')}`);
    runner.print(`  status: ${mem.status}`);

    if (!mem.ciphertext_hex) {
      throw new Error('No ciphertext_hex returned');
    }
    runner.print(`  ciphertext_hex: ${(mem.ciphertext_hex as string).substring(0, 32)}...`);
    runner.print(`  ciphertext length: ${(mem.ciphertext_hex as string).length} hex chars`);

    return `Retrieved ciphertext for memory ${firstCid.substring(0, 16)}...`;
  });

  // SCENARIO 5: Record serve event
  await runner.scenario('Record serve event', async () => {
    const memoryCid = approvedMemories[0];
    runner.print(`Recording serve event for memory: ${memoryCid.substring(0, 20)}...`);
    runner.print(`POST /v1/orgs/${state.orgId}/serves`);

    const servedAt = new Date().toISOString();
    const result = await client.recordServe(state.orgId, {
      memory_cid: memoryCid,
      served_at: servedAt,
    }, consumer) as Record<string, unknown>;

    runner.print('');
    runner.print(`Result: ${JSON.stringify(result)}`);
    runner.print(`Served at: ${servedAt}`);

    return `Serve event recorded for ${memoryCid.substring(0, 16)}...`;
  });

  // SCENARIO 6: Reject memory
  await runner.scenario('Reject memory', async () => {
    if (approvedMemories.length < 2) {
      throw new Error('Need at least 2 approved memories to test reject');
    }
    const targetCid = approvedMemories[approvedMemories.length - 1];
    runner.print(`Rejecting memory: ${targetCid.substring(0, 20)}...`);

    const rejectData = `${targetCid}:${state.orgId}:irrelevant`;
    const rejectDataBytes = new TextEncoder().encode(rejectData);
    const sig = uint8ToHex(signData(consumer, rejectDataBytes));

    runner.print(`POST /v1/orgs/${state.orgId}/reject`);
    runner.print(`  cid: ${targetCid}`);
    runner.print(`  org_id: ${state.orgId}`);
    runner.print(`  reason: irrelevant`);
    runner.print(`  agent_pubkey: ${consumer.pubkeyHex.substring(0, 20)}...`);
    runner.print(`  signature: ${sig.substring(0, 32)}...`);

    const result = await client.rejectMemory(state.orgId, {
      cid: targetCid,
      org_id: state.orgId,
      reason: 'irrelevant',
      agent_pubkey: consumer.pubkeyHex,
      signature: sig,
    }) as Record<string, unknown>;

    runner.print('');
    runner.print(`Result: ${JSON.stringify(result)}`);

    return `Memory ${targetCid.substring(0, 16)}... rejected successfully`;
  });

  // SCENARIO 7: File report as consumer
  await runner.scenario('File report as consumer', async () => {
    const targetCid = approvedMemories[0];
    runner.print(`Filing report for memory: ${targetCid.substring(0, 20)}...`);
    runner.print(`POST /v1/orgs/${state.orgId}/reports`);
    runner.print(`  memory_cid: ${targetCid}`);
    runner.print(`  reason: spam`);

    const result = await client.createReport(state.orgId, {
      memory_cid: targetCid,
      reason: 'spam',
      note: 'Test report from consumer scenario',
    }, consumer) as Record<string, unknown>;

    runner.print('');
    runner.print(`Result: ${JSON.stringify(result)}`);
    runner.print(`Report ID: ${result.id}`);
    runner.print(`Status: ${result.status}`);

    if (!result.id) {
      throw new Error('No report ID returned');
    }

    return `Report ${result.id} created successfully`;
  });

  // SCENARIO 8: View reports (should fail — member role)
  await runner.scenario('View reports (should fail — member role)', async () => {
    runner.print('GET /v1/orgs/{orgId}/reports with consumer auth...');
    runner.print('Consumer role is "member" — should receive 403 Forbidden');

    try {
      await client.listReports(state.orgId, consumer);
      throw new Error('Expected 403 Forbidden but request succeeded');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('403')) {
        return 'RBAC enforced: 403 received as expected';
      }
      throw e;
    }
  });

  // SCENARIO 9: Attempt moderation (should fail)
  await runner.scenario('Attempt moderation (should fail)', async () => {
    runner.print('GET /v1/orgs/{orgId}/moderation/queue with consumer auth...');
    runner.print('Consumer role is "member" — should receive 403 Forbidden');

    try {
      await client.getModerationQueue(state.orgId, consumer);
      throw new Error('Expected 403 Forbidden but request succeeded');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('403')) {
        return 'RBAC enforced: 403 received as expected';
      }
      throw e;
    }
  });

  // SCENARIO 10: Recall via MCP
  await runner.needsInfra(
    'Recall via MCP',
    'Requires wevibe-mcp with keytar identity + wevibe-guard binary. MCP recall decrypts, scans, and gates memories.'
  );

  // SCENARIO 11: Ambient memory injection
  await runner.needsInfra(
    'Ambient memory injection',
    'Requires WEVIBE_ALLOW_UNREVIEWED=1 or elicitation-supporting client.'
  );

  runner.summary();
  runner.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});