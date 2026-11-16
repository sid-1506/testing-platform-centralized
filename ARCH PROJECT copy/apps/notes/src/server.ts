import express, { Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import dotenv from 'dotenv';
import {
  createNote,
  deleteNoteForUser,
  getNotesByUser,
  updateNoteForUser,
} from './db';
import { logNotesEvent } from './logger';
import {
  AuthenticatedRequest,
  createRequireAuthApi,
  createRequireAuthPage,
  createSameOriginGuard,
  getDuration,
  requireJwtSecret,
} from './auth';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
const AUTH_APP_URL = process.env.AUTH_APP_URL || 'http://localhost:3001';
const APP_ORIGIN = `http://localhost:${PORT}`;
const JWT_SECRET = requireJwtSecret();

const requireAuthPage = createRequireAuthPage(JWT_SECRET, AUTH_APP_URL, APP_ORIGIN);
const requireAuthApi = createRequireAuthApi(JWT_SECRET);
const sameOriginGuard = createSameOriginGuard(APP_ORIGIN);

app.use(express.json());
app.use(cookieParser());

// Request ID Correlation & Timing Middleware
app.use((req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const incomingReqId = req.headers['x-request-id'] as string;
  const requestId =
    incomingReqId || `req_${Date.now()}_notes_${Math.random().toString(36).substring(2, 6)}`;
  res.setHeader('x-request-id', requestId);
  req.requestId = requestId;
  req.startTime = process.hrtime();
  next();
});

// --- Health Check ---
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'notes-app',
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// --- Protected Notes Dashboard UI ---
const publicIndexPath = path.resolve(__dirname, '../public/index.html');
app.get('/', requireAuthPage, (req: AuthenticatedRequest, res: Response) => {
  logNotesEvent({
    event: 'APP_ACCESS',
    request_id: req.requestId,
    user_id: req.user!.userId,
    route: '/',
    method: 'GET',
    status_code: 200,
    duration_ms: getDuration(req),
  });
  res.sendFile(publicIndexPath);
});

// --- Current Authenticated User Info ---
app.get('/api/me', requireAuthApi, (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    user: req.user,
    authUrl: AUTH_APP_URL,
  });
});

// --- List All Notes for Authenticated User ---
app.get('/api/notes', requireAuthApi, (req: AuthenticatedRequest, res: Response) => {
  try {
    const notes = getNotesByUser(req.user!.userId);
    logNotesEvent({
      event: 'NOTES_LIST',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/notes',
      method: 'GET',
      status_code: 200,
      count: notes.length,
      duration_ms: getDuration(req),
    });
    res.json({ success: true, notes });
  } catch (err: any) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/notes',
      method: 'GET',
      status_code: 500,
      error: err?.message || 'Database read error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

// --- Create Note ---
app.post('/api/notes', requireAuthApi, sameOriginGuard, (req: AuthenticatedRequest, res: Response) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

  if (!title) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/notes',
      method: 'POST',
      status_code: 400,
      reason: 'Title is required',
      duration_ms: getDuration(req),
    });
    res.status(400).json({ error: 'Note title is required' });
    return;
  }

  try {
    const note = createNote(req.user!.userId, title, content);
    logNotesEvent({
      event: 'NOTE_CREATED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      note_id: note.id,
      route: '/api/notes',
      method: 'POST',
      status_code: 201,
      duration_ms: getDuration(req),
    });
    res.status(201).json({ success: true, note });
  } catch (err: any) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: '/api/notes',
      method: 'POST',
      status_code: 500,
      error: err?.message || 'Database insert error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// --- Update Existing Note (Ownership Enforced) ---
app.put('/api/notes/:id', requireAuthApi, sameOriginGuard, (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

  if (isNaN(id) || id <= 0) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: req.originalUrl,
      method: 'PUT',
      status_code: 400,
      reason: 'Invalid note ID',
      duration_ms: getDuration(req),
    });
    res.status(400).json({ error: 'Invalid note ID' });
    return;
  }

  if (!title) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: req.originalUrl,
      method: 'PUT',
      status_code: 400,
      reason: 'Title is required',
      duration_ms: getDuration(req),
    });
    res.status(400).json({ error: 'Note title is required' });
    return;
  }

  try {
    const updated = updateNoteForUser(id, req.user!.userId, title, content);
    if (!updated) {
      logNotesEvent({
        event: 'REQUEST_FAILED',
        request_id: req.requestId,
        user_id: req.user!.userId,
        note_id: id,
        route: req.originalUrl,
        method: 'PUT',
        status_code: 404,
        reason: 'Note not found or not owned by user',
        duration_ms: getDuration(req),
      });
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    logNotesEvent({
      event: 'NOTE_UPDATED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      note_id: id,
      route: req.originalUrl,
      method: 'PUT',
      status_code: 200,
      duration_ms: getDuration(req),
    });
    res.json({ success: true, note: updated });
  } catch (err: any) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      note_id: id,
      route: req.originalUrl,
      method: 'PUT',
      status_code: 500,
      error: err?.message || 'Database update error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// --- Delete Note (Ownership Enforced) ---
app.delete('/api/notes/:id', requireAuthApi, sameOriginGuard, (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id) || id <= 0) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      route: req.originalUrl,
      method: 'DELETE',
      status_code: 400,
      reason: 'Invalid note ID',
      duration_ms: getDuration(req),
    });
    res.status(400).json({ error: 'Invalid note ID' });
    return;
  }

  try {
    const deleted = deleteNoteForUser(id, req.user!.userId);
    if (!deleted) {
      logNotesEvent({
        event: 'REQUEST_FAILED',
        request_id: req.requestId,
        user_id: req.user!.userId,
        note_id: id,
        route: req.originalUrl,
        method: 'DELETE',
        status_code: 404,
        reason: 'Note not found or not owned by user',
        duration_ms: getDuration(req),
      });
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    logNotesEvent({
      event: 'NOTE_DELETED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      note_id: id,
      route: req.originalUrl,
      method: 'DELETE',
      status_code: 200,
      duration_ms: getDuration(req),
    });
    res.json({ success: true, message: 'Note deleted' });
  } catch (err: any) {
    logNotesEvent({
      event: 'REQUEST_FAILED',
      request_id: req.requestId,
      user_id: req.user!.userId,
      note_id: id,
      route: req.originalUrl,
      method: 'DELETE',
      status_code: 500,
      error: err?.message || 'Database delete error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

export const server = app.listen(PORT, () => {
  console.log(`[NOTES APP] Running independently on http://localhost:${PORT}`);
  console.log(`[NOTES APP] Protected by Central Auth at ${AUTH_APP_URL}`);
});

export default app;
