// Test helper: load the migration SQL into a node:sqlite database and expose
// a tiny D1-shaped wrapper so DB-touching code can be unit-tested without
// spinning up wrangler/miniflare.
//
// The wrapper implements only the methods we actually call from src/db/*.
// Add more shims as needed; do not extend it speculatively.

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Vite 5.4's transform pipeline doesn't recognize node:sqlite (it ships in
// Node 22+). Load it via createRequire so Node resolves the built-in itself.
type DatabaseSyncCtor = new (path: string) => DatabaseSyncInstance;
interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): {
    get: (...args: never[]) => unknown;
    all: (...args: never[]) => unknown[];
    run: (...args: never[]) => { changes?: number; lastInsertRowid?: number | bigint };
  };
}
const req = createRequire(import.meta.url);
const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url).pathname;

export interface D1Like {
  prepare(sql: string): D1PreparedLike;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  batch<T = unknown>(statements: D1PreparedLike[]): Promise<D1ResultLike<T>[]>;
  _raw: DatabaseSyncInstance;
}

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
  run(): Promise<D1ResultLike<never>>;
}

export interface D1ResultLike<T> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id: number | bigint; duration: number };
}

class PreparedShim implements D1PreparedLike {
  private boundValues: unknown[] = [];
  constructor(
    private db: DatabaseSyncInstance,
    private sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedLike {
    const next = new PreparedShim(this.db, this.sql);
    next.boundValues = values.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v));
    return next;
  }

  async first<T = unknown>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.boundValues as never[]));
    return (row as T) ?? null;
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.boundValues as never[]));
    return {
      results: rows as T[],
      success: true,
      meta: { changes: 0, last_row_id: 0, duration: 0 },
    };
  }

  async run(): Promise<D1ResultLike<never>> {
    const stmt = this.db.prepare(this.sql);
    const result = stmt.run(...(this.boundValues as never[]));
    return {
      results: [] as never[],
      success: true,
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: result.lastInsertRowid ?? 0,
        duration: 0,
      },
    };
  }
}

export async function freshTestDb(): Promise<D1Like> {
  const db: DatabaseSyncInstance = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    db.exec(sql);
  }
  return {
    _raw: db,
    prepare(sql: string) {
      return new PreparedShim(db, sql);
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    async batch(statements: D1PreparedLike[]) {
      const results: D1ResultLike<unknown>[] = [];
      db.exec("BEGIN");
      try {
        for (const s of statements) {
          results.push(await s.run());
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return results as D1ResultLike<never>[];
    },
  };
}

