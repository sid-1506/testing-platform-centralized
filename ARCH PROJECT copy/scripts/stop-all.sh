#!/usr/bin/env bash
# Stops all active project servers running on ports 3000, 3001, 3003, 3004, 3005, 5001, 6001, 6002, 6003

echo "[SCRIPT] Stopping any processes on ports 3000, 3001, 3003, 3004, 3005, 5001, 6001, 6002, 6003..."
for port in 3000 3001 3003 3004 3005 5001 6001 6002 6003; do
  pids=$(lsof -ti :$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing process on port $port (PID: $pids)..."
    kill -9 $pids 2>/dev/null || true
  fi
done
echo "[SCRIPT] All project services stopped."
