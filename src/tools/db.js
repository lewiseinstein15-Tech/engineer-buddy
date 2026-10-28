// db.js — the database tool (v0.41.0, checklist §10): query + inspect, read-only by default.
//
// "Database tools — query, migrate, seed, inspect schemas (sqlite/pg/mysql via
// the repo's own drivers; read-only by default with an approval gate for writes)."
//
// Zero-dep by construction:
//   sqlite → node:sqlite (DatabaseSync ships with node ≥22.5) — full support:
//            schema introspection + queries, READ-ONLY opened by default so a
//            write in read mode fails in the ENGINE, not in our discretion.
//   pg     → the repo's own `pg` driver (node_modules/pg), probed before use;
//            read mode wraps the query in BEGIN READ ONLY … ROLLBACK.
//   mysql  → the repo's own `mysql2` driver, same probe; read mode uses
//            START TRANSACTION READ ONLY … ROLLBACK.
//   Absent driver → honest refusal naming the constraint, never a fake result.
//
// Secret hygiene (matches the http tool): pg/mysql connections come from an
// ENV-VAR REFERENCE ({"conn_env":"DATABASE_URL"}) — a literal connection
// string in args is refused. The child process reads the variable itself, so
// the credential never appears in args, transcripts, or the audit trail.
//
// Gates: mode:'write' is risky (approval gate). Read mode is gate-free — the
// engine-level read-only guarantee is the safety, not our politeness.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { truncate } from '../util.js';

export const MAX_ROWS = 200;
export const MAX_CELL = 200;
export const MAX_OUT = 8000;

const ENGINES = new Set(['sqlite', 'pg', 'postgres', 'postgresql', 'mysql', 'mariadb']);
const ENGINE_OF = { postgres: 'pg', postgresql: 'pg', mariadb: 'mysql' };

/** Normalize engine + validate the target. Returns {ok, engine, ...target} or {ok:false, error}. */
export function parseDbTarget(args = {}, { root = process.cwd(), env = process.env, driverProbe = null } = {}) {
  const engineRaw = String(args?.engine || 'sqlite').toLowerCase();
  const engine = ENGINE_OF[engineRaw] || engineRaw;
  if (!ENGINES.has(engine)) {
    return { ok: false, error: `engine must be one of sqlite | pg | mysql (got "${engineRaw.slice(0, 24)}")` };
  }
  if (engine === 'sqlite') {
    const p = String(args?.path || '').trim();
    if (!p) return { ok: false, error: 'sqlite needs a {"path":"data/app.db"} — relative to the project root' };
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    const inside = path.resolve(abs).startsWith(path.resolve(root) + path.sep) || path.resolve(abs) === path.resolve(root);
    if (!inside) return { ok: false, error: `sqlite path escapes the project root: ${p}` };
    if (!fs.existsSync(abs)) {
      if (String(args?.create) === 'true' && String(args?.mode) === 'write') return { ok: true, engine, path: path.resolve(abs) };
      return { ok: false, error: `sqlite file not found: ${p} (pass create:true with mode:"write" to start a fresh one)` };
    }
    return { ok: true, engine, path: path.resolve(abs) };
  }
  // pg / mysql — connection ONLY via env reference (literal = refused first,
  // so the error teaches the ref form instead of the missing-variable form).
  if (args?.conn != null || args?.url != null || args?.dsn != null) {
    return { ok: false, error: 'connection strings are never passed in args — put it in the environment and reference it: {"conn_env":"DATABASE_URL"}' };
  }
  const connEnv = String(args?.conn_env || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(connEnv)) {
    return { ok: false, error: 'pg/mysql take the connection from an env-var reference: {"conn_env":"DATABASE_URL"} — the credential never appears in args or transcripts' };
  }
  if (!env?.[connEnv]) {
    return { ok: false, error: `environment variable ${connEnv} is not set — export the connection string, then retry (the credential itself never appears in this conversation)` };
  }
  const driver = engine === 'pg' ? 'pg' : 'mysql2';
  const have = driverProbe ? !!driverProbe(driver) : fs.existsSync(path.join(root, 'node_modules', driver));
  if (!have) {
    return { ok: false, error: `this repo has no ${driver} driver installed (node_modules/${driver} missing) — Buddy never bundles drivers; install it in the repo (npm i ${driver}) and retry` };
  }
  return { ok: true, engine, driver, connEnv };
}

