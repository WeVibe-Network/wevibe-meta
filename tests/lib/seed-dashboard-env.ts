import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadState } from './state.js';

export function seedDashboardEnv(): void {
  const state = loadState();
  // Resolve the dashboard .env.local relative to the workspace layout
  // (lib -> tests -> wevibe-meta -> workspace root), overridable via env.
  const envPath = process.env.DASHBOARD_ENV_PATH
    ?? fileURLToPath(new URL('../../../wevibe-server/wevibe-dashboard/.env.local', import.meta.url));
  const content = [
    `NEXT_PUBLIC_ORG_ID=${state.orgId}`,
    `NEXT_PUBLIC_WEVIBE_HUB_URL=http://localhost:4440`,
    '',
  ].join('\n');
  writeFileSync(envPath, content);
  console.log(`Dashboard .env.local written with org_id=${state.orgId}`);
  console.log('Restart the dashboard (npm run dev) to pick up the change.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDashboardEnv();
}