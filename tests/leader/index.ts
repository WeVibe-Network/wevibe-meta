import { ScenarioRunner } from '../lib/scenario.js';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity } from '../lib/state.js';
import { seedFullScenario } from '../lib/seeder.js';
import { buildBodySignedPayload } from '../lib/auth.js';
import * as canonical from '../lib/canonical.js';
import { EMBEDDING_MODEL_ID } from '../lib/config.js';
import type { TestIdentity } from '../lib/identity.js';
import { uint8ToHex } from '../lib/identity.js';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';

interface State {
  orgId: string;
  orgName: string;
  domain: string;
  currentEpoch: number;
  pkModHex: string;
  identities: {
    leader: { edPubHex: string; edPrivHex: string; xPubHex: string; xPrivHex: string };
    moderator: { edPubHex: string; edPrivHex: string; xPubHex: string; xPrivHex: string };
    contributor: { edPubHex: string; edPrivHex: string; xPubHex: string; xPrivHex: string };
    consumer: { edPubHex: string; edPrivHex: string; xPubHex: string; xPrivHex: string };
  };
  envelopes: { enc: string; search: string; mod: string };
  submissionHashes: string[];
  approvedCIDs: string[];
  submissions: Array<{ hash: string; plaintext: string; ciphertextHex: string; wrappedDekModHex: string; dek: string; stackHint: string[]; status: string; approvedCid?: string }>;
  reports: Array<{ id: string; memoryCid: string; reason: string; status: string }>;
}

const client = new HubClient();
let state: State;
let leader: TestIdentity;

async function init(): Promise<void> {
  try {
    state = loadState() as unknown as State;
    console.log('Loaded existing state:', state.orgId);
  } catch {
    console.log('No state found, seeding full scenario...');
    const result = await seedFullScenario();
    state = result.state as unknown as State;
  }
  leader = getIdentity(state as any, 'leader');
  return;
}

