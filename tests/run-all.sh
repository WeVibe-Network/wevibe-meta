#!/usr/bin/env bash
set -euo pipefail

echo "=== WeVibe Integration Test Suite ==="
echo "Mode: ${1:-}"
echo ""

case "${1:-}" in
  seed)
    npx tsx lib/seeder.ts ;;
  leader)
    npx tsx leader/index.ts ;;
  mod|moderator)
    npx tsx moderator/index.ts ;;
  contrib|contributor)
    npx tsx contributor/index.ts ;;
  consumer)
    npx tsx consumer/index.ts ;;
  e2e)
    npx vitest run e2e/ ;;
  e2e:lifecycle)
    npx vitest run e2e/full-lifecycle.test.ts ;;
  e2e:stress)
    npx vitest run e2e/stress.test.ts ;;
  e2e:health)
    npx vitest run e2e/service-health.test.ts ;;
  dogfood)
    npx vitest run e2e/dogfood-pipeline.test.ts --reporter=verbose ;;
  all)
    npx vitest run ;;
  typecheck)
    npx tsc --noEmit ;;
  lib)
    npx vitest run lib/ ;;
  *)
    echo "Usage: ./run-all.sh {seed|leader|mod|contrib|consumer|e2e|e2e:lifecycle|e2e:stress|e2e:health|all|typecheck|lib}"
    echo ""
    echo "Modes:"
    echo "  seed         - Seed full scenario (DB reset, org, 4 members, 5 memories, 2 reports)"
    echo "  leader       - Interactive leader scenarios (17 scenarios)"
    echo "  mod          - Interactive moderator scenarios (10 scenarios)"
    echo "  contrib      - Interactive contributor scenarios (8 scenarios)"
    echo "  consumer     - Interactive consumer scenarios (11 scenarios)"
    echo "  e2e          - All e2e vitest tests"
    echo "  e2e:lifecycle - 12-phase full lifecycle test"
    echo "  e2e:stress    - Stress scenarios (50 rapid submits, concurrent queries)"
    echo "  e2e:health   - Service health check"
    echo "  all          - Run all vitest tests"
    echo "  typecheck    - TypeScript type check only"
    echo "  lib          - Library unit tests (canonical, crypto, auth)"
    exit 1 ;;
esac