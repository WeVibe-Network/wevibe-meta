import { HubClient } from './hub-client.js';
import { generateFreshState, saveState, getIdentity } from './state.js';
import { encryptMemory, signSubmission } from './crypto.js';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';
import { uint8ToHex } from './identity.js';
import { EMBEDDING_MODEL_ID } from './config.js';
import { createHash } from 'node:crypto';

const MEMORIES = [
  { text: 'Docker container health checks using curl and the /health endpoint. Always set restart=always in docker-compose for critical services, and use docker system prune -a --volumes sparingly to reclaim disk space after image updates.', topic: 'docker', stack: ['docker', 'devops', 'containers'] },
  { text: 'Nginx reverse proxy configuration for Node.js apps: use upstream block with keepalive 64, proxy_pass to http://upstream, and include standard proxy_headers for host, x-real-ip, x-forwarded-proto. TLS termination at nginx level with certbot ACME.', topic: 'nginx', stack: ['nginx', 'networking', 'proxy'] },
  { text: 'PostgreSQL connection pooling with pgbouncer in transaction mode. Set max_client_conn=1000, default_pool_size=20, and use query wait timeout of 30s. For Django use pool_mode=transaction with server_reset_query=DEALLOCATE.', topic: 'postgres', stack: ['postgres', 'performance', 'database'] },
  { text: 'Redis session failover patterns: use Sentinel for automatic failover between master and replicas. Configure sentinel monitor with quorum=2. Application should implement retry logic with exponential backoff when connecting to new master after failover.', topic: 'redis', stack: ['redis', 'reliability', 'caching'] },
  { text: 'Kubernetes liveness vs readiness probes: livenessProbe restarts container, readinessProbe removes from service endpoints. Use exec/TCPSocket/HTTPGet with initialDelaySeconds=30, periodSeconds=10, failureThreshold=3. Startup probe for slow-start apps.', topic: 'k8s', stack: ['k8s', 'orchestration', 'kubernetes'] },
];

export interface SeederResult {
  state: ReturnType<typeof generateFreshState>;
  queueCount: number;
  approvedCount: number;
}

