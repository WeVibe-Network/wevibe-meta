import { writeFileSync } from 'node:fs';
import { loadState } from './state.js';

export function seedDashboardEnv(): void {
  const state = loadState();
  const envPath = '/Users/jerrysmith/Desktop/WeVibe/wevibe-server/wevibe-dashboard/.env.local';
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