import {
  generate_dek, encrypt_symmetric, decrypt_symmetric,
  seal_to_pubkey, open_envelope,
} from 'wevibe-sdk-wasm';
import { createHash } from 'node:crypto';
import { signData, uint8ToHex, hexToUint8, type TestIdentity } from './identity.js';

export { generate_dek, encrypt_symmetric, decrypt_symmetric, seal_to_pubkey, open_envelope };

export function encryptMemory(plaintext: string, modPubkey: Uint8Array): {
  ciphertextHex: string;
  wrappedDekModHex: string;
  submissionHash: string;
  dek: Uint8Array;
} {
  const dek = generate_dek();
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = encrypt_symmetric(plaintextBytes, dek);
  const wrappedDekMod = seal_to_pubkey(dek, modPubkey);

  const hashInput = Buffer.concat([Buffer.from(ciphertext), Buffer.from(wrappedDekMod)]);
  const submissionHash = createHash('sha256').update(hashInput).digest('hex');

  return {
    ciphertextHex: uint8ToHex(ciphertext),
    wrappedDekModHex: uint8ToHex(wrappedDekMod),
    submissionHash,
    dek,
  };
}

export function signSubmission(identity: TestIdentity, submissionHash: string): string {
  const hashBytes = hexToUint8(submissionHash);
  const sig = signData(identity, hashBytes);
  return uint8ToHex(sig);
}

export function decryptMemory(
  ciphertextHex: string, wrappedDekEncHex: string, encKey: Uint8Array,
): string {
  const wrappedDekEnc = hexToUint8(wrappedDekEncHex);
  const dek = decrypt_symmetric(wrappedDekEnc, encKey);
  const ciphertext = hexToUint8(ciphertextHex);
  const plaintext = decrypt_symmetric(ciphertext, dek);
  return new TextDecoder().decode(plaintext);
}