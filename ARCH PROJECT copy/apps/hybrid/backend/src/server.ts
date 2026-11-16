import express, { Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import dotenv from 'dotenv';
import {
  createTask,
  deleteTaskForUser,
  getTasksByUser,
  TaskStatus,
  updateTaskForUser,
  updateTaskStatusForUser,
} from './db';
import { logHybridBackendEvent } from './logger';
import {
  AuthenticatedRequest,
  createCorsMiddleware,
  createOriginGuard,
  createRequireAuthApi,
  getDuration,
  requireJwtSecret,
} from './auth';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3004';
const JWT_SECRET = requireJwtSecret();

const corsMiddleware = createCorsMiddleware(FRONTEND_ORIGIN);
const requireAuthApi = createRequireAuthApi(JWT_SECRET);
const originGuard = createOriginGuard(FRONTEND_ORIGIN);

app.use(express.json());
app.use(cookieParser());

// Request ID Correlation & Timing Middleware
app.use((req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const incomingReqId = req.headers['x-request-id'] as string;
  const requestId =
    incomingReqId || `req_${Date.now()}_hybrid_${Math.random().toString(36).substring(2, 6)}`;
  res.setHeader('x-request-id', requestId);
  req.requestId = requestId;
  req.startTime = process.hrtime();
  next();
});

app.use(corsMiddleware);

// --- Health Check ---
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'hybrid-backend',
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// --- List Tasks for Authenticated User ---
app.get('/api/tasks', requireAuthApi, (req: AuthenticatedRequest, res: Response) => {
  try {
    const tasks = getTasksByUser(req.user!.userId);
    logHybridBackendEvent({
      event: 'TASKS_LISTED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/tasks',
      method: 'GET',
      status_code: 200,
      count: tasks.length,
      duration_ms: getDuration(req),
    });
    res.json({ success: true, tasks });
  } catch (err: any) {
    logHybridBackendEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/tasks',
      method: 'GET',
      status_code: 500,
      error: err?.message || 'Database read error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

// --- Create Task ---
app.post('/api/tasks', requireAuthApi, originGuard, (req: AuthenticatedRequest, res: Response) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description =
    typeof req.body?.description === 'string' ? req.body.description.trim() : '';

  if (!title) {
    logHybridBackendEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/tasks',
      method: 'POST',
      status_code: 400,
      reason: 'Title is required',
      duration_ms: getDuration(req),
    });
    res.status(400).json({ error: 'Task title is required' });
    return;
  }

  try {
    const task = createTask(req.user!.userId, title, description);
    logHybridBackendEvent({
      event: 'TASK_CREATED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      task_id: task.id,
      route: '/api/tasks',
      method: 'POST',
      status_code: 201,
      duration_ms: getDuration(req),
    });
    res.status(201).json({ success: true, task });
  } catch (err: any) {
    logHybridBackendEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/tasks',
      method: 'POST',
      status_code: 500,
      error: err?.message || 'Database insert error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// --- Update Task ---
app.put('/api/tasks/:id', requireAuthApi, originGuard, (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description =
    typeof req.body?.description === 'string' ? req.body.description.trim() : '';

  if (isNaN(id) || id <= 0 || !title) {
    logHybridBackendEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: req.originalUrl,
      method: 'PUT',
      status_code: 400,
      reason: 'Invalid task ID or missing title',
      duration_ms: getDuration(req),
    });
    res.status(400).json({ error: 'Valid task ID and title are required' });
    return;
  }

  const updated = updateTaskForUser(id, req.user!.userId, title, description);
  if (!updated) {
    logHybridBackendEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      task_id: id,
      route: req.originalUrl,
      method: 'PUT',
      status_code: 404,
      reason: 'Task not found or not owned by user',
      duration_ms: getDuration(req),
    });
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  logHybridBackendEvent({
    event: 'TASK_UPDATED',
    request_id: req.requestId,
    user_id: req.user!.userId,
    task_id: id,
    route: req.originalUrl,
    method: 'PUT',
    status_code: 200,
    duration_ms: getDuration(req),
  });
  res.json({ success: true, task: updated });
});

// --- Update Task Status (Complete / Reopen) ---
app.patch(
  '/api/tasks/:id/status',
  requireAuthApi,
  originGuard,
  (req: AuthenticatedRequest, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const status = req.body?.status as TaskStatus;

    if (isNaN(id) || id <= 0 || (status !== 'pending' && status !== 'completed')) {
      logHybridBackendEvent({
        event: 'REQUEST_FAILED',
        request_id: req.requestId,
        user_id: req.user!.userId,
        route: req.originalUrl,
        method: 'PATCH',
        status_code: 400,
        reason: 'Invalid task ID or status',
        duration_ms: getDuration(req),
      });
      res.status(400).json({ error: "Status must be 'pending' or 'completed'" });
      return;
    }

    const updated = updateTaskStatusForUser(id, req.user!.userId, status);
    if (!updated) {
      logHybridBackendEvent({
        event: 'REQUEST_FAILED',
        request_id: req.requestId,
        user_id: req.user!.userId,
        task_id: id,
        route: req.originalUrl,
        method: 'PATCH',
        status_code: 404,
        reason: 'Task not found or not owned by user',
        duration_ms: getDuration(req),
      });
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    logHybridBackendEvent({
      event: status === 'completed' ? 'TASK_COMPLETED' : 'TASK_UPDATED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      task_id: id,
      status,
      route: req.originalUrl,
      method: 'PATCH',
      status_code: 200,
      duration_ms: getDuration(req),
    });
    res.json({ success: true, task: updated });
  }
);

// --- Delete Task ---
app.delete('/api/tasks/:id', requireAuthApi, originGuard, (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid task ID' });
    return;
  }

  const deleted = deleteTaskForUser(id, req.user!.userId);
  if (!deleted) {
    logHybridBackendEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      task_id: id,
      route: req.originalUrl,
      method: 'DELETE',
      status_code: 404,
      reason: 'Task not found or not owned by user',
      duration_ms: getDuration(req),
    });
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  logHybridBackendEvent({
    event: 'TASK_DELETED',
    request_id: req.requestId,
    user_id: req.user!.userId,
    task_id: id,
    route: req.originalUrl,
    method: 'DELETE',
    status_code: 200,
    duration_ms: getDuration(req),
  });
  res.json({ success: true, message: 'Task deleted' });
});

export const server = app.listen(PORT, () => {
  console.log(`[HYBRID BACKEND] Running on http://localhost:${PORT}`);
  console.log(`[HYBRID BACKEND] CORS allowed origin: ${FRONTEND_ORIGIN}`);
});

export default app;
