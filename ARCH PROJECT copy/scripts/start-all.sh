#!/usr/bin/env bash
# Starts all services across the multi-application architecture

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=========================================================="
echo "    STARTING FULL MULTI-APPLICATION ARCHITECTURE STACK    "
echo "=========================================================="

# 1. Stop any previously hanging ports
"$PROJECT_ROOT/scripts/stop-all.sh" > /dev/null 2>&1 || true
sleep 1

# 2. Launch all services via centralized runner
nohup node "$PROJECT_ROOT/scripts/runner.js" </dev/null > /tmp/runner_all.log 2>&1 &

disown -a 2>/dev/null || true
sleep 3

echo "=========================================================="
echo "  All 4 applications & 3 replicas started successfully!   "
echo "  - Auth Application:    http://localhost:3001"
echo "  - Next.js Web App:     http://localhost:3000"
echo "  - Notes Application:   http://localhost:3003"
echo "  - Hybrid Frontend:     http://localhost:3004"
echo "  - Hybrid Backend:      http://localhost:3005"
echo "  - API Gateway:         http://localhost:5001"
echo "  - Product Replicas:    http://localhost:6001, 6002, 6003"
echo "=========================================================="
