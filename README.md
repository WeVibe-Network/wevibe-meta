# wevibe-meta

Developer tooling and local-orchestration for the [WeVibe Network](https://github.com/WeVibe-Network)
multi-repository workspace.

This repository is **not a product** — it is the development environment that ties the
WeVibe Network repositories together so they can be cloned, built, run, and tested as one
local stack.

## What lives here

- **`.meta`** — configuration for the [meta](https://github.com/mateodelnorte/meta) tool.
  It lists the WeVibe Network repositories so they can be cloned and managed together.
- **`Makefile`** — top-level orchestration: bring the full Docker stack up/down, run the
  integration ("dogfood") smoke tests, check service health, regenerate protobuf code, and
  sync the SDK WASM bundle into the dashboard.
- **`start.sh` / `stop.sh` / `clear.sh`** — host-process lifecycle helpers for running the
  services directly on your machine (build + start, stop, and wipe local state).
- **`tests/`** — end-to-end integration tests organized by participant role
  (`consumer/`, `contributor/`, `leader/`, `moderator/`, and full-stack `e2e/`).
- **`scripts/`** — decay-model calibration and empirical-replay tooling used to validate the
  memory ranking/decay behaviour against the chain.

## Setup

```bash
npm install -g meta
git clone git@github.com:WeVibe-Network/wevibe-meta.git
cd wevibe-meta
meta git clone   # clones all WeVibe Network repos alongside wevibe-meta/
```

This produces a workspace with `wevibe-meta/` and every product repository as siblings.

## Common commands

| Command | Description |
| --- | --- |
| `make docker-up` | Build and start the full Docker stack |
| `make docker-down` | Stop the stack and remove volumes |
| `make dogfood` | Bring the stack up and run the integration smoke tests |
| `make health` | Check that each service is responding |
| `make proto-gen` | Regenerate protobuf code (Docker-pinned toolchain) |
| `meta git status` | Git status across all repositories |
| `meta git pull` | Pull all repositories |

## Repository layout

The full network and its responsibilities are described in
[wevibe-docs](https://github.com/WeVibe-Network/wevibe-docs). The stack is composed of the
chain (`wevibe-chain`), the backend and UI (`wevibe-server`), the local client
(`wevibe-mcp`), the crypto SDK (`wevibe-sdk`), the security sidecars (`wevibe-guard`,
`wevibe-umbral`), the protocol contracts (`wevibe-protocol`), the social-graph display
service (`wevibe-social-graph`), the testnet faucet (`wevibe-faucet`), and the editor
integration (`wevibe-opencode-plugin`).

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Links

- Documentation: https://github.com/WeVibe-Network/wevibe-docs
- Organization: https://github.com/WeVibe-Network
- X / Twitter: https://x.com/WeVibe_Network
