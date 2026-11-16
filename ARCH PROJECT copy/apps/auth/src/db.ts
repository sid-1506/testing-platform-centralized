import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure the data directory exists
const dataDir = path.resolve(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Database file path: always resolve relative to apps/auth directory regardless of process.cwd()
const rawDbPath = process.env.DB_PATH || './data/auth.db';
const dbPath = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(__dirname, '..', rawDbPath);

// Connect to SQLite database
export const db: DatabaseType = new Database(dbPath);

// Enable Write-Ahead Logging (WAL) for better concurrency
db.pragma('journal_mode = WAL');

// Wait up to 5000ms if another process is writing before throwing a busy error
db.pragma('busy_timeout = 5000');

// Create the users table if it does not already exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Simple interface for User row in SQLite
export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
}

// Helper: Find a user by their email address
export function findUserByEmail(email: string): UserRow | undefined {
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  return stmt.get(email) as UserRow | undefined;
}

// Helper: Find a user by their ID
export function findUserById(id: number): UserRow | undefined {
  const stmt = db.prepare('SELECT id, email, role, created_at FROM users WHERE id = ?');
  return stmt.get(id) as UserRow | undefined;
}

// Helper: Insert a new user
export function createUser(email: string, passwordHash: string, role = 'user'): number {
  const stmt = db.prepare(
    'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)'
  );
  const info = stmt.run(email, passwordHash, role);
  return Number(info.lastInsertRowid);
}
