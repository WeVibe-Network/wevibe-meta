import { describe, it, expect } from 'vitest';
import { createOrgMessage, inviteMemberMessage, approveSubmissionMessage, denySubmissionMessage, removeMemberMessage } from './canonical.js';
import { createHash } from 'node:crypto';

describe('canonical message parity with Go', () => {
  it('createOrgMessage produces deterministic output', () => {
    const msg = createOrgMessage(
      'test-org-1', 'aa'.repeat(32), 'bb'.repeat(32),
      'Test Org', 'test.com', 'enc_env_hex', 'search_env_hex',
      'mod_env_hex', 'pk_mod_hex',
      { tier: 'starter', monthly_credits: 1000, per_query_cost: 1, currency: 'USD' },
    );
    const text = new TextDecoder().decode(msg);
    expect(text.startsWith('wevibe.create_org.v1\n')).toBe(true);
    const lines = text.split('\n').slice(1);
    const keys = lines.map(l => l.split(':')[0]);
    const sortedKeys = [...keys].sort();
    expect(keys).toEqual(sortedKeys);
    const msg2 = createOrgMessage(
      'test-org-1', 'aa'.repeat(32), 'bb'.repeat(32),
      'Test Org', 'test.com', 'enc_env_hex', 'search_env_hex',
      'mod_env_hex', 'pk_mod_hex',
      { tier: 'starter', monthly_credits: 1000, per_query_cost: 1, currency: 'USD' },
    );
    expect(msg).toEqual(msg2);
  });

  it('denySubmissionMessage matches expected format', () => {
    const msg = denySubmissionMessage('org-1', 'hash123', 'spam', 'cc'.repeat(32));
    const text = new TextDecoder().decode(msg);
    expect(text).toBe([
      'wevibe.deny_submission.v1',
      'org_id:org-1',
      'reason:spam',
      `signed_by:${'cc'.repeat(32)}`,
      'submission_hash:hash123',
    ].join('\n'));
  });

  it('approveSubmissionMessage includes keywords hash', () => {
    const msg = approveSubmissionMessage(
      'org-1', 'hash123', 1, 'cid456', 'dek_enc_hex', 'dd'.repeat(32),
      [{ keyword: 'nginx', weight: 0.8 }, { keyword: 'docker', weight: 0.6 }],
    );
    const text = new TextDecoder().decode(msg);
    expect(text).toContain('keywords_hash:');
    const kwHash = createHash('sha256')
      .update('docker:0.600000\nnginx:0.800000')
      .digest('hex');
    expect(text).toContain(`keywords_hash:${kwHash}`);
  });

  it('removeMemberMessage matches expected format', () => {
    const msg = removeMemberMessage('org-1', 'member_pubkey_hex', 'leader_pubkey_hex');
    const text = new TextDecoder().decode(msg);
    expect(text).toBe([
      'wevibe.remove_member.v1',
      'org_id:org-1',
      'pubkey:member_pubkey_hex',
      'signed_by:leader_pubkey_hex',
    ].join('\n'));
  });
});