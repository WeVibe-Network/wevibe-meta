import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CONFIG } from './config.js';
import { generateTestIdentity, uint8ToHex, hexToUint8, type TestIdentity } from './identity.js';

interface SerializedIdentity {
  edPubHex: string;
  edPrivHex: string;
  xPubHex: string;
  xPrivHex: string;
}

export interface SubmissionRecord {
  hash: string;
  plaintext: string;
  ciphertextHex: string;
  wrappedDekModHex: string;
  dek: string;
  stackHint: string[];
  status: 'pending' | 'approved' | 'denied';
  approvedCid?: string;
}

export interface ReportRecord {
  id: string;
  memoryCid: string;
  reason: string;
  status: string;
}

export interface TestState {
  orgId: string;
  orgName: string;
  domain: string;
  currentEpoch: number;
  pkModHex: string;
  identities: {
    leader: SerializedIdentity;
    moderator: SerializedIdentity;
    contributor: SerializedIdentity;
    consumer: SerializedIdentity;
  };
  envelopes: {
    enc: string;
    search: string;
    mod: string;
  };
  submissionHashes: string[];
  approvedCIDs: string[];
  submissions: SubmissionRecord[];
  reports: ReportRecord[];
}

function serializeIdentity(id: TestIdentity): SerializedIdentity {
  return {
    edPubHex: uint8ToHex(id.edPub),
    edPrivHex: uint8ToHex(id.edPriv),
    xPubHex: uint8ToHex(id.xPub),
    xPrivHex: uint8ToHex(id.xPriv),
  };
}

function deserializeIdentity(s: SerializedIdentity): TestIdentity {
  return {
    edPub: hexToUint8(s.edPubHex),
    edPriv: hexToUint8(s.edPrivHex),
    xPub: hexToUint8(s.xPubHex),
    xPriv: hexToUint8(s.xPrivHex),
    pubkeyHex: s.edPubHex,
    xPubkeyHex: s.xPubHex,
  };
}

export function generateFreshState(): TestState {
  const ts = Date.now();
  return {
    orgId: `${CONFIG.testOrgPrefix}-${ts}`,
    orgName: `Test Org ${ts}`,
    domain: `test-${ts}.wevibe.dev`,
    currentEpoch: 1,
    pkModHex: '',
    identities: {
      leader: serializeIdentity(generateTestIdentity()),
      moderator: serializeIdentity(generateTestIdentity()),
      contributor: serializeIdentity(generateTestIdentity()),
      consumer: serializeIdentity(generateTestIdentity()),
    },
    envelopes: { enc: '', search: '', mod: '' },
    submissionHashes: [],
    approvedCIDs: [],
    submissions: [],
    reports: [],
  };
}

export function saveState(state: TestState): void {
  writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

export function loadState(): TestState {
  if (!existsSync(CONFIG.stateFile)) {
    throw new Error(`No test state found at ${CONFIG.stateFile}. Run the leader flow first.`);
  }
  return JSON.parse(readFileSync(CONFIG.stateFile, 'utf-8'));
}

export function getIdentity(state: TestState, role: 'leader' | 'moderator' | 'contributor' | 'consumer'): TestIdentity {
  return deserializeIdentity(state.identities[role]);
}

export function updateState(partial: Partial<TestState>): TestState {
  const state = loadState();
  const updated = { ...state, ...partial };
  saveState(updated);
  return updated;
}