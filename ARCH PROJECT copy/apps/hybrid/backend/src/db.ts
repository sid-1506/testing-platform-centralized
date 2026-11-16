import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.resolve(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const rawDbPath = process.env.DB_PATH || './data/hybrid.db';
const dbPath = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(__dirname, '..', rawDbPath);

export const db: DatabaseType = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
`);

export type TaskStatus = 'pending' | 'completed';

export interface TaskRow {
  id: number;
  user_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export function getTasksByUser(userId: number): TaskRow[] {
  const stmt = db.prepare(
    'SELECT id, user_id, title, description, status, created_at, updated_at FROM tasks WHERE user_id = ? ORDER BY status ASC, updated_at DESC, id DESC'
  );
  return stmt.all(userId) as TaskRow[];
}

export function getTaskByIdForUser(id: number, userId: number): TaskRow | undefined {
  const stmt = db.prepare(
    'SELECT id, user_id, title, description, status, created_at, updated_at FROM tasks WHERE id = ? AND user_id = ?'
  );
  return stmt.get(id, userId) as TaskRow | undefined;
}

export function createTask(userId: number, title: string, description: string): TaskRow {
  const stmt = db.prepare(
    "INSERT INTO tasks (user_id, title, description, status) VALUES (?, ?, ?, 'pending')"
  );
  const info = stmt.run(userId, title, description);
  return getTaskByIdForUser(Number(info.lastInsertRowid), userId)!;
}

export function updateTaskForUser(
  id: number,
  userId: number,
  title: string,
  description: string
): TaskRow | undefined {
  const stmt = db.prepare(
    'UPDATE tasks SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  );
  const info = stmt.run(title, description, id, userId);
  if (info.changes === 0) return undefined;
  return getTaskByIdForUser(id, userId);
}

export function updateTaskStatusForUser(
  id: number,
  userId: number,
  status: TaskStatus
): TaskRow | undefined {
  const stmt = db.prepare(
    'UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  );
  const info = stmt.run(status, id, userId);
  if (info.changes === 0) return undefined;
  return getTaskByIdForUser(id, userId);
}

export function deleteTaskForUser(id: number, userId: number): boolean {
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?');
  const info = stmt.run(id, userId);
  return info.changes > 0;
}
