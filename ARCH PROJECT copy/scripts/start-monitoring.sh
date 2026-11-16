#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Ensure logs directory exists on host so Docker volume mount works properly
mkdir -p "$PROJECT_ROOT/logs"

echo "=========================================================="
echo "    STARTING LOGGING STACK (LOKI, ALLOY, GRAFANA)        "
echo "=========================================================="

docker compose -f monitoring/docker-compose.yml up -d

echo ""
echo "Grafana Loki Logs:    http://localhost:3100"
echo "Grafana Alloy Agent:  http://localhost:12345"
echo "Grafana UI:           http://localhost:3002 (admin / admin)"
echo "Logs Dashboard:       http://localhost:3002/d/arch-centralized-logs"
echo "=========================================================="
