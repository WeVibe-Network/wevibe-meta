# wevibe-meta

Workspace orchestration for WeVibe Network development.

This repository contains the meta-tooling for the 10-repo WeVibe Network
codebase. It is not a product itself - it is the dev environment.

## What lives here

- `.meta` - config for the [meta](https://github.com/mateodelnorte/meta) tool,
  listing the 10 product repos
- `Makefile` - top-level orchestration (`make dogfood`, `make setup`, etc.)
- `start.sh`, `stop.sh`, `setup.sh`, `clear.sh`, `gather.sh` - runtime helpers
- `tests/` - end-to-end tests by participant role
- `workspace/templates/` - reusable artifact templates (CO template, etc.)
- `workspace/reports/` - per-CO worker output (gitignored)

## Setup

```
npm install -g meta
git clone git@github.com:WeVibe-Network/wevibe-meta.git
cd wevibe-meta
meta git clone
```

This clones all 10 product repos alongside `wevibe-meta/`.

## Common commands

- `make dogfood` - full stack up, run Stage 1 + Stage 2 smoke tests
- `make setup` - first-time environment setup
- `make clear` - wipe local state (databases, keystores)
- `meta git status` - status across all 10 repos
- `meta git pull` - pull all 10 repos

## License

Apache-2.0. See LICENSE.
