// One async query interface over two databases:
//  * SQLite (node:sqlite) for local runs and tests: zero setup, a file in data/.
//  * Postgres (e.g. Supabase) in production, when DATABASE_URL is set.
// SQL is written once with `?` placeholders in the subset both engines share;
// the Postgres driver rewrites them to $1, $2, ...
import { openDb } from './db.js';

/**
 * @typedef {object} Store
 * @property {'sqlite'|'postgres'} kind
 * @property {(sql: string, params?: any[]) => Promise<any[]>} all
 * @property {(sql: string, params?: any[]) => Promise<any|undefined>} get
 * @property {(sql: string, params?: any[]) => Promise<{ changes: number }>} run
 * @property {<T>(fn: (s: Store) => Promise<T>) => Promise<T>} tx
 * @property {() => Promise<void>} close
 */

/** @returns {Store} */
export function sqliteStore(file) {
  const db = openDb(file);
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  // Transactions run one at a time. Queries are synchronous underneath, so a
  // transaction body that only awaits store calls cannot interleave with others.
  let chain = Promise.resolve();
  let inner;
  const store = {
    kind: 'sqlite',
    db,
    async all(sql, params = []) { return prep(sql).all(...params); },
    async get(sql, params = []) { return prep(sql).get(...params); },
    async run(sql, params = []) { const r = prep(sql).run(...params); return { changes: Number(r.changes) }; },
    tx(fn) {
      const run = chain.then(async () => {
        db.exec('BEGIN');
        try {
          const out = await fn(inner); // nested tx() calls just join this one
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      });
      chain = run.catch(() => {});
      return run;
    },
    async close() { db.close(); },
  };
  inner = { ...store, tx: (f) => f(inner) };
  return store;
}

/** Rewrite `?` placeholders to `$n` (skipping quoted strings). */
export function toPg(sql) {
  let n = 0, out = '', quote = null;
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

/** @returns {Promise<Store>} */
export async function postgresStore(databaseUrl, { max = 5 } = {}) {
  const { default: pg } = await import('pg');
  // COUNT(*) and SUM() come back as int8/numeric strings by default; the app
  // only ever stores values well inside Number's safe range.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const url = new URL(databaseUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 10_000,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  pool.on('error', () => {}); // an idle client dropped by the pooler; the next query reconnects
  const mk = (q) => ({
    kind: 'postgres',
    async all(sql, params = []) { return (await q(toPg(sql), params)).rows; },
    async get(sql, params = []) { return (await q(toPg(sql), params)).rows[0]; },
    async run(sql, params = []) { const r = await q(toPg(sql), params); return { changes: r.rowCount ?? 0 }; },
  });
  const store = {
    ...mk((text, values) => pool.query(text, values)),
    async tx(fn) {
      const client = await pool.connect();
      const inner = { ...mk((text, values) => client.query(text, values)), tx: (f) => f(inner) };
      try {
        await client.query('BEGIN');
        const out = await fn(inner);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
  return store;
}

/** `IN (?, ?, ...)` for a list of values. */
export const inList = (values) => values.map(() => '?').join(', ');
