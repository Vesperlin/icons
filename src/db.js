import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { v4 as uuid } from 'uuid';

const databaseFile = process.env.DATABASE_PATH || './data/app.db';

export async function getDb() {
  const db = await open({ filename: databaseFile, driver: sqlite3.Database });
  await db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export async function migrate() {
  const db = await getDb();
  const ensureColumn = async (table, name, definition) => {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (!columns.find((c) => c.name === name)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  };
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      developer_code_id TEXT,
      is_admin INTEGER DEFAULT 0,
      is_root INTEGER DEFAULT 0,
      vip_level TEXT DEFAULT 'none',
      vip_expiry INTEGER,
      status TEXT DEFAULT 'active',
      created_at INTEGER,
      updated_at INTEGER,
      reset_token TEXT,
      verification_code TEXT,
      verification_expires INTEGER,
      reset_expires INTEGER,
      device_fingerprint TEXT,
      UNIQUE(email, device_fingerprint),
      FOREIGN KEY(developer_code_id) REFERENCES developer_codes(id)
    );
    CREATE TABLE IF NOT EXISTS developer_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      level TEXT NOT NULL,
      generated_by TEXT,
      bound_user_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER,
      bound_at INTEGER,
      max_generations INTEGER,
      note TEXT,
      FOREIGN KEY(generated_by) REFERENCES users(id),
      FOREIGN KEY(bound_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      value INTEGER NOT NULL,
      duration_days INTEGER,
      uses_remaining INTEGER,
      created_by TEXT,
      created_at INTEGER,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS vip_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      amount INTEGER NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER,
      coupon_id TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(coupon_id) REFERENCES coupons(id)
    );
    CREATE TABLE IF NOT EXISTS icon_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_by TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS icons (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      image TEXT,
      position INTEGER DEFAULT 0,
      created_by TEXT,
      FOREIGN KEY(group_id) REFERENCES icon_groups(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_blocks (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT,
      position INTEGER DEFAULT 0,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      original_name TEXT,
      stored_name TEXT,
      mime TEXT,
      size INTEGER,
      visibility TEXT DEFAULT 'private',
      tags TEXT,
      created_at INTEGER,
      FOREIGN KEY(owner_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      title TEXT,
      content TEXT,
      tags TEXT,
      visibility TEXT DEFAULT 'private',
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY(owner_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      author_id TEXT,
      title TEXT,
      content TEXT,
      status TEXT DEFAULT 'draft',
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY(author_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      name TEXT,
      category TEXT,
      url TEXT,
      description TEXT,
      created_by TEXT,
      created_at INTEGER,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT,
      source_url TEXT,
      excerpt TEXT,
      content TEXT,
      tags TEXT,
      visibility TEXT DEFAULT 'private',
      created_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT,
      target TEXT,
      detail TEXT,
      created_at INTEGER,
      FOREIGN KEY(actor_id) REFERENCES users(id)
    );
  `);

  const rootCode = 'Vesper';
  const now = Date.now();
  await ensureColumn('users', 'is_root', 'INTEGER DEFAULT 0');
  await ensureColumn('users', 'device_fingerprint', 'TEXT');
  await ensureColumn('users', 'developer_code_id', 'TEXT');
  const existingRoot = await db.get('SELECT id FROM developer_codes WHERE code = ?', rootCode);
  if (!existingRoot) {
    await db.run(
      'INSERT INTO developer_codes (id, code, level, generated_by, is_active, created_at, max_generations, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uuid(), rootCode, 'root', null, 1, now, null, 'Genesis code with unlimited control'
    );
  }
}

if (process.argv.includes('--migrate')) {
  migrate().then(() => {
    console.log('Database migrated');
    process.exit(0);
  });
}
