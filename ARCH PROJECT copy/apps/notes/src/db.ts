import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure the data directory exists inside apps/notes/data
const dataDir = path.resolve(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Resolve database path reliably relative to apps/notes
const rawDbPath = process.env.DB_PATH || './data/notes.db';
const dbPath = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(__dirname, '..', rawDbPath);

export const db: DatabaseType = new Database(dbPath);

// Enable WAL mode and busy timeout for safe concurrent access
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create isolated notes table owned exclusively by Notes App
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
`);

export interface NoteRow {
  id: number;
  user_id: number;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export function getNotesByUser(userId: number): NoteRow[] {
  const stmt = db.prepare(
    'SELECT id, user_id, title, content, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC, id DESC'
  );
  return stmt.all(userId) as NoteRow[];
}

export function getNoteByIdForUser(id: number, userId: number): NoteRow | undefined {
  const stmt = db.prepare(
    'SELECT id, user_id, title, content, created_at, updated_at FROM notes WHERE id = ? AND user_id = ?'
  );
  return stmt.get(id, userId) as NoteRow | undefined;
}

export function createNote(userId: number, title: string, content: string): NoteRow {
  const stmt = db.prepare(
    'INSERT INTO notes (user_id, title, content) VALUES (?, ?, ?)'
  );
  const info = stmt.run(userId, title, content);
  return getNoteByIdForUser(Number(info.lastInsertRowid), userId)!;
}

export function updateNoteForUser(
  id: number,
  userId: number,
  title: string,
  content: string
): NoteRow | undefined {
  const stmt = db.prepare(
    'UPDATE notes SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  );
  const info = stmt.run(title, content, id, userId);
  if (info.changes === 0) return undefined;
  return getNoteByIdForUser(id, userId);
}

export function deleteNoteForUser(id: number, userId: number): boolean {
  const stmt = db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?');
  const info = stmt.run(id, userId);
  return info.changes > 0;
}
