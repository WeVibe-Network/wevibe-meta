import { createHash } from 'node:crypto';

export interface FeeModel {
  tier?: string;
  monthly_credits?: number;
  per_query_cost?: number;
  overage_multiplier?: number;
  currency?: string;
}

export interface KeywordWithWeight {
  keyword: string;
  weight: number;
}

export interface MemberEnvelopePair {
  pubkey: string;
  enc_envelope: string;
  search_envelope: string;
  mod_envelope?: string;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function feeModelHash(fm: FeeModel): string {
  const parts: string[] = [];
  if (fm.tier) parts.push(`"tier":"${fm.tier}"`);
  if (fm.monthly_credits) parts.push(`"monthly_credits":${fm.monthly_credits}`);
  if (fm.per_query_cost) parts.push(`"per_query_cost":${fm.per_query_cost}`);
  if (fm.overage_multiplier) parts.push(`"overage_multiplier":${fm.overage_multiplier}`);
  if (fm.currency) parts.push(`"currency":"${fm.currency}"`);
  const canonical = `{${parts.join(',')}}`;
  return sha256hex(canonical);
}

function envelopesHash(envelopes: MemberEnvelopePair[]): string {
  const sorted = [...envelopes].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  const entries = sorted.map(e => {
    const modEnv = e.mod_envelope ?? '';
    return [
      `enc_envelope:${e.enc_envelope}`,
      `mod_envelope:${modEnv}`,
      `pubkey:${e.pubkey}`,
      `search_envelope:${e.search_envelope}`,
    ].join('\n');
  });
  const joined = entries.join('\n--\n');
  return sha256hex(joined);
}

function keywordsHash(keywords: KeywordWithWeight[]): string {
  const sorted = [...keywords].sort((a, b) => a.keyword.localeCompare(b.keyword));
  const entries = sorted.map(kw => `${kw.keyword}:${kw.weight.toFixed(6)}`);
  const joined = entries.join('\n');
  return sha256hex(joined);
}

export function createOrgMessage(
  orgId: string, leaderPubkey: string, leaderX25519Pubkey: string,
  orgName: string, domain: string, encEnvelope: string,
  searchEnvelope: string, modEnvelope: string, pkMod: string,
  feeModel: FeeModel,
): Uint8Array {
  const fmHash = feeModelHash(feeModel);
  const msg = [
    'wevibe.create_org.v1',
    `domain:${domain}`,
    `enc_envelope:${encEnvelope}`,
    `fee_model_hash:${fmHash}`,
    `leader_pubkey:${leaderPubkey}`,
    `leader_x25519_pubkey:${leaderX25519Pubkey}`,
    `mod_envelope:${modEnvelope}`,
    `org_id:${orgId}`,
    `org_name:${orgName}`,
    `pk_mod:${pkMod}`,
    `search_envelope:${searchEnvelope}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function inviteMemberMessage(
  orgId: string, pubkey: string, x25519Pubkey: string,
  role: string, signedBy: string, encEnvelope: string,
  searchEnvelope: string, modEnvelope: string,
): Uint8Array {
  const msg = [
    'wevibe.invite_member.v1',
    `enc_envelope:${encEnvelope}`,
    `mod_envelope:${modEnvelope}`,
    `org_id:${orgId}`,
    `pubkey:${pubkey}`,
    `role:${role}`,
    `search_envelope:${searchEnvelope}`,
    `signed_by:${signedBy}`,
    `x25519_pubkey:${x25519Pubkey}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function rotateEpochMessage(
  orgId: string, newPkMod: string, signedBy: string,
  envelopes: MemberEnvelopePair[],
): Uint8Array {
  const envHash = envelopesHash(envelopes);
  const msg = [
    'wevibe.rotate_epoch.v1',
    `envelopes_hash:${envHash}`,
    `new_pk_mod:${newPkMod}`,
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function removeMemberMessage(
  orgId: string, pubkey: string, signedBy: string,
): Uint8Array {
  const msg = [
    'wevibe.remove_member.v1',
    `org_id:${orgId}`,
    `pubkey:${pubkey}`,
    `signed_by:${signedBy}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function submitMemoryMessage(
  orgId: string,
  epochId: number,
  submissionHash: string,
  contributorPubkey: string,
  memoryType: string,
): Uint8Array {
  const msg = [
    'wevibe.submit_memory.v1',
    `contributor_pubkey:${contributorPubkey}`,
    `epoch_id:${epochId}`,
    `memory_type:${memoryType}`,
    `org_id:${orgId}`,
    `submission_hash:${submissionHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function approveSubmissionMessage(
  orgId: string, submissionHash: string, epochId: number,
  approvedCid: string, wrappedDekEnc: string, signedBy: string,
  keywords: KeywordWithWeight[],
): Uint8Array {
  const kwHash = keywordsHash(keywords);
  const msg = [
    'wevibe.approve_submission.v1',
    `approved_cid:${approvedCid}`,
    `keywords_hash:${kwHash}`,
    `epoch_id:${epochId}`,
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
    `wrapped_dek_enc:${wrappedDekEnc}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function approveSubmissionMessageSimple(
  orgId: string,
  submissionHash: string,
  epochId: number,
  memoryType: string,
  signedBy: string,
): Uint8Array {
  const msg = [
    'wevibe.approve_submission.v2',
    `epoch_id:${epochId}`,
    `memory_type:${memoryType}`,
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function denySubmissionMessage(
  orgId: string, submissionHash: string, reason: string, signedBy: string,
): Uint8Array {
  const msg = [
    'wevibe.deny_submission.v1',
    `org_id:${orgId}`,
    `reason:${reason}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}