async function main() {
  const runner = new ScenarioRunner('Leader');
  runner.header();

  await init();

  // SCENARIO 1: Verify org exists
  await runner.scenario('Verify org exists', async () => {
    const org = await client.getOrg(state.orgId) as Record<string, unknown>;
    runner.print(`Org ID: ${org.org_id}`);
    runner.print(`Org name: ${org.org_name}`);
    runner.print(`Leader pubkey: ${org.leader_pubkey}`);
    runner.print(`State leader pubkey: ${leader.pubkeyHex}`);

    if (org.leader_pubkey !== leader.pubkeyHex) {
      throw new Error('Leader pubkey mismatch!');
    }
    return `Org verified: ${state.orgId}`;
  });

  // SCENARIO 2: View members
  await runner.scenario('View members', async () => {
    const members = await client.listMembers(state.orgId) as Array<Record<string, unknown>>;
    runner.print('');
    runner.print('┌─ Members ────────────────────────────────────────┐');
    runner.print('│ pubkey                          │ role         │');
    runner.print('├───────────────────────────────────────────────────┤');
    for (const m of members) {
      const role = m.role as string;
      const badge = role === 'leader' ? '[LEADER] ' : role === 'moderator' ? '[MOD]    ' : `[MEMBER] `;
      runner.print(`│ ${m.pubkey?.toString().substring(0, 20)}... │ ${badge}${role.padEnd(9)} │`);
    }
    runner.print('└───────────────────────────────────────────────────┘');

    if (members.length !== 4) {
      throw new Error(`Expected 4 members, got ${members.length}`);
    }
    await runner.confirm('Press Enter after checking the members list...');
    return `Found ${members.length} members`;
  });

  // SCENARIO 3: View moderation queue via test endpoint
  await runner.scenario('View moderation queue', async () => {
    const queue = await client.testGetQueue(state.orgId) as Array<Record<string, unknown>>;
    runner.print('');
    runner.print('┌─ Pending Submissions ─────────────────────────────┐');
    runner.print('│ submission_hash                  │ status   │ stack_hint        │');
    runner.print('├───────────────────────────────────────────────────┤');
    for (const item of queue) {
      runner.print(`│ ${(item.submission_hash as string).substring(0, 28)} │ ${((item.status as string) || 'pending').padEnd(9)} │ ${((item.stack_hint as string[]) || []).join(', ').substring(0, 18)} │`);
    }
    runner.print('└───────────────────────────────────────────────────┘');
    runner.print('');
    runner.print('Dashboard: Open localhost:3000/moderation — you should see');
    runner.print('2 pending submissions (k8s and redis topics)');
    await runner.confirm('Press Enter after checking the dashboard...');
    return `Queue has ${queue.length} pending submissions`;
  });

  // SCENARIO 4: Approve a pending memory
  await runner.scenario('Approve a pending memory', async () => {
    const queue = await client.testGetQueue(state.orgId) as Array<Record<string, unknown>>;
    if (queue.length === 0) {
      throw new Error('No pending submissions to approve');
    }

    const pending = queue[0];
    const submissionHash = pending.submission_hash as string;
    runner.print(`Approving submission: ${submissionHash.substring(0, 20)}...`);

    const approvedCid = submissionHash.substring(0, 64);
    const msg = canonical.approveSubmissionMessage(
      state.orgId,
      submissionHash,
      state.currentEpoch,
      approvedCid,
      '',
      leader.pubkeyHex,
      [],
    );
    const sig = buildBodySignedPayload(leader, {
      epoch_id: state.currentEpoch,
      approved_cid: approvedCid,
      wrapped_dek_enc: '',
      keywords: [],
      keyword_weights: {},
      vector: [],
      embedding_model_id: EMBEDDING_MODEL_ID,
      moderator_sig: uint8ToHex(new Uint8Array(64)),
    }, msg);

    await client.approveSubmission(state.orgId, submissionHash, sig, leader);

    const newQueue = await client.testGetQueue(state.orgId) as Array<Record<string, unknown>>;
    runner.print(`Queue size after approval: ${newQueue.length}`);
    runner.print('');
    runner.print('Dashboard: Refresh localhost:3000/moderation — should show');
    runner.print('1 pending now (redis only)');
    await runner.confirm('Press Enter after checking the dashboard...');
    return `Approved ${submissionHash.substring(0, 16)}...`;
  });

  // SCENARIO 5: Deny the remaining pending memory
  await runner.scenario('Deny the remaining pending memory', async () => {
    const queue = await client.testGetQueue(state.orgId) as Array<Record<string, unknown>>;
    if (queue.length === 0) {
      throw new Error('No pending submissions to deny');
    }

    const pending = queue[0];
    const submissionHash = pending.submission_hash as string;
    runner.print(`Denying submission: ${submissionHash.substring(0, 20)}...`);

    await client.denySubmission(state.orgId, submissionHash, 'off-topic or low-quality content', leader);

    const newQueue = await client.testGetQueue(state.orgId) as Array<Record<string, unknown>>;
    runner.print(`Queue size after denial: ${newQueue.length}`);
    runner.print('');
    runner.print('Dashboard: Refresh localhost:3000/moderation — should show');
    runner.print('empty queue');
    await runner.confirm('Press Enter after checking the dashboard...');
    return `Denied ${submissionHash.substring(0, 16)}...`;
  });

  // SCENARIO 6: View reports
  await runner.scenario('View reports', async () => {
    const resp = await client.listReports(state.orgId, leader) as { reports: Array<Record<string, unknown>>; total: number };
    runner.print('');
    runner.print('┌─ Reports ─────────────────────────────────────────┐');
    runner.print('│ id       │ memory_cid           │ reason    │ status  │');
    runner.print('├───────────────────────────────────────────────────┤');
    for (const r of resp.reports) {
      const statusBadge = r.status === 'open' ? '[OPEN]   ' : r.status === 'resolved' ? '[RESOLVED]' : '[DISMISS]';
      runner.print(`│ ${(r.id as string).substring(0, 8)} │ ${(r.memory_cid as string).substring(0, 20)}... │ ${((r.reason as string) || '').padEnd(10)} │ ${statusBadge} │`);
    }
    runner.print('└───────────────────────────────────────────────────┘');
    runner.print('');
    runner.print('Dashboard: Open localhost:3000/reports — should see 2 reports');
    await runner.confirm('Press Enter after checking the dashboard...');
    return `Found ${resp.total} reports`;
  });

  // SCENARIO 7: Dismiss a report
  await runner.scenario('Dismiss a report', async () => {
    const resp = await client.listReports(state.orgId, leader) as { reports: Array<Record<string, unknown>>; total: number };
    if (resp.reports.length === 0) {
      throw new Error('No reports to dismiss');
    }

    const report = resp.reports.find(r => r.status === 'open') || resp.reports[0];
    runner.print(`Dismissing report: ${report.id}`);

    const result = await client.updateReport(state.orgId, report.id as string, 'dismiss', leader) as Record<string, unknown>;
    runner.print(`Result: ${JSON.stringify(result)}`);

    const updated = await client.listReports(state.orgId, leader) as { reports: Array<Record<string, unknown>> };
    const dismissed = updated.reports.find(r => r.id === report.id);
    if (dismissed && dismissed.status !== 'dismissed') {
      throw new Error('Report status did not change to dismissed');
    }
    return `Dismissed report ${(report.id as string).substring(0, 8)}`;
  });

  // SCENARIO 8: Archive reported memory (accept report)
  await runner.scenario('Archive reported memory', async () => {
    const resp = await client.listReports(state.orgId, leader) as { reports: Array<Record<string, unknown>>; total: number };
    if (resp.reports.length === 0) {
      throw new Error('No reports to archive');
    }

    const report = resp.reports.find(r => r.status !== 'resolved') || resp.reports[0];
    runner.print(`Archiving report: ${report.id}`);
    runner.print(`Memory CID: ${report.memory_cid}`);

    const result = await client.updateReport(state.orgId, report.id as string, 'archive', leader) as Record<string, unknown>;
    runner.print(`Result: ${JSON.stringify(result)}`);

    const updated = await client.listReports(state.orgId, leader) as { reports: Array<Record<string, unknown>> };
    const archived = updated.reports.find(r => r.id === report.id);
    if (archived && archived.status !== 'resolved') {
      throw new Error('Report status did not change to resolved');
    }
    return `Archived memory for report ${(report.id as string).substring(0, 8)}`;
  });

  // SCENARIO 9: Update moderation config
  await runner.scenario('Update moderation config', async () => {
    runner.print('Setting required_approvals to 2...');
    await client.updateOrgConfig(state.orgId, { required_approvals: 2 }, leader);

    const org = await client.getOrgDetails(state.orgId) as Record<string, unknown>;
    const config = org.config as Record<string, unknown>;
    runner.print(`Config after update: required_approvals = ${config?.required_approvals}`);

    if (config?.required_approvals !== 2) {
      throw new Error('required_approvals not set to 2');
    }

    runner.print('');
    runner.print('Dashboard: Open localhost:3000/settings — required approvals');
    runner.print('should show 2');
    await runner.confirm('Press Enter after checking the dashboard...');

    runner.print('');
    runner.print('Resetting required_approvals back to 1...');
    await client.updateOrgConfig(state.orgId, { required_approvals: 1 }, leader);

    const org2 = await client.getOrgDetails(state.orgId) as Record<string, unknown>;
    const config2 = org2.config as Record<string, unknown>;
    runner.print(`Config after reset: required_approvals = ${config2?.required_approvals}`);

    return 'Config updated and verified';
  });

  // SCENARIO 10: Promote member to moderator
  await runner.scenario('Promote member to moderator', async () => {
    const consumer = getIdentity(state as any, 'consumer');
    runner.print(`Promoting consumer: ${consumer.pubkeyHex.substring(0, 20)}...`);
    runner.print('Using test endpoint: PATCH /v1/test/orgs/{orgId}/members/role');

    const result = await client.testUpdateRole(state.orgId, consumer.pubkeyHex, 'moderator') as { new_role: string };
    runner.print(`New role: ${result.new_role}`);

    const members = await client.listMembers(state.orgId) as Array<Record<string, unknown>>;
    const promoted = members.find(m => m.pubkey === consumer.pubkeyHex);
    if (!promoted || promoted.role !== 'moderator') {
      throw new Error('Member was not promoted to moderator');
    }

    runner.print('');
    runner.print('Dashboard: Refresh localhost:3000/members — consumer should');
    runner.print('show "moderator" role');
    await runner.confirm('Press Enter after checking the dashboard...');

    return `Promoted consumer to moderator`;
  });

  // SCENARIO 11: Remove a moderator (boot)
  await runner.scenario('Remove a moderator (boot)', async () => {
    const consumer = getIdentity(state as any, 'consumer');
    runner.print(`Removing moderator: ${consumer.pubkeyHex.substring(0, 20)}...`);

    await client.removeMember(state.orgId, consumer.pubkeyHex, leader);

    const org = await client.getOrgDetails(state.orgId) as Record<string, unknown>;
    runner.print(`Rotation pending: ${org.rotation_pending}`);

    if (!org.rotation_pending) {
      throw new Error('Org rotation_pending not set after boot');
    }

    runner.print('');
    runner.print('Dashboard: Refresh localhost:3000/members — removed member');
    runner.print('should be gone');
    await runner.confirm('Press Enter after checking the dashboard...');

    return 'Moderator removed, rotation pending';
  });

  // SCENARIO 12: Rotate epoch after boot
  await runner.scenario('Rotate epoch after boot', async () => {
    runner.print('Generating new DEK and sealing to leader pubkey...');

    const newDek = generate_dek();
    const encEnvelope = uint8ToHex(seal_to_pubkey(newDek, leader.xPub));
    const searchEnvelope = uint8ToHex(seal_to_pubkey(newDek, leader.xPub));
    const modEnvelope = uint8ToHex(seal_to_pubkey(newDek, leader.xPub));

    const envelopes: canonical.MemberEnvelopePair[] = [{
      pubkey: leader.pubkeyHex,
      enc_envelope: encEnvelope,
      search_envelope: searchEnvelope,
      mod_envelope: modEnvelope,
    }];

    const msg = canonical.rotateEpochMessage(state.orgId, leader.xPubkeyHex, leader.pubkeyHex, envelopes);
    const body = buildBodySignedPayload(leader, {
      new_pk_mod: leader.xPubkeyHex,
      envelopes,
    }, msg);

    const result = await client.rotateEpoch(state.orgId, body, leader) as Record<string, unknown>;
    runner.print(`Epoch rotation result: ${JSON.stringify(result)}`);

    state.currentEpoch += 1;

    const org = await client.getOrgDetails(state.orgId) as Record<string, unknown>;
    runner.print(`Current epoch: ${org.current_epoch}`);
    runner.print(`Rotation status: ${org.rotation_status}`);

    return `Epoch rotated to ${state.currentEpoch}`;
  });

  // SCENARIO 13: Re-invite removed member
  await runner.scenario('Re-invite removed member', async () => {
    const consumer = getIdentity(state as any, 'consumer');
    runner.print(`Re-inviting consumer: ${consumer.pubkeyHex.substring(0, 20)}...`);
    runner.print('Using same member identity (consumer pubkey)');

    const encEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), leader.xPub));
    const searchEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), leader.xPub));
    const modEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), leader.xPub));

    await client.inviteMember(
      state.orgId,
      consumer.pubkeyHex,
      consumer.xPubkeyHex,
      'moderator',
      encEnvelope,
      searchEnvelope,
      modEnvelope,
      leader,
    );

    const members = await client.listMembers(state.orgId) as Array<Record<string, unknown>>;
    runner.print(`Member count after re-invite: ${members.length}`);

    if (members.length !== 4) {
      throw new Error(`Expected 4 members after re-invite, got ${members.length}`);
    }

    return 'Member re-invited, count restored to 4';
  });

  // SCENARIO 14: Batch submit to chain
  await runner.scenario('Batch submit to chain', async () => {
    runner.print('Submitting approved memories to chain...');

    const result = await client.batchSubmitToChain(state.orgId, leader) as Record<string, unknown>;
    runner.print(`Result: ${JSON.stringify(result)}`);

    const submitted = result.submitted || 0;
    const failed = result.failed || 0;
    runner.print(`Submitted: ${submitted}, Failed: ${failed}`);

    return `Batch submit completed: ${submitted} submitted, ${failed} failed`;
  });

  // SCENARIO 15: View billing
  await runner.scenario('View billing', async () => {
    const credits = await client.getCredits(state.orgId) as Record<string, unknown>;
    runner.print('');
    runner.print('┌─ Billing Information ────────────────────────────┐');
    runner.print(`│ Balance: ${credits.balance || credits.credits || 0}                         │`);
    runner.print('│                                                  │');
    runner.print('│ Transactions:                                    │');

    const txList = (credits.transactions as Array<Record<string, unknown>>) || [];
    for (const tx of txList.slice(0, 5)) {
      runner.print(`│   - ${tx.type || 'unknown'}: ${tx.amount || 0} (${tx.status || 'pending'})    │`);
    }
    runner.print('└──────────────────────────────────────────────────┘');
    runner.print('');
    runner.print('Dashboard: Open localhost:3000/billing — verify balance matches');
    await runner.confirm('Press Enter after checking the dashboard...');

    return 'Billing information retrieved';
  });

  // SCENARIO 16: Transfer leadership (NEEDS_INFRA)
  await runner.needsInfra(
    'Transfer leadership',
    'No leadership transfer endpoint exists. Needs: PATCH /v1/orgs/{orgId}/leader with canonical signature.'
  );

  // SCENARIO 17: Close org (NEEDS_INFRA)
  await runner.needsInfra(
    'Close org',
    'No org closure endpoint exists. Needs: DELETE /v1/orgs/{orgId} with deposit release and memory cleanup.'
  );

  runner.summary();
  runner.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
