import { HubClient } from '../lib/hub-client.js';
import { generateFreshState, saveState, getIdentity } from '../lib/state.js';
import { encryptMemory, signSubmission } from '../lib/crypto.js';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';
import { uint8ToHex, signData } from '../lib/identity.js';
import { createHash } from 'node:crypto';
import { buildBodySignedPayload } from '../lib/auth.js';
import * as canonical from '../lib/canonical.js';

async function main() {
  console.log('WeVibe E2E Full Lifecycle Automation');
  console.log('===================================\n');

  const client = new HubClient();
  const state = generateFreshState();
  const leader = getIdentity(state, 'leader');
  const moderator = getIdentity(state, 'moderator');
  const contributor = getIdentity(state, 'contributor');
  const consumer = getIdentity(state, 'consumer');

  console.log('Phase 1: Service Health');
  const h = await client.health();
  console.log(`  Hub: ${h.status}, DB: ${h.db}`);
  const th = await client.testHealth();
  console.log(`  Chain: ${th.chain}, Qdrant: ${th.qdrant}`);
  console.log(`  Submitter: ${th.submitter_address ?? 'N/A'}`);

  console.log('\nPhase 2: Create Org + Invite Members');
  await client.testReset();
  const modPubkey = leader.xPub;
  const encEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
  const searchEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
  const modEnvelope = uint8ToHex(seal_to_pubkey(generate_dek(), modPubkey));
  state.envelopes = { enc: encEnvelope, search: searchEnvelope, mod: modEnvelope };
  state.pkModHex = leader.xPubkeyHex;

  await client.createOrg(state.orgId, state.orgName, state.domain, leader.xPubkeyHex, encEnvelope, searchEnvelope, modEnvelope, { tier: 'starter', monthly_credits: 1000, per_query_cost: 1, currency: 'USD' }, leader);
  await client.inviteMember(state.orgId, moderator.pubkeyHex, moderator.xPubkeyHex, 'moderator', encEnvelope, searchEnvelope, modEnvelope, leader);
  await client.inviteMember(state.orgId, contributor.pubkeyHex, contributor.xPubkeyHex, 'member', encEnvelope, searchEnvelope, modEnvelope, leader);
  await client.inviteMember(state.orgId, consumer.pubkeyHex, consumer.xPubkeyHex, 'member', encEnvelope, searchEnvelope, modEnvelope, leader);
  const members = await client.listMembers(state.orgId);
  console.log(`  Org: ${state.orgId}, Members: ${members.length}`);
  saveState(state);

  console.log('\nPhase 3: Contributor Submits 5 Memories');
  const memoryTexts = [
    'Docker container health checks using curl and /health endpoint',
    'Nginx reverse proxy configuration for Node.js apps',
    'PostgreSQL connection pooling with pgbouncer',
    'Redis session failover patterns using Sentinel',
    'Kubernetes liveness vs readiness probes',
  ];
  const stackHints = [['docker'], ['nginx'], ['postgres'], ['redis'], ['k8s']];
  for (let i = 0; i < memoryTexts.length; i++) {
    const enc = encryptMemory(memoryTexts[i], modPubkey);
    const sig = signSubmission(contributor, enc.submissionHash);
    await client.submitMemory(state.orgId, { org_id: state.orgId, epoch_id: 1, ciphertext: enc.ciphertextHex, wrapped_dek_mod: enc.wrappedDekModHex, submission_hash: enc.submissionHash, contributor_pubkey: contributor.pubkeyHex, contributor_sig: sig, stack_hint: stackHints[i] });
    state.submissions.push({ hash: enc.submissionHash, plaintext: memoryTexts[i], ciphertextHex: enc.ciphertextHex, wrappedDekModHex: enc.wrappedDekModHex, dek: uint8ToHex(enc.dek), stackHint: stackHints[i], status: 'pending' });
  }
  console.log(`  Submitted ${memoryTexts.length} memories`);

  console.log('\nPhase 4: Moderator Approves 3, Denies 2');
  const queue = await client.getModerationQueue(state.orgId, moderator);
  console.log(`  Queue: ${queue.length} pending`);
  const toApprove = state.submissions.slice(0, 3);
  const toDeny = state.submissions.slice(3, 5);
  for (const sub of toApprove) {
    const approvedCid = createHash('sha256').update(sub.hash).digest('hex');
    const embedResp = await client.testEmbed('docker');
    const vector = embedResp.vector.map(Number);
    const sig = signSubmission(moderator, sub.hash);
    await client.approveSubmission(state.orgId, sub.hash, { epoch_id: 1, approved_cid: approvedCid, wrapped_dek_enc: '', keywords: [{ keyword: 'docker', weight: 0.8 }], keyword_weights: { docker: 0.8 }, vector, embedding_model_id: 'nomic-embed-text', moderator_sig: sig, signed_by: moderator.pubkeyHex }, moderator);
    state.approvedCIDs.push(approvedCid);
    sub.status = 'approved';
    sub.approvedCid = approvedCid;
  }
  for (const sub of toDeny) {
    await client.denySubmission(state.orgId, sub.hash, 'off-topic', moderator);
    sub.status = 'denied';
  }
  console.log(`  Approved: ${toApprove.length}, Denied: ${toDeny.length}`);

  console.log('\nPhase 5: Consumer Queries');
  const qEmbed = await client.testEmbed('docker');
  const qVector = qEmbed.vector.map(Number);
  const qData = new TextEncoder().encode(`query:${consumer.pubkeyHex}:${Date.now()}`);
  const qResult = await client.queryMemories(state.orgId, { org_id: state.orgId, agent_pubkey: consumer.pubkeyHex, keyword_weights: [{ keyword: 'docker', weight: 0.9 }], vector: qVector, limit: 10, agent_sig: uint8ToHex(signData(consumer, qData)) });
  console.log(`  Query returned ${qResult.results.length} results, receipt: ${qResult.receipt_id}`);

  console.log('\nPhase 6: Consumer Files Reports');
  const cid1 = state.approvedCIDs[0];
  const cid2 = state.approvedCIDs[1];
  const r1 = await client.createReport(state.orgId, { memory_cid: cid1, reason: 'outdated', note: 'test' }, consumer) as Record<string, unknown>;
  const r2 = await client.createReport(state.orgId, { memory_cid: cid2, reason: 'incorrect', note: 'test' }, consumer) as Record<string, unknown>;
  state.reports.push({ id: r1.id as string, memoryCid: cid1, reason: 'outdated', status: 'open' });
  state.reports.push({ id: r2.id as string, memoryCid: cid2, reason: 'incorrect', status: 'open' });
  console.log(`  Filed ${state.reports.length} reports`);

  console.log('\nPhase 7: Moderator Resolves Reports');
  const reportsResp = await client.listReports(state.orgId, moderator);
  const reports = (reportsResp as Record<string, unknown>).reports as Array<Record<string, unknown>>;
  await client.updateReport(state.orgId, reports[0].id as string, 'dismiss', moderator);
  await client.updateReport(state.orgId, reports[1].id as string, 'archive', moderator);
  console.log('  Dismissed 1, Archived 1');

  console.log('\nPhase 8: Leader Promotes Consumer to Moderator');
  const consumerIdentity = getIdentity(state, 'consumer');
  const promo = await client.testUpdateRole(state.orgId, consumerIdentity.pubkeyHex, 'moderator');
  console.log(`  Consumer promoted to: ${promo.new_role}`);

  console.log('\nPhase 9: Leader Removes Original Moderator → rotation_pending');
  const modIdentity = getIdentity(state, 'moderator');
  const remResult = await client.removeMember(state.orgId, modIdentity.pubkeyHex, leader) as Record<string, unknown>;
  console.log(`  Remove result: ${remResult.status}`);
  const org = await client.getOrgDetails(state.orgId) as Record<string, unknown>;
  console.log(`  rotation_pending: ${org.rotation_pending}`);

  console.log('\nPhase 10: Leader Rotates Epoch');
  const newModPubkey = leader.xPub;
  const newEnc = uint8ToHex(seal_to_pubkey(generate_dek(), newModPubkey));
  const newSearch = uint8ToHex(seal_to_pubkey(generate_dek(), newModPubkey));
  const newMod = uint8ToHex(seal_to_pubkey(generate_dek(), newModPubkey));
  const envelopes = state.submissions.map(s => ({ pubkey: s.hash, enc_envelope: newEnc, search_envelope: newSearch, mod_envelope: newMod }));
  const msg = canonical.rotateEpochMessage(state.orgId, leader.xPubkeyHex, leader.pubkeyHex, envelopes);
  const payload = buildBodySignedPayload(leader, { new_pk_mod: leader.xPubkeyHex, envelopes: envelopes.map(e => ({ pubkey: e.pubkey, enc_envelope: e.enc_envelope, search_envelope: e.search_envelope, mod_envelope: e.mod_envelope })) }, msg);
  await client.rotateEpoch(state.orgId, payload, leader);
  state.currentEpoch += 1;
  state.envelopes = { enc: newEnc, search: newSearch, mod: newMod };
  saveState(state);
  console.log('  Epoch rotated');

  console.log('\nPhase 11: Contributor Submits Post-Rotation Memory');
  const enc = encryptMemory('Terraform infrastructure as code patterns', leader.xPub);
  const sig = signSubmission(contributor, enc.submissionHash);
  const submitResult = await client.submitMemory(state.orgId, { org_id: state.orgId, epoch_id: state.currentEpoch, ciphertext: enc.ciphertextHex, wrapped_dek_mod: enc.wrappedDekModHex, submission_hash: enc.submissionHash, contributor_pubkey: contributor.pubkeyHex, contributor_sig: sig, stack_hint: ['terraform'] });
  console.log(`  Post-rotation submit status: ${submitResult.status}`);

  console.log('\nPhase 12: New Moderator Approves Post-Rotation Memory');
  const newQueue = await client.getModerationQueue(state.orgId, consumerIdentity);
  if (newQueue.length > 0) {
    const hash = (newQueue[0] as Record<string, unknown>).submission_hash as string;
    const approvedCid = createHash('sha256').update('post-rotation').digest('hex');
    const embedResp = await client.testEmbed('terraform');
    const vector = embedResp.vector.map(Number);
    const newSig = signSubmission(consumerIdentity, hash);
    await client.approveSubmission(state.orgId, hash, { epoch_id: state.currentEpoch, approved_cid: approvedCid, wrapped_dek_enc: '', keywords: [{ keyword: 'terraform', weight: 0.8 }], keyword_weights: { terraform: 0.8 }, vector, embedding_model_id: 'nomic-embed-text', moderator_sig: newSig, signed_by: consumerIdentity.pubkeyHex }, consumerIdentity);
    console.log('  Post-rotation memory approved by new moderator');
  }

  console.log('\n===================================');
  console.log('Full 12-phase lifecycle complete!');
  console.log(`Org: ${state.orgId}`);
  console.log(`Approved memories: ${state.approvedCIDs.length}`);
  console.log(`Pending in queue: ${(await client.testGetQueue(state.orgId)).length}`);
}

main().catch(console.error);