import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { productInstances, getNextHealthyInstance, startHealthChecker } from './loadbalancer';
import { logGatewayEvent } from './logger';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5001;

// Parse JSON request bodies
app.use(express.json());

// Helper to compute duration in ms
function getDuration(req: Request): number {
  if (!(req as any).startTime) return 0;
  const diff = process.hrtime((req as any).startTime);
  return Math.round((diff[0] * 1000 + diff[1] / 1e6) * 100) / 100;
}

// --- Correlation ID & Request Tracing Middleware ---
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || `req_${Date.now()}_gw_${Math.random().toString(36).substring(2, 6)}`;
  
  res.setHeader('x-request-id', requestId);
  (req as any).requestId = requestId;
  (req as any).startTime = process.hrtime();

  console.log(`[GATEWAY] [${requestId}] INCOMING ${req.method} ${req.originalUrl}`);

  if (req.path !== '/health') {
    logGatewayEvent({
      event: 'INCOMING_REQUEST',
      request_id: requestId,
      method: req.method,
      route: req.originalUrl,
    });
  }

  next();
});

// --- 1. Gateway Health & Status Endpoint ---
app.get('/health', (_req: Request, res: Response) => {
  const healthyCount = productInstances.filter(i => i.healthy).length;
  res.json({
    status: 'ok',
    service: 'api-gateway',
    port: PORT,
    healthyPoolSize: healthyCount,
    totalInstances: productInstances.length,
    instances: productInstances,
    timestamp: new Date().toISOString(),
  });
});

// --- Optional Admin Simulation Endpoint (For Fault Demonstration) ---
app.post('/admin/instance/:id/status', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { healthy } = req.body;
  const target = productInstances.find(i => i.id === id);

  if (!target) {
    res.status(404).json({ error: `Instance ${id} not found in registry` });
    return;
  }

  target.healthy = Boolean(healthy);
  target.disabled = !target.healthy;
  if (!target.healthy) {
    target.failureCount = 3;
    console.log(`[FAULT INJECTION] Instance ${target.id} manually marked UNHEALTHY.`);
  } else {
    target.failureCount = 0;
    console.log(`[FAULT RECOVERY] Instance ${target.id} manually marked HEALTHY.`);
  }

  res.json({
    success: true,
    message: `Instance ${target.id} health status set to ${target.healthy}`,
    instance: target,
  });
});

// --- 2. Reverse Proxy Route for Product Service (/api/v1/products) ---
app.use('/api/v1/products', async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;

  // Step 1: Select next healthy instance via Round-Robin load balancer
  const instance = getNextHealthyInstance();

  // If no healthy instances are currently available -> return 503 Service Unavailable
  if (!instance) {
    console.log(`[GATEWAY] [${requestId}] 503 SERVICE UNAVAILABLE: No healthy instances in pool.`);
    logGatewayEvent({
      event: 'GATEWAY_ERROR',
      request_id: requestId,
      status_code: 503,
      error: 'No healthy instances in pool',
      method: req.method,
      route: req.originalUrl,
      duration_ms: getDuration(req),
    });
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'All Product Service instances are currently offline or unhealthy.',
      requestId,
    });
    return;
  }

  // Step 2: Log routing decision
  console.log(`[GATEWAY] [${requestId}] ROUTING to ${instance.id} (${instance.url})`);
  logGatewayEvent({
    event: 'REQUEST_ROUTED',
    request_id: requestId,
    instance_id: instance.id,
    method: req.method,
    route: req.originalUrl,
  });

  // Step 3: Compute target URL (rewrite /api/v1/products... -> /products...)
  const backendPath = req.originalUrl.replace('/api/v1', '');
  const targetUrl = `${instance.url}${backendPath}`;

  try {
    // Step 4: Forward request to selected instance
    const headers: Record<string, string> = {
      'x-request-id': requestId,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const backendRes = await fetch(targetUrl, fetchOptions);
    const data = await backendRes.text();

    console.log(`[GATEWAY] [${requestId}] RESPONSE FORWARDED: ${backendRes.status} from ${instance.id}`);
    logGatewayEvent({
      event: 'RESPONSE_FORWARDED',
      request_id: requestId,
      instance_id: instance.id,
      status_code: backendRes.status,
      method: req.method,
      route: req.originalUrl,
      duration_ms: getDuration(req),
    });

    res.setHeader('X-Handled-By', instance.id);
    res.status(backendRes.status);
    
    try {
      res.json(JSON.parse(data));
    } catch {
      res.send(data);
    }
  } catch (err: any) {
    console.error(`[GATEWAY] [${requestId}] Forwarding error to ${instance.id}:`, err);
    logGatewayEvent({
      event: 'GATEWAY_ERROR',
      request_id: requestId,
      instance_id: instance.id,
      status_code: 502,
      error: err?.message || 'Bad Gateway',
      method: req.method,
      route: req.originalUrl,
      duration_ms: getDuration(req),
    });
    res.status(502).json({
      error: 'Bad Gateway',
      message: `Failed to communicate with ${instance.id} at ${instance.url}`,
      requestId,
    });
  }
});

// Start background health checking
startHealthChecker();

// Start Gateway Server
export const server = app.listen(PORT, () => {
  console.log(`[API GATEWAY] Running on http://localhost:${PORT}`);
  console.log(`[API GATEWAY] Health check: http://localhost:${PORT}/health`);
  console.log(`[API GATEWAY] Routing: /api/v1/products -> Load balanced across ${productInstances.map(i => i.url).join(', ')}`);
});

export default app;
