#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=========================================================="
echo "    STOPPING LOGGING STACK (LOKI, ALLOY, GRAFANA)        "
echo "=========================================================="

docker compose -f monitoring/docker-compose.yml down

echo "Monitoring containers stopped."
echo "=========================================================="
