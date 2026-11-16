import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Locate the apps/web directory reliably across Next.js bundlers and direct execution
const getWebDir = () => {
  const cwd = process.cwd();
  if (cwd.endsWith('web')) {
    return cwd;
  }
  return path.resolve(cwd, 'apps/web');
};

const webDir = getWebDir();
const dataDir = path.resolve(webDir, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Robust database path: always resolves inside apps/web/data/next_app.db
const rawDbPath = process.env.DB_PATH || './data/next_app.db';
const dbPath = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(webDir, rawDbPath);

// Initialize SQLite database connection
export const db: DatabaseType = new Database(dbPath);

// Enable Write-Ahead Logging (WAL)
db.pragma('journal_mode = WAL');

// Wait up to 5000ms if another operation holds a lock
db.pragma('busy_timeout = 5000');

// Create the isolated preferences and cart_items tables for Next.js app
db.exec(`
  CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    theme TEXT DEFAULT 'light',
    notes TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cart_user_id ON cart_items(user_id);
`);

export interface UserPreferences {
  id: number;
  user_id: number;
  theme: string;
  notes: string;
  updated_at: string;
}

// Helper: Get preferences for a given user
export function getUserPreferences(userId: number): UserPreferences | undefined {
  const stmt = db.prepare('SELECT * FROM preferences WHERE user_id = ?');
  return stmt.get(userId) as UserPreferences | undefined;
}

// Helper: Insert or update preferences for a given user
export function saveUserPreferences(userId: number, theme: string, notes: string): void {
  const stmt = db.prepare(`
    INSERT INTO preferences (user_id, theme, notes, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      theme = excluded.theme,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP;
  `);
  stmt.run(userId, theme, notes);
}

export interface CartItemRow {
  id: number;
  user_id: number;
  product_id: number;
  product_name: string;
  unit_price: number;
  quantity: number;
  created_at: string;
  updated_at: string;
}

export function getCartItems(userId: number): CartItemRow[] {
  const stmt = db.prepare(
    'SELECT id, user_id, product_id, product_name, unit_price, quantity, created_at, updated_at FROM cart_items WHERE user_id = ? ORDER BY id ASC'
  );
  return stmt.all(userId) as CartItemRow[];
}

const addOrIncrementCartItemTx = db.transaction(
  (
    userId: number,
    productId: number,
    productName: string,
    unitPrice: number,
    quantity: number
  ): CartItemRow => {
    const upsert = db.prepare(`
      INSERT INTO cart_items (user_id, product_id, product_name, unit_price, quantity, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, product_id) DO UPDATE SET
        product_name = excluded.product_name,
        unit_price = excluded.unit_price,
        quantity = cart_items.quantity + excluded.quantity,
        updated_at = CURRENT_TIMESTAMP;
    `);
    upsert.run(userId, productId, productName, unitPrice, quantity);

    const select = db.prepare(
      'SELECT id, user_id, product_id, product_name, unit_price, quantity, created_at, updated_at FROM cart_items WHERE user_id = ? AND product_id = ?'
    );
    return select.get(userId, productId) as CartItemRow;
  }
);

export function addOrIncrementCartItem(
  userId: number,
  productId: number,
  productName: string,
  unitPrice: number,
  quantity: number
): CartItemRow {
  return addOrIncrementCartItemTx(userId, productId, productName, unitPrice, quantity);
}

export function updateCartItemQuantity(
  id: number,
  userId: number,
  quantity: number
): CartItemRow | undefined {
  const stmt = db.prepare(
    'UPDATE cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  );
  const info = stmt.run(quantity, id, userId);
  if (info.changes === 0) return undefined;

  const select = db.prepare(
    'SELECT id, user_id, product_id, product_name, unit_price, quantity, created_at, updated_at FROM cart_items WHERE id = ? AND user_id = ?'
  );
  return select.get(id, userId) as CartItemRow | undefined;
}

export function removeCartItem(id: number, userId: number): boolean {
  const stmt = db.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?');
  const info = stmt.run(id, userId);
  return info.changes > 0;
}

const clearUserCartTx = db.transaction((userId: number): number => {
  const stmt = db.prepare('DELETE FROM cart_items WHERE user_id = ?');
  const info = stmt.run(userId);
  return info.changes;
});

export function clearUserCart(userId: number): number {
  return clearUserCartTx(userId);
}
