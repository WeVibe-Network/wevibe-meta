import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

import { verify } from 'wevibe-sdk-wasm';

import { buildWeVibeSignedHeaders } from '../lib/auth.js';
import { HubClient } from '../lib/hub-client.js';
import {
  generateTestIdentity,
  hexToUint8,
  signData,
  uint8ToHex,
  type TestIdentity,
} from '../lib/identity.js';

type MemoryType = 'memory';

interface SubmitPayload {
  org_id: string;
  epoch_id: number;
  memory_type: MemoryType;
  plaintext_hash: string;
  salt: string;
  ciphertext_hash: string;
  wrapped_dek_hash: string;
  ciphertext: string;
  wrapped_dek_mod: string;
  submission_hash: string;
  contributor_pubkey: string;
  contributor_sig: string;
  stack_hint: string[];
  attestation: null;
}

interface QueryVerifyUpheldReportResponse {
  plaintext: string;
  ciphertext: string;
  capsule: string;
  plaintext_hash: string;
  plaintext_oversized: boolean;
  approving_moderators: string[];
  upholding_moderators: string[];
  upheld_at_epoch: string;
  salt: string;
  ciphertext_hash: string;
  wrapped_dek_hash: string;
  contributor_sig: string;
  contributor_pubkey: string;
  encrypted_blob: string;
  wrapped_dek_enc: string;
  content_hash: string;
  org_id: string;
  epoch: string;
  memory_type: string;
  canonical_body: string;
}

function sha256Hex(input: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(input)).digest('hex');
}

