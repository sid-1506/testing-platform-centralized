import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  seedInitialProducts,
} from './db';
import { logProductEvent } from './logger';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 6001;
const INSTANCE_ID = process.env.INSTANCE_ID || 'product-service-1';

// Seed initial database catalog
seedInitialProducts();

// Built-in JSON body parser
app.use(express.json());

// Helper to compute duration in ms
function getDuration(req: Request): number {
  if (!(req as any).startTime) return 0;
  const diff = process.hrtime((req as any).startTime);
  return Math.round((diff[0] * 1000 + diff[1] / 1e6) * 100) / 100;
}

// Request Tracing & Instance Header Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  // Read or generate request ID
  const requestId = (req.headers['x-request-id'] as string) || `req_${Date.now()}`;
  
  // Attach correlation headers to response
  res.setHeader('X-Instance-Id', INSTANCE_ID);
  res.setHeader('x-request-id', requestId);

  // Store in request context for route logging
  (req as any).requestId = requestId;
  (req as any).startTime = process.hrtime();

  // Log incoming request
  console.log(`[${INSTANCE_ID.toUpperCase()}] [${requestId}] REQUEST RECEIVED: ${req.method} ${req.url}`);

  if (req.path !== '/health') {
    logProductEvent({
      event: 'REQUEST_RECEIVED',
      instance_id: INSTANCE_ID,
      request_id: requestId,
      method: req.method,
      route: req.url,
    });
  }

  // Log when response finishes
  res.on('finish', () => {
    console.log(`[${INSTANCE_ID.toUpperCase()}] [${requestId}] RESPONSE ${res.statusCode}`);
    if (req.path !== '/health') {
      logProductEvent({
        event: 'RESPONSE_SENT',
        instance_id: INSTANCE_ID,
        request_id: requestId,
        status_code: res.statusCode,
        method: req.method,
        route: req.url,
        duration_ms: getDuration(req),
      });
    }
  });

  next();
});

// --- 1. Health Check Endpoint ---
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'product-service',
    instanceId: INSTANCE_ID,
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// --- 2. List All Products ---
app.get('/products', (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  console.log(`[${INSTANCE_ID.toUpperCase()}] [${reqId}] DATABASE QUERY: getAllProducts`);
  
  const products = getAllProducts();
  logProductEvent({
    event: 'DATABASE_OPERATION',
    instance_id: INSTANCE_ID,
    request_id: reqId,
    operation: 'getAllProducts',
    status_code: 200,
  });

  res.json({
    success: true,
    instanceId: INSTANCE_ID,
    count: products.length,
    data: products,
  });
});

// --- 3. Get Single Product by ID ---
app.get('/products/:id', (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  const id = parseInt(String(req.params.id), 10);

  if (isNaN(id)) {
    logProductEvent({
      event: 'DATABASE_ERROR',
      instance_id: INSTANCE_ID,
      request_id: reqId,
      operation: 'getProductById',
      error: 'Invalid product ID',
      status_code: 400,
    });
    res.status(400).json({ error: 'Invalid product ID' });
    return;
  }

  console.log(`[${INSTANCE_ID.toUpperCase()}] [${reqId}] DATABASE QUERY: getProductById(${id})`);
  const product = getProductById(id);

  logProductEvent({
    event: 'DATABASE_OPERATION',
    instance_id: INSTANCE_ID,
    request_id: reqId,
    operation: `getProductById(${id})`,
    status_code: product ? 200 : 404,
  });

  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }

  res.json({
    success: true,
    instanceId: INSTANCE_ID,
    data: product,
  });
});

// --- 4. Create New Product ---
app.post('/products', (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  const { name, price, stock } = req.body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    res.status(400).json({ error: 'Product name is required' });
    return;
  }

  const numPrice = parseFloat(price);
  const numStock = parseInt(stock, 10);

  if (isNaN(numPrice) || numPrice < 0) {
    res.status(400).json({ error: 'Valid positive price is required' });
    return;
  }

  if (isNaN(numStock) || numStock < 0) {
    res.status(400).json({ error: 'Valid positive stock integer is required' });
    return;
  }

  console.log(`[${INSTANCE_ID.toUpperCase()}] [${reqId}] DATABASE QUERY: createProduct("${name}", ${numPrice}, ${numStock})`);
  const newId = createProduct(name.trim(), numPrice, numStock);
  const created = getProductById(newId);

  logProductEvent({
    event: 'DATABASE_OPERATION',
    instance_id: INSTANCE_ID,
    request_id: reqId,
    operation: 'createProduct',
    status_code: 201,
  });

  res.status(201).json({
    success: true,
    message: 'Product created successfully',
    instanceId: INSTANCE_ID,
    data: created,
  });
});

// --- 5. Update Existing Product ---
app.put('/products/:id', (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  const id = parseInt(String(req.params.id), 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid product ID' });
    return;
  }

  const existing = getProductById(id);
  if (!existing) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }

  const name = typeof req.body.name === 'string' && req.body.name.trim() !== ''
    ? req.body.name.trim()
    : existing.name;

  const price = req.body.price !== undefined ? parseFloat(req.body.price) : existing.price;
  const stock = req.body.stock !== undefined ? parseInt(req.body.stock, 10) : existing.stock;

  if (isNaN(price) || price < 0 || isNaN(stock) || stock < 0) {
    res.status(400).json({ error: 'Price and stock must be valid non-negative numbers' });
    return;
  }

  console.log(`[${INSTANCE_ID.toUpperCase()}] [${reqId}] DATABASE QUERY: updateProduct(${id})`);
  updateProduct(id, name, price, stock);
  const updated = getProductById(id);

  logProductEvent({
    event: 'DATABASE_OPERATION',
    instance_id: INSTANCE_ID,
    request_id: reqId,
    operation: 'updateProduct',
    status_code: 200,
  });

  res.json({
    success: true,
    message: 'Product updated successfully',
    instanceId: INSTANCE_ID,
    data: updated,
  });
});

// --- 6. Delete Product ---
app.delete('/products/:id', (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  const id = parseInt(String(req.params.id), 10);

  if (isNaN(id)) {
    logProductEvent({
      event: 'DATABASE_ERROR',
      instance_id: INSTANCE_ID,
      request_id: reqId,
      operation: 'deleteProduct',
      error: 'Invalid product ID',
      status_code: 400,
    });
    res.status(400).json({ error: 'Invalid product ID' });
    return;
  }

  console.log(`[${INSTANCE_ID.toUpperCase()}] [${reqId}] DATABASE QUERY: deleteProduct(${id})`);
  const deleted = deleteProduct(id);

  logProductEvent({
    event: 'DATABASE_OPERATION',
    instance_id: INSTANCE_ID,
    request_id: reqId,
    operation: 'deleteProduct',
    status_code: deleted ? 200 : 404,
  });

  if (!deleted) {
    res.status(404).json({ error: 'Product not found or already deleted' });
    return;
  }

  res.json({
    success: true,
    message: 'Product deleted successfully',
    instanceId: INSTANCE_ID,
  });
});

// Export server instance
export const server = app.listen(PORT, () => {
  console.log(`[PRODUCT SERVICE] Instance '${INSTANCE_ID}' running on http://localhost:${PORT}`);
  console.log(`[PRODUCT SERVICE] Health check: http://localhost:${PORT}/health`);
  console.log(`[PRODUCT SERVICE] Products API: http://localhost:${PORT}/products`);
});

export default app;
