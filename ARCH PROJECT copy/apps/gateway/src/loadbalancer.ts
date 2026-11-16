export interface ServiceInstance {
  id: string;
  url: string;
  healthy: boolean;
  failureCount: number;
  lastChecked?: string;
  disabled?: boolean;
}

// 3 Product Service replicas on ports 6001, 6002, 6003
export const productInstances: ServiceInstance[] = [
  { id: 'product-1', url: 'http://localhost:6001', healthy: true, failureCount: 0 },
  { id: 'product-2', url: 'http://localhost:6002', healthy: true, failureCount: 0 },
  { id: 'product-3', url: 'http://localhost:6003', healthy: true, failureCount: 0 },
];

let currentIndex = 0;

/**
 * Returns the next available healthy instance using Round-Robin load balancing.
 */
export function getNextHealthyInstance(): ServiceInstance | null {
  const healthyInstances = productInstances.filter(inst => inst.healthy);
  if (healthyInstances.length === 0) return null;

  const selected = healthyInstances[currentIndex % healthyInstances.length];
  currentIndex = (currentIndex + 1) % healthyInstances.length;
  return selected;
}

export function resetRoundRobinIndex(): void {
  currentIndex = 0;
}

/**
 * Pings backend instance /health with a 2-second timeout.
 */
async function checkInstance(instance: ServiceInstance): Promise<boolean> {
  if (instance.disabled) {
    instance.healthy = false;
    return false;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${instance.url}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Runs a single health check sweep across all instances.
 */
export async function runHealthCheckRound(): Promise<void> {
  for (const instance of productInstances) {
    const isUp = await checkInstance(instance);
    instance.lastChecked = new Date().toISOString();
    if (isUp) {
      if (!instance.healthy) {
        console.log(`[HEALTH CHECK] Instance ${instance.id} RECOVERED -> Re-admitted to pool.`);
      }
      instance.healthy = true;
      instance.failureCount = 0;
    } else {
      instance.failureCount++;
      if (instance.healthy && instance.failureCount >= 2) {
        console.log(`[HEALTH CHECK] Instance ${instance.id} UNREACHABLE -> Removed from active pool.`);
        instance.healthy = false;
      }
    }
  }
}

/**
 * Starts periodic background health-checking loop (every 5s).
 */
export function startHealthChecker(): NodeJS.Timeout {
  runHealthCheckRound().catch(() => {});
  return setInterval(() => {
    runHealthCheckRound().catch(() => {});
  }, 5000);
}
