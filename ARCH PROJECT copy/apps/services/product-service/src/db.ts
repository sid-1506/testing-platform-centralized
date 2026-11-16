import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure the local data directory exists inside apps/services/product-service/data
const dataDir = path.resolve(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Robust database path: always resolves inside product-service/data/products.db
const rawDbPath = process.env.DB_PATH || './data/products.db';
const dbPath = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(__dirname, '..', rawDbPath);

// Initialize SQLite database connection
export const db: DatabaseType = new Database(dbPath);

// Enable Write-Ahead Logging (WAL) for concurrent reads/writes
db.pragma('journal_mode = WAL');

// Wait up to 5000ms if another instance holds a write lock
db.pragma('busy_timeout = 5000');

// Create the products table
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
  created_at: string;
}

// 1. Get all products
export function getAllProducts(): Product[] {
  const stmt = db.prepare('SELECT * FROM products ORDER BY id ASC');
  return stmt.all() as Product[];
}

// 2. Get single product by id
export function getProductById(id: number): Product | undefined {
  const stmt = db.prepare('SELECT * FROM products WHERE id = ?');
  return stmt.get(id) as Product | undefined;
}

// 3. Create a new product
export function createProduct(name: string, price: number, stock: number): number {
  const stmt = db.prepare(
    'INSERT INTO products (name, price, stock) VALUES (?, ?, ?)'
  );
  const result = stmt.run(name, price, stock);
  return Number(result.lastInsertRowid);
}

// 4. Update an existing product
export function updateProduct(
  id: number,
  name: string,
  price: number,
  stock: number
): boolean {
  const stmt = db.prepare(
    'UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?'
  );
  const result = stmt.run(name, price, stock, id);
  return result.changes > 0;
}

// 5. Delete a product
export function deleteProduct(id: number): boolean {
  const stmt = db.prepare('DELETE FROM products WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// Helper: Seed sample products if table is empty
export function seedInitialProducts(): void {
  const countStmt = db.prepare('SELECT count(*) as count FROM products');
  const row = countStmt.get() as { count: number };

  if (row.count === 0) {
    const insertStmt = db.prepare(
      'INSERT INTO products (name, price, stock) VALUES (?, ?, ?)'
    );
    insertStmt.run('MacBook Pro M3', 1999.99, 15);
    insertStmt.run('Mechanical Keyboard', 129.50, 45);
    insertStmt.run('UltraWide 4K Monitor', 649.00, 20);
    console.log('[PRODUCT SERVICE] Seeded initial product catalog.');
  }
}
