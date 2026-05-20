import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { loadState, getIdentity, updateState } from '../lib/state.js';
import { generate_dek, seal_to_pubkey } from 'wevibe-sdk-wasm';
import { uint8ToHex } from '../lib/identity.js';

describe('leader: invite-members', () => {
  const client = new HubClient();

  it('invites moderator, contributor, and consumer', async () => {
    const state = loadState();
    const leader = getIdentity(state, 'leader');

    const modPubkey = getIdentity(state, 'moderator').xPub;
    const encDek = generate_dek();
    const encEnvelope = uint8ToHex(seal_to_pubkey(encDek, modPubkey));
    const searchDek = generate_dek();
    const searchEnvelope = uint8ToHex(seal_to_pubkey(searchDek, modPubkey));
    const modDek = generate_dek();
    const modEnvelope = uint8ToHex(seal_to_pubkey(modDek, modPubkey));

    const moderator = getIdentity(state, 'moderator');
    await client.inviteMember(
      state.orgId, moderator.pubkeyHex, moderator.xPubkeyHex, 'moderator',
      encEnvelope, searchEnvelope, modEnvelope, leader,
    );

    const contributor = getIdentity(state, 'contributor');
    await client.inviteMember(
      state.orgId, contributor.pubkeyHex, contributor.xPubkeyHex, 'member',
      encEnvelope, searchEnvelope, modEnvelope, leader,
    );

    const consumer = getIdentity(state, 'consumer');
    await client.inviteMember(
      state.orgId, consumer.pubkeyHex, consumer.xPubkeyHex, 'member',
      encEnvelope, searchEnvelope, modEnvelope, leader,
    );

    const members = await client.listMembers(state.orgId);
    expect(members.length).toBe(4);

    updateState({ currentEpoch: 1 });
  });
});