/** Does this SQL look like a write? Best-effort advisory — the real guarantee
 *  is the read-only connection, not this sniff. */
export function looksLikeWrite(sql) {
  return /^\s*(insert|update|delete|drop|alter|create|replace|truncate|vacuum|reindex|attach|detach|begin|commit|rollback)\b/i.test(String(sql || ''));
}

/** Render rows as a compact pipe table with capped cells. */
export function renderRows(cols, rows, { maxRows = MAX_ROWS } = {}) {
  const cell = (v) => {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'object') v = JSON.stringify(v);
    return truncate(String(v), MAX_CELL);
  };
  const head = cols.map(cell).join(' | ');
  const shown = rows.slice(0, maxRows);
  const bar = '-'.repeat(Math.min(head.length, 60));
  let out = `${bar}\n${head}\n${bar}`;
  for (const r of shown) out += `\n${cols.map((c) => cell(r?.[c])).join(' | ')}`;
  if (rows.length > maxRows) out += `\n… ${rows.length - maxRows} more rows (showing ${maxRows})`;
  return out;
}

/** sqlite schema summary: tables → columns + row counts, capped. */
export function sqliteSchema(db, { maxTables = 40 } = {}) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const lines = [];
  for (const { name } of tables.slice(0, maxTables)) {
    let cols = [];
    try { cols = db.prepare(`PRAGMA table_info(${JSON.stringify(name).slice(1, -1)})`).all(); } catch { /* weird name */ }
    const colText = cols.map((c) => `${c.name}:${c.type || 'any'}${c.pk ? ' pk' : c.notnull ? ' not-null' : ''}`).join(', ');
    let n = 0;
    try { n = db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(name).slice(1, -1)}`).get()?.n ?? 0; } catch { /* keep 0 */ }
    lines.push(`• ${name} (${n} row${n === 1 ? '' : 's'}) — ${truncate(colText || '(unreadable)', 400)}`);
  }
  if (tables.length > maxTables) lines.push(`… ${tables.length - maxTables} more tables`);
  const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name").all().map((v) => v.name).slice(0, 20);
  if (views.length) lines.push(`views: ${views.join(', ')}`);
  return lines.join('\n');
}

/** The child script that runs a query through the REPO'S OWN driver. Reads the
 *  connection from the environment; prints one JSON line {cols, rows, error?}. */
export function bridgeScript(engine, connEnv, sql, params, readOnly) {
  const q = JSON.stringify(sql);
  const ps = JSON.stringify(params || []);
  const envRef = `process.env[${JSON.stringify(connEnv)}]`;
  if (engine === 'pg') {
    return `(async () => {
  const { Client } = require('pg');
  const c = new Client({ connectionString: ${envRef} });
  await c.connect();
  try {
    ${readOnly ? "await c.query('BEGIN READ ONLY');" : ''}
    const r = await c.query(${q}, ${ps});
    ${readOnly ? "await c.query('ROLLBACK');" : ''}
    const cols = r.fields ? r.fields.map(f => f.name) : Object.keys(r.rows[0] || {});
    process.stdout.write(JSON.stringify({ cols, rows: r.rows }));
  } catch (e) {
    ${readOnly ? "try { await c.query('ROLLBACK'); } catch {}" : ''}
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
  } finally { try { await c.end(); } catch {} }
})().catch(e => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) })); });`;
  }
  return `(async () => {
  const mysql = require('mysql2/promise');
  const c = await mysql.createConnection(${envRef});
  try {
    ${readOnly ? "await c.query('START TRANSACTION READ ONLY');" : ''}
    const [rows, fields] = await c.query({ sql: ${q}, values: ${ps} });
    ${readOnly ? "await c.query('ROLLBACK');" : ''}
    const cols = fields ? fields.map(f => f.name) : Object.keys(rows[0] || {});
    process.stdout.write(JSON.stringify({ cols, rows: Array.isArray(rows) ? rows : [{ result: rows }] }));
  } catch (e) {
    ${readOnly ? "try { await c.query('ROLLBACK'); } catch {}" : ''}
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
  } finally { try { await c.end(); } catch {} }
})().catch(e => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) })); });`;
}

/** Run the bridge child. Injectable runner keeps tests offline. */
export function runBridge(script, { root, timeoutMs = 30000, runner = null } = {}) {
  const fn = runner || ((s, o) => {
    const r = spawnSync(process.execPath, ['-e', s], { cwd: o.root, timeout: o.timeoutMs, encoding: 'utf8', env: process.env });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  });
  const r = fn(script, { root, timeoutMs });
  let parsed = null;
  try { parsed = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || 'null'); } catch { /* below */ }
  if (!parsed) {
    return `ERROR: the driver bridge produced no result${r.stderr ? ` — ${truncate(String(r.stderr), 300)}` : ''}`;
  }
  if (parsed.error) return `ERROR: ${truncate(String(parsed.error), 400)}`;
  return { cols: parsed.cols || [], rows: parsed.rows || [] };
}

/** sqlite handles for the two supported modes. Injectable open for tests.
 *  node:sqlite loads dynamically so node < 22.5 gets an honest error instead
 *  of a crash at import time (the repo still supports node ≥ 20). */
async function openSqlite(target, mode, open) {
  const realOpen = open || (async (p, o) => {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(p, o);
  });
  try {
    return { db: await realOpen(target.path, { readOnly: mode !== 'write' }), error: null };
  } catch (e) {
    return { db: null, error: `cannot open sqlite (${mode === 'write' ? 'read-write' : 'read-only'}): ${truncate(String(e?.message || e), 200)}` };
  }
}

/** One db tool call → observation string (never throws). */
export async function runDbQuery(args = {}, { root = process.cwd(), env = process.env, open, bridgeRunner, driverProbe } = {}) {
  const target = parseDbTarget(args, { root, env, driverProbe });
  if (!target.ok) return `ERROR: ${target.error}`;
  const mode = String(args?.mode || 'read') === 'write' ? 'write' : 'read';
  const action = String(args?.action || 'query');
  const t0 = Date.now();

  if (target.engine === 'sqlite') {
    const { db, error } = await openSqlite(target, mode, open);
    if (error) return `ERROR: ${error}`;
    try {
      if (action === 'schema') {
        const out = `sqlite schema — ${truncate(String(target.path), 120)}${mode === 'write' ? ' [read-write]' : ' [read-only]'}\n${sqliteSchema(db)}`;
        return `${out}\n(${Date.now() - t0}ms)`;
      }
      const sql = String(args?.sql || '').trim();
      if (!sql) return 'ERROR: sql required — e.g. {"sql":"SELECT * FROM users LIMIT 10"}';
      if (mode === 'read' && looksLikeWrite(sql) && action !== 'schema') {
        return 'ERROR: this looks like a write but the tool is in read mode — pass mode:"write" (it asks the user for approval) instead of relying on the engine to refuse it';
      }
      let rows, cols;
      try {
        const stmt = db.prepare(sql);
        rows = args?.params?.length ? stmt.all(...args.params) : stmt.all();
        cols = rows.length ? Object.keys(rows[0]) : (stmt.columns?.().map((c) => c.name) || []);
      } catch (e) {
        const msg = String(e?.message || e);
        return `ERROR: ${truncate(msg, 300)}${/readonly/i.test(msg) ? '\n(the database is opened READ-ONLY in read mode — pass mode:"write" for an approved write)' : ''}`;
      }
      const ms = Date.now() - t0;
      if (!cols.length && rows.length === 0) return `sqlite ok — 0 rows (${ms}ms)${mode === 'write' ? ' [read-write]' : ''}`;
      const table = renderRows(cols, rows);
      return `sqlite ${mode === 'write' ? 'statement ok' : 'selected'} — ${rows.length} row${rows.length === 1 ? '' : 's'} (${ms}ms)${mode === 'write' ? ' [read-write]' : ' [read-only]'}\n${truncate(table, MAX_OUT)}`;
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  // pg / mysql via the repo's own driver.
  const readOnly = mode !== 'write';
  if (action === 'schema') {
    const sql = target.engine === 'pg'
      ? "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position"
      : "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name, ordinal_position";
    const r = runBridge(bridgeScript(target.engine, target.connEnv, sql, [], true), { root, bridgeRunner });
    if (typeof r === 'string') return r;
    const byTable = new Map();
    for (const row of r.rows) {
      const t = row.table_name || row.TABLE_NAME;
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t).push(`${row.column_name}:${row.data_type}${row.is_nullable === 'NO' ? ' not-null' : ''}`);
    }
    const lines = [...byTable.entries()].slice(0, 40).map(([t, cols]) => `• ${t} — ${truncate(cols.join(', '), 400)}`);
    return `${target.engine} schema (via the repo's ${target.driver} driver, read-only)\n${lines.join('\n') || '(no tables)'}`;
  }
  const sql = String(args?.sql || '').trim();
  if (!sql) return 'ERROR: sql required — e.g. {"sql":"SELECT id, login FROM users LIMIT 10"}';
  if (readOnly && looksLikeWrite(sql)) {
    return 'ERROR: this looks like a write but the tool is in read mode — pass mode:"write" (it asks the user for approval) instead of relying on the transaction to roll it back';
  }
  const params = Array.isArray(args?.params) ? args.params : [];
  const r = runBridge(bridgeScript(target.engine, target.connEnv, sql, params, readOnly), { root, bridgeRunner });
  if (typeof r === 'string') return r;
  const ms = Date.now() - t0;
  const tag = readOnly ? 'read-only transaction' : 'WRITE (approved)';
  if (!r.rows.length) return `${target.engine} ok — 0 rows (${ms}ms, ${tag})`;
  return `${target.engine} selected — ${r.rows.length} row${r.rows.length === 1 ? '' : 's'} (${ms}ms, ${tag})\n${truncate(renderRows(r.cols, r.rows), MAX_OUT)}`;
}

export function createDbTool({ root } = {}) {
  return {
    name: 'db',
    description:
      'Query and inspect the project database — read-only by default. sqlite (node:sqlite, built into node) with {"path":"data/app.db"}; pg/mysql run through the repo\'s OWN driver (node_modules/pg or mysql2 — never bundled) with the connection taken from an env-var reference {"conn_env":"DATABASE_URL"}; absent driver = honest refusal. action:"schema" lists tables/columns/row counts; action:"query" runs SQL with optional params. Writes need mode:"write" which asks the user for approval; in read mode the database itself is opened read-only.',
    args: '{"action":"query","engine":"sqlite","path":"data/app.db","sql":"SELECT id, title FROM tasks ORDER BY id DESC LIMIT 10","params":[]} — or {"action":"schema","engine":"pg","conn_env":"DATABASE_URL"}',
    riskyWhen: (a) => String(a?.mode || 'read') === 'write',
    render: (a) => `db ${a?.engine || 'sqlite'} ${a?.action || 'query'} ${a?.path || a?.conn_env || ''}`.trim(),
    run: async (args) => runDbQuery(args, { root }),
  };
}
