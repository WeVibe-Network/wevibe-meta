import { describe, it, expect } from 'vitest';
import { HubClient } from '../lib/hub-client.js';
import { CONFIG } from '../lib/config.js';

describe('service health', () => {
  const client = new HubClient();

  it('hub is healthy with DB connected', async () => {
    const h = await client.health();
    expect(h.status).toBe('ok');
    expect(h.db).toBe('connected');
  });

  it('hub has chain and qdrant connected', async () => {
    const h = await client.testHealth();
    expect(h.chain).toBe('connected');
    expect(h.qdrant).toBe('connected');
    expect(h.submitter_address).toBeTruthy();
  });

  it('chain RPC is responsive', async () => {
    const resp = await fetch(`${CONFIG.chainRpcUrl}/status`);
    expect(resp.ok).toBe(true);
  });

  it('qdrant is responsive', async () => {
    const resp = await fetch(`${CONFIG.qdrantUrl}/healthz`);
    expect(resp.ok).toBe(true);
  });

  it('dashboard is responsive', async () => {
    const resp = await fetch(CONFIG.dashboardUrl);
    expect(resp.status).toBeLessThan(500);
  });
});