export async function seedFullScenario(): Promise<SeederResult> {
  const client = new HubClient();
  const state = generateFreshState();
  const leader = getIdentity(state, 'leader');
  const moderator = getIdentity(state, 'moderator');
  const contributor = getIdentity(state, 'contributor');
  const consumer = getIdentity(state, 'consumer');

  console.log('Seeding full scenario...');

  await client.testReset();
  console.log('  DB reset');

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
  console.log(`  Org created: ${state.orgId}`);

  await client.inviteMember(state.orgId, moderator.pubkeyHex, moderator.xPubkeyHex, 'moderator', encEnvelope, searchEnvelope, modEnvelope, leader);
  await client.inviteMember(state.orgId, contributor.pubkeyHex, contributor.xPubkeyHex, 'member', encEnvelope, searchEnvelope, modEnvelope, leader);
  await client.inviteMember(state.orgId, consumer.pubkeyHex, consumer.xPubkeyHex, 'member', encEnvelope, searchEnvelope, modEnvelope, leader);
  console.log('  Members invited');

  const submissions: Array<{ enc: ReturnType<typeof encryptMemory>; plaintext: string; topic: string }> = [];
  for (const mem of MEMORIES) {
    const enc = encryptMemory(mem.text, modPubkey);
    submissions.push({ enc, plaintext: mem.text, topic: mem.topic });
    state.submissions.push({
      hash: enc.submissionHash,
      plaintext: mem.text,
      ciphertextHex: enc.ciphertextHex,
      wrappedDekModHex: enc.wrappedDekModHex,
      dek: uint8ToHex(enc.dek),
      stackHint: mem.stack,
      status: 'pending',
    });
  }

  for (const sub of submissions) {
    const mem = MEMORIES.find(m => m.topic === sub.topic)!;
    const sig = signSubmission(contributor, sub.enc.submissionHash);
    await client.submitMemory(state.orgId, {
      org_id: state.orgId,
      epoch_id: 1,
      ciphertext: sub.enc.ciphertextHex,
      wrapped_dek_mod: sub.enc.wrappedDekModHex,
      submission_hash: sub.enc.submissionHash,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: sig,
      stack_hint: mem.stack,
      memory_type: 'memory',
    }, contributor);
  }
  console.log(`  Submitted ${submissions.length} memories`);

  const toApprove = submissions.slice(0, 3);
  const toDeny = submissions.slice(3, 5);

  for (const sub of toApprove) {
    const approvedCid = createHash('sha256').update(sub.plaintext.substring(0, 50)).digest('hex');
    const embedResp = await client.testEmbed(sub.topic);
    const vector = embedResp.vector.map(Number);
    const sig = signSubmission(moderator, sub.enc.submissionHash);
    await client.approveSubmission(state.orgId, sub.enc.submissionHash, {
      epoch_id: 1,
      approved_cid: approvedCid,
      wrapped_dek_enc: '',
      keywords: sub.topic.split(' ').map(k => ({ keyword: k, weight: 0.8 })),
      keyword_weights: { [sub.topic]: 0.8 },
      vector,
      embedding_model_id: EMBEDDING_MODEL_ID,
      moderator_sig: sig,
      signed_by: moderator.pubkeyHex,
    }, moderator);
    const idx = state.submissions.findIndex(s => s.hash === sub.enc.submissionHash);
    if (idx !== -1) {
      state.submissions[idx].status = 'approved';
      state.submissions[idx].approvedCid = approvedCid;
    }
    state.approvedCIDs.push(approvedCid);
  }
  console.log(`  Approved ${toApprove.length} memories`);

  for (const sub of toDeny) {
    await client.denySubmission(state.orgId, sub.enc.submissionHash, 'off-topic or low-quality content', moderator);
    const idx = state.submissions.findIndex(s => s.hash === sub.enc.submissionHash);
    if (idx !== -1) state.submissions[idx].status = 'denied';
  }
  console.log(`  Denied ${toDeny.length} memories`);

  const memoryCids = state.approvedCIDs.slice(0, 2);
  const reportReasons = ['outdated', 'incorrect'];
  for (let i = 0; i < 2; i++) {
    await client.createReport(state.orgId, {
      memory_cid: memoryCids[i],
      reason: reportReasons[i],
      note: `Test report ${i + 1}`,
    }, consumer);
  }
  const reportsResp = await client.listReports(state.orgId, consumer);
  const reports = (reportsResp as Record<string, unknown>).reports as Array<Record<string, unknown>>;
  state.reports = reports.slice(-2).map(r => ({
    id: r.id as string,
    memoryCid: r.memory_cid as string,
    reason: r.reason as string,
    status: r.status as string,
  }));
  console.log('  Created 2 reports');

  const fakeCid = state.approvedCIDs[0];
  await client.recordServe(state.orgId, { memory_cid: fakeCid, served_at: new Date().toISOString() }, consumer);
  await client.recordServe(state.orgId, { memory_cid: fakeCid, served_at: new Date().toISOString() }, consumer);
  console.log('  Recorded 2 serve events');

  await client.registerDashboardKey(state.orgId, {
    pubkey: leader.pubkeyHex,
    label: 'test-dashboard-key',
  }, leader);

  saveState(state);

  try {
    const { seedDashboardEnv } = await import('./seed-dashboard-env.js');
    seedDashboardEnv();
  } catch {
    console.log('  Note: Could not seed dashboard .env.local (dashboard may not be set up)');
  }

  console.log(`\nSeeding complete. State saved.`);
  console.log(`  Org ID: ${state.orgId}`);
  console.log(`  Queue: ${toDeny.length} pending`);
  console.log(`  Approved: ${toApprove.length}`);
  console.log(`  Reports: 2`);

  return { state, queueCount: toDeny.length, approvedCount: toApprove.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedFullScenario().catch(console.error);
}
