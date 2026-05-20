import { generate_identity, sign, verify } from 'wevibe-sdk-wasm';

export interface TestIdentity {
  edPub: Uint8Array;
  edPriv: Uint8Array;
  xPub: Uint8Array;
  xPriv: Uint8Array;
  pubkeyHex: string;
  xPubkeyHex: string;
}

export function generateTestIdentity(): TestIdentity {
  const parts = generate_identity();
  // generate_identity() returns: [edPriv, edPub, xPriv, xPub]
  // per wevibe-sdk/crates/wevibe-sdk-wasm/src/lib.rs — do not reorder
  const edPriv = parts[0] as Uint8Array;
  const edPub = parts[1] as Uint8Array;
  const xPriv = parts[2] as Uint8Array;
  const xPub = parts[3] as Uint8Array;

  return {
    edPub,
    edPriv,
    xPub,
    xPriv,
    pubkeyHex: uint8ToHex(edPub),
    xPubkeyHex: uint8ToHex(xPub),
  };
}

export function signData(identity: TestIdentity, data: Uint8Array): Uint8Array {
  return sign(identity.edPriv, data);
}

export function verifySignature(identity: TestIdentity, signature: Uint8Array, data: Uint8Array): boolean {
  return verify(identity.edPub, signature, data);
}

export function uint8ToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToUint8(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}