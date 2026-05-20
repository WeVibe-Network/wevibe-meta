import { signData, uint8ToHex, type TestIdentity } from './identity.js';

export function buildWeVibeSignedHeaders(identity: TestIdentity): Record<string, string> {
  const timestamp = new Date().toISOString();
  const timestampBytes = new TextEncoder().encode(timestamp);
  const sig = signData(identity, timestampBytes);
  const sigHex = uint8ToHex(sig);

  return {
    'Authorization': `WeVibe-Signed pubkey=${identity.pubkeyHex},timestamp=${timestamp},signature=${sigHex}`,
    'Content-Type': 'application/json',
  };
}

export function buildBodySignedPayload<T extends Record<string, unknown>>(
  identity: TestIdentity,
  body: T,
  canonicalMessage: Uint8Array,
): T & { signed_by: string; signature: string } {
  const sig = signData(identity, canonicalMessage);
  return {
    ...body,
    signed_by: identity.pubkeyHex,
    signature: uint8ToHex(sig),
  };
}