import { ScenarioRunner } from '../lib/scenario.js';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity, updateState, type SubmissionRecord, type ReportRecord } from '../lib/state.js';
import { signData, uint8ToHex, type TestIdentity } from '../lib/identity.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';
import { approveSubmissionMessage, denySubmissionMessage, type KeywordWithWeight } from '../lib/canonical.js';
import { buildWeVibeSignedHeaders, buildBodySignedPayload } from '../lib/auth.js';
import { seedFullScenario } from '../lib/seeder.js';
import { createHash } from 'node:crypto';

async function main() {
  let state: ReturnType<typeof loadState> extends Promise<infer T> ? T : ReturnType<typeof loadState>;

  try {
    state = loadState();
  } catch {
    console.log('No test state found. Running seeder...');
    const result = await seedFullScenario();
    state = result.state;
  }

  state = loadState();
  const moderatorIdentity = getIdentity(state, 'moderator') as TestIdentity;
  const client = new HubClient();

  const runner = new ScenarioRunner('Moderator');
  runner.header();

  const orgId = state.orgId;

  await runner.scenario('View moderation queue via API', async () => {
    const queue = await client.getModerationQueue(orgId, moderatorIdentity);
    runner.print(`Queue contains ${queue.length} submission(s)`);

    if (queue.length === 0) {
      runner.print('Queue is empty — all submissions were approved during seeding');
      return 'Queue empty (all approved)';
    }

    for (const item of queue) {
      const hash = item.submission_hash ?? item.hash ?? '(unknown)';
      const ciphertext = item.ciphertext_hex ?? item.ciphertextHex ?? '(unknown)';
      const stackHint = (item.stack_hint ?? item.stackHint ?? []) as string[];
      runner.print(`  hash=${hash}`);
      runner.print(`  ciphertext_hex=${String(ciphertext).substring(0, 40)}...`);
      runner.print(`  stack_hint=[${stackHint.join(', ')}]`);
    }

    return `Queue shows ${queue.length} pending submission(s)`;
  });

  await runner.scenario('Approve submission with full crypto', async () => {
    const pending = state.submissions.filter(s => s.status === 'pending');
    if (pending.length === 0) {
      return 'No pending submissions to approve';
    }

    const sub = pending[0];
    const embedResp = await client.testEmbed(sub.stackHint[0] ?? 'topic');
    const vector = embedResp.vector.map(Number);

    const approvedCid = createHash('sha256').update(sub.plaintext.substring(0, 50)).digest('hex');
    const keywords: KeywordWithWeight[] = sub.stackHint.map(k => ({ keyword: k, weight: 0.8 }));

    const canonicalMsg = approveSubmissionMessage(
      orgId,
      sub.hash,
      state.currentEpoch,
      approvedCid,
      sub.wrappedDekModHex,
      moderatorIdentity.pubkeyHex,
      keywords,
    );

    const sig = signData(moderatorIdentity, canonicalMsg);
    const signature = uint8ToHex(sig);

    const result = await client.approveSubmission(orgId, sub.hash, {
      epoch_id: state.currentEpoch,
      approved_cid: approvedCid,
      wrapped_dek_enc: sub.wrappedDekModHex,
      keywords,
      keyword_weights: Object.fromEntries(keywords.map(k => [k.keyword, k.weight])),
      vector,
      embedding_model_id: 'nomic-embed-text',
      moderator_sig: signature,
      signed_by: moderatorIdentity.pubkeyHex,
    }, moderatorIdentity);

    const idx = state.submissions.findIndex(s => s.hash === sub.hash);
    if (idx !== -1) {
      state.submissions[idx].status = 'approved';
      state.submissions[idx].approvedCid = approvedCid;
    }
    state.approvedCIDs.push(approvedCid);
    updateState({ submissions: state.submissions, approvedCIDs: state.approvedCIDs });

    const status = (result as Record<string, unknown>).status ?? (result as Record<string, unknown>).moderation_status;
    runner.print(`Approved: ${sub.hash}`);
    runner.print(`Approved CID: ${approvedCid}`);
    runner.print(`Status in response: ${status}`);

    return `Submission ${sub.hash.substring(0, 16)}... approved with CID ${approvedCid.substring(0, 16)}...`;
  });

  await runner.scenario('Deny submission with reason', async () => {
    const pending = state.submissions.filter(s => s.status === 'pending');
    if (pending.length === 0) {
      return 'No pending submissions to deny';
    }

    const sub = pending[0];
    const reason = 'off-topic or low-quality content';

    const result = await client.denySubmission(orgId, sub.hash, reason, moderatorIdentity);

    const idx = state.submissions.findIndex(s => s.hash === sub.hash);
    if (idx !== -1) {
      state.submissions[idx].status = 'denied';
    }
    updateState({ submissions: state.submissions });

    const status = (result as Record<string, unknown>).status ?? (result as Record<string, unknown>).moderation_status;
    runner.print(`Denied: ${sub.hash}`);
    runner.print(`Reason: ${reason}`);
    runner.print(`Status in response: ${status}`);

    return `Submission ${sub.hash.substring(0, 16)}... denied with reason: ${reason}`;
  });

  await runner.scenario('Vote on submission (quorum flow)', async () => {
    await client.updateOrgConfig(orgId, { required_approvals: 2 }, moderatorIdentity);
    runner.print('Updated org config: required_approvals=2');

    const encResult = encryptMemory(
      'Kubernetes pod disruption budgets ensure safe pod eviction during updates. Set minAvailable or maxUnavailable with Integer or percentage values. Always test with kubectl drain --ignore-daemonsets.',
      moderatorIdentity.xPub,
    );
    const contributorIdentity = getIdentity(state, 'contributor');
    const sig = signSubmission(contributorIdentity, encResult.submissionHash);

    const submitResult = await client.submitMemory(orgId, {
      org_id: orgId,
      epoch_id: state.currentEpoch,
      ciphertext: encResult.ciphertextHex,
      wrapped_dek_mod: encResult.wrappedDekModHex,
      submission_hash: encResult.submissionHash,
      contributor_pubkey: contributorIdentity.pubkeyHex,
      contributor_sig: sig,
      stack_hint: ['k8s', 'kubernetes', 'pods'],
    });

    runner.print(`Submitted new memory: ${encResult.submissionHash}`);
    runner.print(`Status: ${(submitResult as Record<string, unknown>).status}`);

    const voteResult = await client.approveSubmission(orgId, encResult.submissionHash, {
      epoch_id: state.currentEpoch,
      approved_cid: createHash('sha256').update(encResult.submissionHash).digest('hex'),
      wrapped_dek_enc: encResult.wrappedDekModHex,
      keywords: [{ keyword: 'k8s', weight: 0.8 }, { keyword: 'kubernetes', weight: 0.8 }],
      keyword_weights: { k8s: 0.8, kubernetes: 0.8 },
      vector: (await client.testEmbed('k8s kubernetes')).vector.map(Number),
      embedding_model_id: 'nomic-embed-text',
      moderator_sig: sig,
      signed_by: moderatorIdentity.pubkeyHex,
    }, moderatorIdentity);

    const votes = (voteResult as Record<string, unknown>).votes ?? (voteResult as Record<string, unknown>).approval_count ?? 1;
    runner.print(`Vote recorded: votes=${votes}`);
    runner.print('Note: Second moderator vote needed for quorum (requires second moderator identity)');

    return `Vote submitted, votes=${votes} (need second moderator for quorum)`;
  });

  await runner.scenario('View reports', async () => {
    const resp = await client.listReports(orgId, moderatorIdentity);
    const reports = (resp as Record<string, unknown>).reports as Array<Record<string, unknown>>;
    const total = (resp as Record<string, unknown>).total as number;

    runner.print(`Total reports: ${total}`);

    for (const r of reports) {
      const id = r.id ?? '(unknown)';
      const memoryCid = r.memory_cid ?? '(unknown)';
      const reason = r.reason ?? '(unknown)';
      const status = r.status ?? '(unknown)';
      runner.print(`  [${id}] memory=${String(memoryCid).substring(0, 20)}... reason=${reason} status=${status}`);
    }

    return `Listed ${reports.length} report(s)`;
  });

  await runner.scenario('Escalate a report', async () => {
    const pendingReports = state.reports.filter(r => r.status !== 'resolved' && r.status !== 'dismissed' && r.status !== 'escalated');
    if (pendingReports.length === 0) {
      return 'No open reports to escalate';
    }

    const report = pendingReports[0];
    const result = await client.updateReport(orgId, report.id, 'escalate', moderatorIdentity);

    const idx = state.reports.findIndex(r => r.id === report.id);
    if (idx !== -1) {
      state.reports[idx].status = 'escalated';
    }
    updateState({ reports: state.reports });

    const status = (result as Record<string, unknown>).status ?? (result as Record<string, unknown>).report_status;
    runner.print(`Escalated report: ${report.id}`);
    runner.print(`New status: ${status}`);

    return `Report ${report.id} escalated`;
  });

  await runner.scenario('Dismiss a report', async () => {
    const pendingReports = state.reports.filter(r => r.status !== 'resolved' && r.status !== 'dismissed' && r.status !== 'escalated');
    if (pendingReports.length === 0) {
      return 'No open reports to dismiss';
    }

    const report = pendingReports[0];
    const result = await client.updateReport(orgId, report.id, 'dismiss', moderatorIdentity);

    const idx = state.reports.findIndex(r => r.id === report.id);
    if (idx !== -1) {
      state.reports[idx].status = 'dismissed';
    }
    updateState({ reports: state.reports });

    const status = (result as Record<string, unknown>).status ?? (result as Record<string, unknown>).report_status;
    runner.print(`Dismissed report: ${report.id}`);
    runner.print(`New status: ${status}`);

    return `Report ${report.id} dismissed`;
  });

  await runner.scenario('Archive reported memory', async () => {
    const pendingReports = state.reports.filter(r => r.status !== 'resolved' && r.status !== 'dismissed' && r.status !== 'archived');
    if (pendingReports.length === 0) {
      return 'No open reports to archive';
    }

    const report = pendingReports[0];
    const memoryCid = report.memoryCid;

    const result = await client.updateReport(orgId, report.id, 'archive', moderatorIdentity);

    const idx = state.reports.findIndex(r => r.id === report.id);
    if (idx !== -1) {
      state.reports[idx].status = 'resolved';
    }
    updateState({ reports: state.reports });

    const status = (result as Record<string, unknown>).status ?? (result as Record<string, unknown>).report_status;
    runner.print(`Archived memory: ${memoryCid}`);
    runner.print(`Report ${report.id} status: ${status}`);

    return `Memory ${memoryCid.substring(0, 16)}... archived and report resolved`;
  });

  await runner.scenario('View approved memories', async () => {
    const resp = await client.listMemories(orgId);
    const memories = (resp as Record<string, unknown>).memories as Array<Record<string, unknown>>;
    const count = (resp as Record<string, unknown>).count as number;

    runner.print(`Total approved memories: ${count}`);

    for (const mem of memories) {
      const cid = mem.cid ?? mem.memory_cid ?? '(unknown)';
      const createdAt = mem.created_at ?? mem.createdAt ?? '(unknown)';
      const keywords = (mem.keywords ?? mem.keyword_weights ?? []) as Record<string, number>;
      const kwList = Object.entries(keywords).map(([k, v]) => `${k}(${v})`).join(', ');
      runner.print(`  cid=${String(cid).substring(0, 20)}... created=${createdAt} keywords=[${kwList}]`);
    }

    return `Listed ${count} approved memory/memories`;
  });

  await runner.needsInfra(
    'Moderate via dashboard MCP',
    'Dashboard moderation page requires wevibe-mcp --dashboard on port 4450. MCP tools needed: wevibe_mod_queue, wevibe_mod_approve, wevibe_mod_deny. This is the production moderation flow — API bypass tested above.',
  );

  runner.summary();
  runner.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});