function sha256Bytes(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(Buffer.from(input)).digest());
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function canonicalSubmitMemory(
  orgId: string,
  epochId: number,
  submissionHash: string,
  contributorPubkey: string,
  memoryType: MemoryType,
  ciphertextHash: string,
  plaintextHash: string,
  salt: string,
  wrappedDekHash: string,
): Uint8Array {
  const msg = [
    'wevibe.submit_memory.v1',
    `ciphertext_hash:${ciphertextHash}`,
    `contributor_pubkey:${contributorPubkey}`,
    `epoch_id:${epochId}`,
    `memory_type:${memoryType}`,
    `org_id:${orgId}`,
    `plaintext_hash:${plaintextHash}`,
    `salt:${salt}`,
    `submission_hash:${submissionHash}`,
    `wrapped_dek_hash:${wrappedDekHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

function buildSubmitPayload(
  orgId: string,
  epochId: number,
  contributor: TestIdentity,
  plaintext: string,
  memoryType: MemoryType,
  signer: TestIdentity = contributor,
): { payload: SubmitPayload; plaintext: string } {
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const salt = randomBytes(32);
  const ciphertextBytes = randomBytes(96);
  const wrappedDekModBytes = randomBytes(80);

  const plaintextHashHex = sha256Hex(concatBytes(salt, plaintextBytes));
  const ciphertextHashHex = sha256Hex(ciphertextBytes);
  const wrappedDekHashHex = sha256Hex(wrappedDekModBytes);
  const submissionHashHex = sha256Hex(concatBytes(ciphertextBytes, wrappedDekModBytes));

  const canonical = canonicalSubmitMemory(
    orgId,
    epochId,
    submissionHashHex,
    contributor.pubkeyHex,
    memoryType,
    ciphertextHashHex,
    plaintextHashHex,
    Buffer.from(salt).toString('hex'),
    wrappedDekHashHex,
  );

  const contributorSigHex = uint8ToHex(signData(signer, canonical));

  return {
    payload: {
      org_id: orgId,
      epoch_id: epochId,
      memory_type: memoryType,
      plaintext_hash: plaintextHashHex,
      salt: Buffer.from(salt).toString('hex'),
      ciphertext_hash: ciphertextHashHex,
      wrapped_dek_hash: wrappedDekHashHex,
      ciphertext: Buffer.from(ciphertextBytes).toString('hex'),
      wrapped_dek_mod: Buffer.from(wrappedDekModBytes).toString('hex'),
      submission_hash: submissionHashHex,
      contributor_pubkey: contributor.pubkeyHex,
      contributor_sig: contributorSigHex,
      stack_hint: ['co029sig'],
      attestation: null,
    },
    plaintext,
  };
}

async function submitMemory(
  hubUrl: string,
  orgId: string,
  payload: SubmitPayload,
  identity: TestIdentity,
): Promise<{ statusCode: number; body: string }> {
  const resp = await fetch(`${hubUrl}/v1/orgs/${orgId}/submit`, {
    method: 'POST',
    headers: buildWeVibeSignedHeaders(identity),
    body: JSON.stringify(payload),
  });
  return {
    statusCode: resp.status,
    body: await resp.text(),
  };
}

function runDocker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' });
}

function psql(sql: string, tuplesOnly = false): string {
  const args = ['exec', '-i', 'wevibe-postgres', 'psql', '-U', 'wevibe', '-d', 'wevibe_hub'];
  if (tuplesOnly) {
    args.push('-t', '-A');
  }
  args.push('-c', sql);
  return runDocker(args).trim();
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

interface RawVerifyResponse {
  plaintext?: string;
  ciphertext?: string;
  capsule?: string;
  plaintextHash?: string;
  plaintextOversized?: boolean;
  approvingModerators?: string[];
  upholdingModerators?: string[];
  upheldAtEpoch?: string;
  salt?: string;
  ciphertextHash?: string;
  wrappedDekHash?: string;
  contributorSig?: string;
  contributorPubkey?: string;
  encryptedBlob?: string;
  wrappedDekEnc?: string;
  contentHash?: string;
  orgId?: string;
  epoch?: string;
  memoryType?: string;
  canonicalBody?: string;
}

function queryVerifyUpheldReport(orgId: string, contentHashHex: string): QueryVerifyUpheldReportResponse {
  const payload = JSON.stringify({ org_id: orgId, content_hash: hexToBase64(contentHashHex) });
  const out = runDocker([
    'run',
    '--rm',
    '--network',
    'wevibe-server_default',
    'fullstorydev/grpcurl',
    '-plaintext',
    '-d',
    payload,
    'wevibe-chain:9090',
    'wevibe.reputation.v1.Query/VerifyUpheldReport',
  ]);
  const raw = JSON.parse(out) as RawVerifyResponse;
  return {
    plaintext: raw.plaintext ?? '',
    ciphertext: raw.ciphertext ?? '',
    capsule: raw.capsule ?? '',
    plaintext_hash: raw.plaintextHash ?? '',
    plaintext_oversized: raw.plaintextOversized ?? false,
    approving_moderators: raw.approvingModerators ?? [],
    upholding_moderators: raw.upholdingModerators ?? [],
    upheld_at_epoch: raw.upheldAtEpoch ?? '0',
    salt: raw.salt ?? '',
    ciphertext_hash: raw.ciphertextHash ?? '',
    wrapped_dek_hash: raw.wrappedDekHash ?? '',
    contributor_sig: raw.contributorSig ?? '',
    contributor_pubkey: raw.contributorPubkey ?? '',
    encrypted_blob: raw.encryptedBlob ?? '',
    wrapped_dek_enc: raw.wrappedDekEnc ?? '',
    content_hash: raw.contentHash ?? '',
    org_id: raw.orgId ?? '',
    epoch: raw.epoch ?? '0',
    memory_type: raw.memoryType ?? '',
    canonical_body: raw.canonicalBody ?? '',
  };
}

function decodeB64(field: string): Uint8Array {
  if (!field) return new Uint8Array();
  return new Uint8Array(Buffer.from(field, 'base64'));
}

async function waitForVerifyUpheldReport(orgId: string, contentHashHex: string): Promise<QueryVerifyUpheldReportResponse> {
  const deadline = Date.now() + 45_000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      return queryVerifyUpheldReport(orgId, contentHashHex);
    } catch (err) {
      lastErr = String(err);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error(`timed out waiting for verify_upheld_report for ${contentHashHex}: ${lastErr}`);
}

function verifyTier2(
  report: QueryVerifyUpheldReportResponse,
  plaintext: string,
): {
  step1: boolean;
  step2: boolean;
  step3: boolean;
  step4: boolean;
  step5: boolean;
} {
  const salt = decodeB64(report.salt);
  const plaintextHash = decodeB64(report.plaintext_hash);
  const ciphertextHash = decodeB64(report.ciphertext_hash);
  const wrappedDekHash = decodeB64(report.wrapped_dek_hash);
  const contributorSig = decodeB64(report.contributor_sig);
  const encryptedBlob = decodeB64(report.encrypted_blob);
  const wrappedDekEnc = decodeB64(report.wrapped_dek_enc);
  const contentHash = decodeB64(report.content_hash);
  const canonicalBody = decodeB64(report.canonical_body);
  const contributorPubkey = hexToUint8(report.contributor_pubkey);

  const plaintextBytes = new TextEncoder().encode(plaintext);

  const step1 = uint8ToHex(sha256Bytes(concatBytes(salt, plaintextBytes))) === uint8ToHex(plaintextHash);
  const step2 = uint8ToHex(sha256Bytes(encryptedBlob)) === uint8ToHex(ciphertextHash);
  const step3 = uint8ToHex(sha256Bytes(wrappedDekEnc)) === uint8ToHex(wrappedDekHash);
  const step4 = uint8ToHex(sha256Bytes(concatBytes(encryptedBlob, wrappedDekEnc))) === uint8ToHex(contentHash);
  const step5 = verify(contributorPubkey, contributorSig, canonicalBody);

  return { step1, step2, step3, step4, step5 };
}

async function promoteToPendingChain(client: HubClient, orgId: string, submissionHash: string, leader: TestIdentity): Promise<void> {
  const voteResp = await client.voteOnSubmission(orgId, submissionHash, leader);
  console.log('vote response:', JSON.stringify(voteResp));

  const verifyResp = await client.verifyKeywords(
    orgId,
    [
      {
        submission_hash: submissionHash,
        classified: [{ keyword: 'co029sig', weight: 1.0 }],
        suggestions: [],
      },
    ],
    leader,
  );
  console.log('verify-keywords response:', JSON.stringify(verifyResp));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const hubUrl = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';
  const client = new HubClient(hubUrl);

  const health = await client.testHealth();
  console.log('test health:', JSON.stringify(health));

  const leader = generateTestIdentity();
  const attacker = generateTestIdentity();

  const orgId = `co029-org-${Date.now()}`;
  const domain = `${orgId}.test`;
  console.log('org_id:', orgId);
  console.log('leader_pubkey:', leader.pubkeyHex);

  const createResp = await client.createOrg(
    orgId,
    'CO029 Verification Org',
    domain,
    'ab'.repeat(32),
    'enc-envelope-co029',
    'search-envelope-co029',
    'mod-envelope-co029',
    { tier: 'free' },
    leader,
  );
  console.log('create org response:', JSON.stringify(createResp));

  await client.addKeyword(orgId, 'co029sig', leader);
  console.log('added org keyword: co029sig');

  console.log('--- honest smoke submission ---');
  const honest = buildSubmitPayload(
    orgId,
    0,
    leader,
    'CO029 honest plaintext for tier2 verification',
    'memory',
  );
  const honestSubmitResp = await submitMemory(hubUrl, orgId, honest.payload, leader);
  console.log('honest submit status/body:', honestSubmitResp.statusCode, honestSubmitResp.body);

  if (honestSubmitResp.statusCode !== 201) {
    throw new Error('honest submission failed');
  }

  await promoteToPendingChain(client, orgId, honest.payload.submission_hash, leader);
  const honestBatch = await client.batchSubmitToChain(orgId, leader);
  console.log('honest batch-submit response:', JSON.stringify(honestBatch));

  const honestReport = await waitForVerifyUpheldReport(orgId, honest.payload.submission_hash);
  console.log('honest verify_upheld_report:', JSON.stringify(honestReport));

  const honestTier2 = verifyTier2(honestReport, honest.plaintext);
  console.log('honest tier2 step1 sha256(salt||plaintext) == plaintext_hash:', honestTier2.step1 ? 'PASS' : 'FAIL');
  console.log('honest tier2 step2 sha256(encrypted_blob) == ciphertext_hash:', honestTier2.step2 ? 'PASS' : 'FAIL');
  console.log('honest tier2 step3 sha256(wrapped_dek_enc) == wrapped_dek_hash:', honestTier2.step3 ? 'PASS' : 'FAIL');
  console.log('honest tier2 step4 sha256(encrypted_blob||wrapped_dek_enc) == content_hash:', honestTier2.step4 ? 'PASS' : 'FAIL');
  console.log('honest tier2 step5 ed25519 verify contributor_sig over canonical_body:', honestTier2.step5 ? 'PASS' : 'FAIL');

  console.log('--- adversarial 1: tampered plaintext reveal ---');
  const fakePlaintext = 'CO029 tampered plaintext';
  const fakeStep1 = uint8ToHex(
    sha256Bytes(
      concatBytes(
        decodeB64(honestReport.salt),
        new TextEncoder().encode(fakePlaintext),
      ),
    ),
  ) === uint8ToHex(decodeB64(honestReport.plaintext_hash));
  console.log('tampered plaintext step1 expected FAIL:', fakeStep1 ? 'UNEXPECTED_PASS' : 'FAIL_AS_EXPECTED');

  console.log('--- adversarial 2: tampered encrypted_blob post-commit ---');
  const tamperedBlob = randomBytes(96);
  const tamperedStep2 = uint8ToHex(sha256Bytes(tamperedBlob)) === uint8ToHex(decodeB64(honestReport.ciphertext_hash));
  console.log('tampered encrypted_blob step2 expected FAIL:', tamperedStep2 ? 'UNEXPECTED_PASS' : 'FAIL_AS_EXPECTED');

  console.log('--- adversarial 3: forged contributor signature at intake ---');
  const forgedAtIntake = buildSubmitPayload(
    orgId,
    0,
    leader,
    'CO029 forged-intake plaintext',
    'memory',
    attacker,
  );
  const forgedResp = await submitMemory(hubUrl, orgId, forgedAtIntake.payload, leader);
  console.log('forged intake status/body:', forgedResp.statusCode, forgedResp.body);

  const forgedIntakeCount = psql(
    `SELECT count(*) FROM pending_submissions WHERE submission_hash='${forgedAtIntake.payload.submission_hash}'`,
    true,
  );
  console.log('forged intake pending_submissions row count (expected 0):', forgedIntakeCount);

  console.log('--- adversarial 4: mixed batch (A honest, B forged-at-chain, C honest) ---');
  const mixA = buildSubmitPayload(orgId, 0, leader, 'CO029 mixed A', 'memory');
  const mixB = buildSubmitPayload(orgId, 0, leader, 'CO029 mixed B', 'memory');
  const mixC = buildSubmitPayload(orgId, 0, leader, 'CO029 mixed C', 'memory');

  for (const m of [mixA, mixB, mixC]) {
    const resp = await submitMemory(hubUrl, orgId, m.payload, leader);
    console.log('mixed submit status/body:', m.payload.submission_hash, resp.statusCode, resp.body);
    if (resp.statusCode !== 201) {
      throw new Error(`mixed submission failed: ${m.payload.submission_hash}`);
    }
    await promoteToPendingChain(client, orgId, m.payload.submission_hash, leader);
  }

  const tamperedSigHex = Buffer.from(randomBytes(64)).toString('hex');
  console.log('tampering mixed B contributor_sig in pending_submissions');
  console.log(
    psql(
      `UPDATE pending_submissions SET contributor_sig='${tamperedSigHex}' WHERE submission_hash='${mixB.payload.submission_hash}'`,
    ),
  );

  const mixedBatchResp = await client.batchSubmitToChain(orgId, leader);
  console.log('mixed batch-submit response:', JSON.stringify(mixedBatchResp));

  const reportA = await waitForVerifyUpheldReport(orgId, mixA.payload.submission_hash);
  const reportC = await waitForVerifyUpheldReport(orgId, mixC.payload.submission_hash);
  console.log('mixed A query succeeded (expected committed):', reportA.content_hash.length > 0 ? 'YES' : 'NO');
  console.log('mixed C query succeeded (expected committed):', reportC.content_hash.length > 0 ? 'YES' : 'NO');

  let bRejected = false;
  try {
    queryVerifyUpheldReport(orgId, mixB.payload.submission_hash);
  } catch (err) {
    bRejected = true;
    console.log('mixed B query failed as expected:', String(err));
  }
  console.log('mixed B rejected/not stored:', bRejected ? 'YES' : 'NO');

  console.log('--- D-VR closure checks ---');
  const wrappedDekEncLen = decodeB64(honestReport.wrapped_dek_enc).length;
  console.log('D-VR-5 wrapped_dek_enc non-empty length:', wrappedDekEncLen);

  console.log('D-VR-6 rotation_buffer rejects invalid signature');
  console.log(
    psql(
      `UPDATE orgs SET rotation_status='rotation_pending', rotation_pending_since=NOW() WHERE org_id='${orgId}'`,
    ),
  );

  const rotationForged = buildSubmitPayload(
    orgId,
    0,
    leader,
    'CO029 rotation forged',
    'memory',
    attacker,
  );
  const rotationResp = await submitMemory(hubUrl, orgId, rotationForged.payload, leader);
  console.log('rotation forged submit status/body:', rotationResp.statusCode, rotationResp.body);

  await sleep(500);
  const rotationCount = psql(
    `SELECT count(*) FROM rotation_buffer WHERE submission_hash='${rotationForged.payload.submission_hash}'`,
    true,
  );
  console.log('rotation_buffer row count for invalid sig (expected 0):', rotationCount);

  console.log(
    psql(
      `UPDATE orgs SET rotation_status='active', rotation_pending_since=NULL WHERE org_id='${orgId}'`,
    ),
  );

  console.log('runner complete');
}

main().catch((err) => {
  console.error('co029 stage6 runner failed:', err);
  process.exit(1);
});
