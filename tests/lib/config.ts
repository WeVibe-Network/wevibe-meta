export const CONFIG = {
  hubUrl: process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440',
  chainRpcUrl: process.env.WEVIBE_CHAIN_RPC ?? 'http://localhost:26657',
  qdrantUrl: process.env.WEVIBE_QDRANT_URL ?? 'http://localhost:6333',
  dashboardUrl: process.env.WEVIBE_DASHBOARD_URL ?? 'http://localhost:3000',
  ollamaUrl: process.env.WEVIBE_OLLAMA_URL ?? 'http://localhost:11434',
  wevibeMcpHttpUrl: process.env.WEVIBE_MCP_HTTP_URL ?? 'http://127.0.0.1:4452',
  testOrgPrefix: 'test-org',
  stateFile: new URL('../.test-state.json', import.meta.url).pathname,
} as const;
