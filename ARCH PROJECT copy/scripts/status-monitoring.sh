#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=========================================================="
echo "    LOGGING STACK CONTAINER & HEALTH STATUS               "
echo "=========================================================="

echo "--- Docker Containers ---"
docker compose -f monitoring/docker-compose.yml ps

echo ""
echo "--- Loki Health Check (:3100) ---"
curl -s http://localhost:3100/ready && echo " -> Loki is ready" || echo " -> Loki not reachable"

echo ""
echo "--- Grafana Datasource Health (:3002) ---"
curl -s -u admin:admin http://localhost:3002/api/datasources | node -e '
  try {
    const ds = JSON.parse(require("fs").readFileSync(0, "utf-8"));
    if (Array.isArray(ds)) {
      ds.forEach(d => console.log(`[DATASOURCE] ${d.name.padEnd(12)} (${d.type}) -> ${d.url} (Default: ${d.isDefault})`));
    }
  } catch (e) {
    console.log("Could not reach Grafana datasources API.");
  }
'

echo ""
echo "Loki:              http://localhost:3100"
echo "Alloy:             http://localhost:12345"
echo "Grafana:           http://localhost:3002 (admin / admin)"
echo "Logs Dashboard:    http://localhost:3002/d/arch-centralized-logs"
echo "=========================================================="
