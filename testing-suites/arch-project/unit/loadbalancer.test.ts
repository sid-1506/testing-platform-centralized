import { describe, it, expect, beforeEach } from 'vitest';

import {
  productInstances,
  getNextHealthyInstance,
  resetRoundRobinIndex,
} from '@target/apps/gateway/src/loadbalancer';

describe('Gateway Round-Robin Load Balancer (apps/gateway/src/loadbalancer.ts)', () => {
  beforeEach(() => {
    resetRoundRobinIndex();
    for (const inst of productInstances) {
      inst.healthy = true;
      inst.failureCount = 0;
      inst.disabled = false;
    }
  });

  it('distributes requests across all 3 healthy product instances in round-robin order', () => {
    const first = getNextHealthyInstance();
    const second = getNextHealthyInstance();
    const third = getNextHealthyInstance();
    const fourth = getNextHealthyInstance();

    expect(first?.id).toBe('product-1');
    expect(second?.id).toBe('product-2');
    expect(third?.id).toBe('product-3');
    expect(fourth?.id).toBe('product-1');
  });

  it('skips unhealthy instances when routing requests', () => {
    productInstances[1].healthy = false; // product-2 down

    const first = getNextHealthyInstance();
    const second = getNextHealthyInstance();
    const third = getNextHealthyInstance();

    expect(first?.id).toBe('product-1');
    expect(second?.id).toBe('product-3');
    expect(third?.id).toBe('product-1');
  });

  it('returns null when all instances are unhealthy', () => {
    for (const inst of productInstances) {
      inst.healthy = false;
    }
    expect(getNextHealthyInstance()).toBeNull();
  });
});
