import { CONFIG } from './config.js';
import { buildWeVibeSignedHeaders, buildBodySignedPayload } from './auth.js';
import type { TestIdentity } from './identity.js';
import * as canonical from './canonical.js';

export class HubClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? CONFIG.hubUrl;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${method} ${path} → ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  async health(): Promise<{ status: string; db: string }> {
    return this.request('GET', '/health');
  }

  async testHealth(): Promise<{
    status: string; db: string; chain: string;
    chain_id?: string; submitter_address?: string; qdrant: string;
  }> {
    return this.request('GET', '/v1/test/health');
  }

  async testEmbed(text: string): Promise<{ vector: number[]; model: string; dim: number }> {
    return this.request('POST', '/v1/test/embed', { text });
  }

  async createOrg(
    orgId: string, orgName: string, domain: string,
    pkMod: string, encEnvelope: string, searchEnvelope: string, modEnvelope: string,
    feeModel: canonical.FeeModel, leader: TestIdentity,
  ): Promise<{ org_id: string }> {
    const msg = canonical.createOrgMessage(
      orgId, leader.pubkeyHex, leader.xPubkeyHex,
      orgName, domain, encEnvelope, searchEnvelope, modEnvelope,
      pkMod, feeModel,
    );
    const payload = buildBodySignedPayload(leader, {
      org_id: orgId,
      leader_pubkey: leader.pubkeyHex,
      leader_x25519_pubkey: leader.xPubkeyHex,
      org_name: orgName,
      domain,
      fee_model: feeModel,
      pk_mod: pkMod,
      enc_envelope: encEnvelope,
      search_envelope: searchEnvelope,
      mod_envelope: modEnvelope,
    }, msg);
    return this.request('POST', '/v1/orgs', payload);
  }

  async getOrg(orgId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/orgs/${orgId}`);
  }

  async inviteMember(
    orgId: string, pubkey: string, xPubkey: string, role: string,
    encEnvelope: string, searchEnvelope: string, modEnvelope: string,
    leader: TestIdentity,
  ): Promise<Record<string, unknown>> {
    const msg = canonical.inviteMemberMessage(
      orgId, pubkey, xPubkey, role, leader.pubkeyHex,
      encEnvelope, searchEnvelope, modEnvelope,
    );
    const payload = buildBodySignedPayload(leader, {
      pubkey,
      x25519_pubkey: xPubkey,
      role,
      enc_envelope: encEnvelope,
      search_envelope: searchEnvelope,
      mod_envelope: modEnvelope,
    }, msg);
    const headers = buildWeVibeSignedHeaders(leader);
    return this.request('POST', `/v1/orgs/${orgId}/members`, payload, headers);
  }

  async listMembers(orgId: string): Promise<Record<string, unknown>[]> {
    return this.request('GET', `/v1/orgs/${orgId}/members`);
  }

  async submitMemory(orgId: string, body: {
    org_id: string; epoch_id: number; ciphertext: string;
    wrapped_dek_mod: string; submission_hash: string;
    contributor_pubkey: string; contributor_sig: string; stack_hint: string[];
    memory_type: string;
    plaintext_hash?: string; salt?: string;
    ciphertext_hash?: string; wrapped_dek_hash?: string;
  }, identity: TestIdentity): Promise<{ submission_hash: string; status: string }> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/submit`, body, headers);
  }

  async voteOnSubmission(orgId: string, submissionHash: string, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/moderation/${submissionHash}/vote`, undefined, headers);
  }

  async getModerationQueue(orgId: string, identity: TestIdentity): Promise<Record<string, unknown>[]> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('GET', `/v1/orgs/${orgId}/moderation/queue`, undefined, headers);
  }

  async approveSubmission(
    orgId: string, submissionHash: string, body: Record<string, unknown>,
    identity: TestIdentity,
  ): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/moderation/${submissionHash}/approve`, body, headers);
  }

  async denySubmission(
    orgId: string, submissionHash: string,
    reason: string, identity: TestIdentity,
  ): Promise<Record<string, unknown>> {
    const msg = canonical.denySubmissionMessage(orgId, submissionHash, reason, identity.pubkeyHex);
    const payload = buildBodySignedPayload(identity, { reason }, msg);
    return this.request('POST', `/v1/orgs/${orgId}/moderation/${submissionHash}/deny`, payload);
  }

  async batchSubmitToChain(orgId: string, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/moderation/batch-submit`, {}, headers);
  }

  async addKeyword(orgId: string, keyword: string, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/keywords`, { keyword }, headers);
  }

  async verifyKeywords(
    orgId: string,
    memories: Array<{
      submission_hash: string;
      classified: Array<{ keyword: string; weight: number }>;
      suggestions: Array<{ keyword: string; weight: number; rationale: string }>;
    }>,
    identity: TestIdentity,
  ): Promise<{ verified: number; results: Array<{ submission_hash?: string; error?: string }> }> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/verify-keywords`, { memories }, headers);
  }

  async batchChainSubmit(
    orgId: string,
    submissionHashes: string[],
    identity: TestIdentity,
  ): Promise<{ tx_hash?: string; committed_count: number; errors?: string[] }> {
    const headers = buildWeVibeSignedHeaders(identity);
    const response = await this.request<{
      tx_hash?: string;
      committed_count?: number;
      errors?: string[];
      submitted?: number;
      failed?: number;
      results?: Array<{ hash?: string; tx_hash?: string; error?: string }>;
    }>('POST', `/v1/orgs/${orgId}/moderation/batch-submit`, {}, headers);

    if (typeof response.committed_count === 'number') {
      return {
        tx_hash: response.tx_hash,
        committed_count: response.committed_count,
        errors: response.errors,
      };
    }

    const results = response.results ?? [];
    const errors = results
      .filter((r) => typeof r.error === 'string' && r.error.length > 0)
      .map((r) => `${r.hash ?? 'unknown'}: ${r.error as string}`);
    const firstTxHash = results.find((r) => typeof r.tx_hash === 'string' && r.tx_hash.length > 0)?.tx_hash;

    return {
      tx_hash: firstTxHash,
      committed_count: response.submitted ?? 0,
      errors,
    };
  }

  async queryMemories(orgId: string, body: {
    org_id: string; agent_pubkey: string; keyword_weights: canonical.KeywordWithWeight[];
    vector: number[]; limit: number; agent_sig: string;
  }): Promise<{ results: Record<string, unknown>[]; contested: boolean; receipt_id: string }> {
    return this.request('POST', `/v1/orgs/${orgId}/query`, body);
  }

  async getMemory(orgId: string, cid: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/orgs/${orgId}/memories/${cid}`);
  }

  async listMemories(orgId: string): Promise<{ memories: Record<string, unknown>[]; count: number }> {
    return this.request('GET', `/v1/orgs/${orgId}/memories`);
  }

  async recordServe(orgId: string, body: Record<string, unknown>, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/serves`, body, headers);
  }

  async createReport(orgId: string, body: { memory_cid: string; reason: string; note?: string }, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/reports`, body, headers);
  }

  async listReports(orgId: string, identity: TestIdentity): Promise<{ reports: Record<string, unknown>[]; total: number }> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('GET', `/v1/orgs/${orgId}/reports`, undefined, headers);
  }

  async rejectMemory(orgId: string, body: {
    cid: string; org_id: string; reason: string; agent_pubkey: string; signature: string;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/orgs/${orgId}/reject`, body);
  }

  async getCredits(orgId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/orgs/${orgId}/credits`);
  }

  async testUpdateRole(orgId: string, pubkey: string, newRole: string): Promise<{ status: string; new_role: string }> {
    return this.request('PATCH', `/v1/test/orgs/${orgId}/members/role`, { pubkey, new_role: newRole });
  }

  async testGetQueue(orgId: string): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', `/v1/test/orgs/${orgId}/queue`);
  }

  async removeMember(orgId: string, pubkey: string, leader: TestIdentity): Promise<{ status: string }> {
    const msg = canonical.removeMemberMessage(orgId, pubkey, leader.pubkeyHex);
    const payload = buildBodySignedPayload(leader, {}, msg);
    return this.request('DELETE', `/v1/orgs/${orgId}/members/${pubkey}`, payload);
  }

  async updateReport(orgId: string, reportId: string, action: string, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('PATCH', `/v1/orgs/${orgId}/reports/${reportId}`, { action }, headers);
  }

  async registerDashboardKey(orgId: string, body: Record<string, unknown>, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('POST', `/v1/orgs/${orgId}/dashboard/keys`, body, headers);
  }

  async updateOrgConfig(orgId: string, body: { required_approvals: number }, identity: TestIdentity): Promise<Record<string, unknown>> {
    const headers = buildWeVibeSignedHeaders(identity);
    return this.request('PATCH', `/v1/orgs/${orgId}/config`, body, headers);
  }

  async rotateEpoch(orgId: string, body: Record<string, unknown>, leader: TestIdentity): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/orgs/${orgId}/epoch/rotate`, body);
  }

  async getOrgDetails(orgId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/orgs/${orgId}`);
  }
}
