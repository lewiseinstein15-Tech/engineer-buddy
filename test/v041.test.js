// v0.41.0 — the §10 data plane: db tool, secrets vault refs, schema fetching.
//
// Units pinned on injectable runners/fetchers so everything runs offline;
// live sqlite runs against real temp databases (node:sqlite is in the box);
// the bridge (pg/mysql) is pinned by script-text + injected-runner contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parseDbTarget, looksLikeWrite, renderRows, sqliteSchema,
  bridgeScript, runBridge, runDbQuery, createDbTool,
} from '../src/tools/db.js';
import {
  parseSecretRef, resolveSecretRef, checkSecretRef, describeBackends, createSecretTool,
} from '../src/tools/secret.js';
import {
  parseOpenApi, summarizeOpenApi, generateStub, summarizeGraphQl, runSchemaFetch, createSchemaTool,
} from '../src/tools/schema.js';
import { runHttpRequest, resolveAuthHeaders } from '../src/tools/http.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v041-'));
const SPEC = {
  openapi: '3.0.0', info: { title: 'Pet Store', version: '1.2' }, servers: [{ url: 'https://petshop.example.test/v1' }],
  paths: {
    '/pets/{id}': {
      get: { operationId: 'getPetById', summary: 'Find pet by id', parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
        { name: 'verbose', in: 'query', schema: { type: 'boolean' } }], responses: {} },
      delete: { operationId: 'deletePet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: {} },
    },
    '/pets': { post: { operationId: 'addPet', summary: 'Add a pet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { 201: { content: { 'application/json': { schema: { type: 'object' } } } } } } },
  },
  components: { schemas: { Pet: { type: 'object' } } },
};

// ── db: target parsing & safety ──────────────────────────────────────────────

test('db: sqlite target resolves inside root, refuses escapes and missing files', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/app.db'), '');
  const ok = parseDbTarget({ path: 'data/app.db' }, { root });
  assert.equal(ok.ok, true);
  assert.equal(ok.path, path.join(root, 'data/app.db'));
  const up = parseDbTarget({ path: '../evil.db' }, { root });
  assert.equal(up.ok, false);
  assert.match(up.error, /escapes the project root/);
  const missing = parseDbTarget({ path: 'nope.db' }, { root });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);
  const created = parseDbTarget({ path: 'fresh.db', create: 'true', mode: 'write' }, { root });
  assert.equal(created.ok, true);
});

test('db: pg/mysql demand an env reference + the repo driver; literals refused', () => {
  const root = tmp();
  const literal = parseDbTarget({ engine: 'pg', conn: 'postgres://u:p@h/d' }, { root });
  assert.equal(literal.ok, false);
  assert.match(literal.error, /never passed in args/);
  const connUrl = parseDbTarget({ engine: 'mysql', url: 'mysql://u:p@h/d' }, { root });
  assert.match(connUrl.error, /never passed in args/);
  const noEnv = parseDbTarget({ engine: 'pg', conn_env: 'DATABASE_URL' }, { root, env: {} });
  assert.equal(noEnv.ok, false);
  assert.match(noEnv.error, /DATABASE_URL is not set/);
  const noDriver = parseDbTarget({ engine: 'pg', conn_env: 'DATABASE_URL' }, { root, env: { DATABASE_URL: 'postgres://x' } });
  assert.equal(noDriver.ok, false);
  assert.match(noDriver.error, /never bundles drivers/);
  const have = parseDbTarget({ engine: 'pg', conn_env: 'DATABASE_URL' }, { root, env: { DATABASE_URL: 'postgres://x' }, driverProbe: () => true });
  assert.equal(have.ok, true);
  assert.equal(have.driver, 'pg');
  assert.equal(parseDbTarget({ engine: 'mariadb', conn_env: 'MYSQL_URL' }, { root, env: { MYSQL_URL: 'x' }, driverProbe: () => true }).driver, 'mysql2');
});

test('db: looksLikeWrite is the advisory sniff', () => {
  for (const s of ['INSERT INTO t VALUES(1)', '  drop table x', 'update t set a=1', 'create index i on t(a)', 'TRUNCATE t']) assert.equal(looksLikeWrite(s), true, s);
  for (const s of ['SELECT * FROM t', 'with x as (select 1) select * from x', 'explain select 1']) assert.equal(looksLikeWrite(s), false, s);
});

test('db: renderRows caps cells, shows ∅, and truncates long tables', () => {
  const t = renderRows(['a', 'b'], [{ a: 'x'.repeat(500), b: null }, { a: 1, b: { k: 1 } }]);
  assert.match(t, /x{200}…/);
  assert.match(t, /∅/);
  assert.match(t, /{"k":1}/);
  const many = renderRows(['n'], Array.from({ length: 250 }, (_, i) => ({ n: i })), { maxRows: 10 });
  assert.match(many, /… 240 more rows/);
});

test('db: live sqlite — schema, select, read-mode write refusal, approved write, params', async () => {
  const root = tmp();
  const db = new DatabaseSync(path.join(root, 'app.db'));
  db.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0)');
  db.prepare('INSERT INTO tasks(title) VALUES (?)').run('ship');
  db.close();
  const schema = await runDbQuery({ action: 'schema', path: 'app.db' }, { root });
  assert.match(schema, /tasks \(1 row\) — id:INTEGER pk, title:TEXT, done:INTEGER/);
  assert.match(schema, /\[read-only\]/);
  const sel = await runDbQuery({ path: 'app.db', sql: 'SELECT id, title FROM tasks' }, { root });
  assert.match(sel, /selected — 1 row/);
  assert.match(sel, /1 \| ship/);
  const refused = await runDbQuery({ path: 'app.db', sql: 'INSERT INTO tasks(title) VALUES (?)', params: ['x'] }, { root });
  assert.match(refused, /looks like a write.*mode:"write"/);
  const written = await runDbQuery({ path: 'app.db', mode: 'write', sql: 'INSERT INTO tasks(title) VALUES (?)', params: ['drill'] }, { root });
  assert.match(written, /\[read-write\]/);
  const back = await runDbQuery({ path: 'app.db', sql: 'SELECT title FROM tasks WHERE title = ?', params: ['drill'] }, { root });
  assert.match(back, /drill/);
  const engine = new DatabaseSync(path.join(root, 'app.db'), { readOnly: true });
  assert.equal(engine.prepare('SELECT COUNT(*) n FROM tasks').get().n, 2);
  engine.close();
});

test('db: fresh create + native read-only enforcement surfaces honestly', async () => {
  const root = tmp();
  const made = await runDbQuery({ path: 'new.db', create: 'true', mode: 'write', sql: 'CREATE TABLE a(x INTEGER)' }, { root });
  assert.match(made, /\[read-write\]/);
  // a write that slips past the sniff still fails in the engine when read-only:
  const sneaky = await runDbQuery({ path: 'new.db', sql: 'PRAGMA journal_mode = WAL' }, { root });
  assert.match(sneaky, /ERROR:|readonly/i);
});

test('db: sqliteSchema caps tables and lists views', () => {
  const root = tmp();
  const db = new DatabaseSync(path.join(root, 'x.db'));
  db.exec('CREATE TABLE one(i); CREATE TABLE two(i); CREATE VIEW v AS SELECT 1');
  const s = sqliteSchema(db);
  assert.match(s, /• one \(0 rows\)/);
  assert.match(s, /• two \(0 rows\)/);
  assert.match(s, /views: v/);
  db.close();
});

test('db: bridge scripts pin the read-only transaction + env-only connection', () => {
  const pg = bridgeScript('pg', 'DATABASE_URL', 'SELECT 1', [], true);
  assert.match(pg, /require\('pg'\)/);
  assert.match(pg, /BEGIN READ ONLY/);
  assert.match(pg, /ROLLBACK/);
  assert.match(pg, /process\.env\["DATABASE_URL"\]/);
  const my = bridgeScript('mysql', 'MYSQL_URL', 'SELECT 1', ['a'], true);
  assert.match(my, /mysql2\/promise/);
  assert.match(my, /START TRANSACTION READ ONLY/);
  assert.match(my, /ROLLBACK/);
  const myWrite = bridgeScript('mysql', 'MYSQL_URL', 'SELECT 1', [], false);
  assert.doesNotMatch(myWrite, /ROLLBACK/);
  assert.doesNotMatch(myWrite, /START TRANSACTION/);
  assert.doesNotMatch(pg, /postgres:\/\//);
});

test('db: runBridge parses driver JSON, keeps errors honest, refuses garbage', () => {
  const ok = runBridge('SCRIPT', { root: '/tmp', runner: () => ({ code: 0, stdout: '{"cols":["n"],"rows":[{"n":1}]}' }) });
  assert.deepEqual(ok.cols, ['n']);
  const err = runBridge('SCRIPT', { root: '/tmp', runner: () => ({ code: 1, stdout: '{"error":"password authentication failed"}' }) });
  assert.match(err, /ERROR: password authentication failed/);
  const junk = runBridge('SCRIPT', { root: '/tmp', runner: () => ({ code: 0, stdout: 'not json' }) });
  assert.match(junk, /produced no result/);
});

test('db: riskyWhen — read gate-free, write gated', () => {
  const t = createDbTool({ root: '/tmp' });
  assert.equal(t.riskyWhen({}), false);
  assert.equal(t.riskyWhen({ mode: 'write' }), true);
  assert.equal(t.riskyWhen({ mode: 'read' }), false);
});

// ── secret: refs, resolution, hygiene ────────────────────────────────────────

const VALUE = 'hunter2-super-secret-value';
const passRunner = (cmd, argv) => {
  if (cmd === 'pass' && argv[0] === '--version') return { status: 0, stdout: '1.7.4\n' };
  if (cmd === 'op' && argv[0] === '--version') return { status: 0, stdout: '2.0\n' };
  if (cmd === 'pass' && argv[1] === 'github/token') return { status: 0, stdout: `${VALUE}\nsecond line\n` };
  if (cmd === 'op' && argv[0] === 'read') return { status: 0, stdout: `${VALUE}\n` };
  if (cmd === 'pass' && argv[1] === 'gone') return { status: 1, stdout: '', stderr: 'fatal: not in the password store' };
  return { error: new Error('ENOENT') };
};

test('secret: parseSecretRef accepts the three backends and refuses the rest', () => {
  assert.deepEqual(parseSecretRef('env:GITHUB_TOKEN'), { backend: 'env', ref: 'GITHUB_TOKEN' });
  assert.deepEqual(parseSecretRef('pass:github/token'), { backend: 'pass', ref: 'github/token' });
  assert.equal(parseSecretRef('op://Vault/Item/field').backend, 'op');
  assert.match(parseSecretRef('op://Vault/Item').error, /op:\/\/Vault\/Item\/field/);
  assert.match(parseSecretRef('ftp:x').error, /unknown secret ref/);
  assert.match(parseSecretRef('pass:two words').error, /without spaces/);
  assert.match(parseSecretRef('').error, /secret ref required/);
});

test('secret: resolveSecretRef — env, pass (line 1), op; errors never carry the value', async () => {
  const r = await resolveSecretRef('pass:github/token', { runner: passRunner });
  assert.equal(r.value, VALUE); // first line only
  const o = await resolveSecretRef('op://Vault/Item/field', { runner: passRunner });
  assert.equal(o.value, VALUE);
  const e = await resolveSecretRef('env:MY_TOKEN', { env: { MY_TOKEN: VALUE } });
  assert.equal(e.value, VALUE);
  const missing = await resolveSecretRef('env:NOPE', {});
  assert.match(missing.error, /NOPE is not set/);
  const failed = await resolveSecretRef('pass:gone', { runner: passRunner });
  assert.match(failed.error, /pass exited 1/);
  assert.ok(!failed.error.includes('password store'), 'stderr is suppressed');
  for (const bad of ['pass:gone', 'env:NOPE']) {
    const x = await resolveSecretRef(bad, { runner: passRunner });
    assert.ok(!JSON.stringify(x).includes('hunter2'), `error must not leak: ${bad}`);
  }
});

test('secret: check reports length only; backends describe presence', async () => {
  const c = await checkSecretRef('pass:github/token', { runner: passRunner });
  assert.deepEqual(c, { ok: true, backend: 'pass', length: VALUE.length });
  assert.ok(!JSON.stringify(c).includes('hunter2'));
  const b = describeBackends({ runner: passRunner });
  assert.match(b.pass, /pass CLI on PATH/);
  assert.match(b.op, /1Password CLI on PATH/);
  const b2 = describeBackends({ runner: () => ({ error: new Error('nf') }) });
  assert.match(b2.pass, /not found/);
});

test('secret: http auth accepts a vault ref — header carries it, observation never does', async () => {
  const resolveRef = async (ref) => (ref === 'pass:github/token' ? { value: VALUE } : { error: 'cannot resolve' });
  let saw = null;
  const fetchImpl = async (url, init) => { saw = init.headers.authorization; return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => `ok len:${VALUE.length}` }; };
  const obs = await runHttpRequest({ method: 'GET', url: 'https://api.example.test/me', auth: { type: 'bearer', ref: 'pass:github/token' } }, { fetchImpl, resolveRef });
  assert.equal(saw, `Bearer ${VALUE}`);
  assert.match(obs, /len:26/);
  assert.ok(!obs.includes('hunter2'));
  const both = await runHttpRequest({ method: 'GET', url: 'https://api.example.test', auth: { type: 'bearer', env: 'A', ref: 'pass:b' } }, { fetchImpl, resolveRef });
  assert.match(both, /ONE of auth\.env or auth\.ref/);
  const bad = await runHttpRequest({ method: 'GET', url: 'https://api.example.test', auth: { type: 'bearer', ref: 'pass:gone' } }, { fetchImpl, resolveRef });
  assert.match(bad, /ERROR: cannot resolve/);
});

test('secret: sync resolveAuthHeaders still env-only and refuses refs with a pointer', () => {
  assert.deepEqual(resolveAuthHeaders({ type: 'bearer', env: 'T' }, { T: 'v' }).headers, { authorization: 'Bearer v' });
  assert.match(resolveAuthHeaders({ type: 'bearer', ref: 'pass:x' }, {}).error, /asynchronously/);
});

test('secret: the tool surfaces check/backends without values', async () => {
  const t = createSecretTool({ runner: passRunner });
  const chk = await t.run({ action: 'check', ref: 'pass:github/token' });
  assert.match(chk, /resolves — backend pass, 26 chars/);
  assert.ok(!chk.includes('hunter2'));
  assert.match(await t.run({ action: 'backends' }), /env:NAME/);
  assert.match(await t.run({ action: 'wat' }), /"check" or "backends"/);
});

// ── schema: openapi + graphql ────────────────────────────────────────────────

test('schema: parseOpenApi — JSON ok, YAML refused with the reason, junk honest', () => {
  assert.equal(parseOpenApi(JSON.stringify(SPEC)).ok, true);
  const yaml = parseOpenApi('openapi: 3.0.0\npaths:\n  /x:\n    get:\n');
  assert.match(yaml.error, /YAML.*JSON specs only/);
  assert.match(parseOpenApi('{"hello":"world"}').error, /no "paths"/);
  assert.match(parseOpenApi('').error, /empty/);
  assert.match(parseOpenApi('{broken').error, /invalid JSON/);
});

test('schema: summarizeOpenApi lists endpoints with params/body/response types', () => {
  const s = summarizeOpenApi(SPEC);
  assert.match(s, /OpenAPI 3\.0\.0 — Pet Store v1\.2/);
  assert.match(s, /servers: https:\/\/petshop\.example\.test\/v1/);
  assert.match(s, /• GET \/pets\/\{id\} — Find pet by id \| id!:number, verbose:boolean/);
  assert.match(s, /• POST \/pets — Add a pet body:Pet/);
  assert.match(s, /3 operations total/);
});

test('schema: generateStub produces a working zero-dep client (imported and called)', async () => {
  const gen = generateStub(SPEC, { name: 'petstore' });
  assert.equal(gen.ops, 3);
  assert.match(gen.code, /getPetById/);
  assert.match(gen.code, /encodeURIComponent\(path\.id\)/);
  assert.match(gen.code, /https:\/\/petshop\.example\.test\/v1/);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'petstore.client.js'), gen.code);
  const mod = await import(path.join(dir, 'petstore.client.js'));
  let saw = null;
  const c = mod.makeClient({ fetchImpl: async (u, i) => { saw = { u, i }; return { ok: true, status: 200, text: async () => '{"id":5}' }; } });
  assert.deepEqual(await c.getPetById({ id: 5 }, { verbose: true }), { id: 5 });
  assert.equal(saw.u, 'https://petshop.example.test/v1/pets/5?verbose=true');
  await c.addPet({ name: 'rex' });
  assert.equal(saw.i.method, 'POST');
  assert.equal(saw.i.headers['content-type'], 'application/json');
  const c404 = mod.makeClient({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'gone' }) });
  await assert.rejects(() => c404.deletePet({ id: 1 }), /HTTP 404/);
});

test('schema: runSchemaFetch — file source, write_stub gated + written, SSRF refused', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'openapi.json'), JSON.stringify(SPEC));
  const obs = await runSchemaFetch({ action: 'openapi', file: 'openapi.json' }, { root });
  assert.match(obs, /3 operations total/);
  assert.match(obs, /write_stub:true/);
  let written = null;
  const wrote = await runSchemaFetch({ action: 'openapi', file: 'openapi.json', write_stub: true, name: 'petstore' }, { root, writeText: (t, c) => { written = { t, c }; } });
  assert.match(wrote, /WRITTEN to petstore\.client\.js \(3 operations/);
  assert.match(written.c, /export function makeClient/);
  assert.equal(written.t, path.join(root, 'petstore.client.js'));
  const esc = await runSchemaFetch({ action: 'openapi', file: '../x.json' }, { root });
  assert.match(esc, /escapes the project root/);
  const local = await runSchemaFetch({ action: 'openapi', url: 'http://127.0.0.1/spec.json' }, { root });
  assert.match(local, /local\/internal addresses are blocked/);
  const both = await runSchemaFetch({ action: 'openapi', url: 'https://a.b/c.json', file: 'x.json' }, { root });
  assert.match(both, /ONE of url or file/);
});

test('schema: graphql introspection via injectable fetch; honest failures', async () => {
  const data = { data: { __schema: { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [
    { kind: 'OBJECT', name: 'Pet', fields: [{ name: 'name', type: { kind: 'SCALAR', name: 'String' } }, { name: 'owner', type: { kind: 'OBJECT', name: 'Human', ofType: null } }] },
    { kind: 'SCALAR', name: 'String' },
  ] } } };
  const fetchImpl = async (url, init) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
  const obs = await runSchemaFetch({ action: 'graphql', url: 'https://gql.example.test' }, { fetchImpl });
  assert.match(obs, /query root: Query, mutation root: Mutation/);
  assert.match(obs, /• type Pet — name: String, owner: Human/);
  assert.match(obs, /1 type total/);
  const errors = await runSchemaFetch({ action: 'graphql', url: 'https://gql.example.test' }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ errors: [{ message: 'not allowed' }] }) }) });
  assert.match(errors, /not allowed/);
  const noSchema = await runSchemaFetch({ action: 'graphql', url: 'https://gql.example.test' }, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"data":{}}' }) });
  assert.match(noSchema, /no __schema/);
  const summarize = summarizeGraphQl(data);
  assert.equal(summarize.ok, true);
});

test('schema: riskyWhen — graphql POST and stub writes gated, plain reads not', () => {
  const t = createSchemaTool({ root: '/tmp' });
  assert.equal(t.riskyWhen({ action: 'openapi', file: 'a.json' }), false);
  assert.equal(t.riskyWhen({ action: 'openapi', url: 'https://x/o.json' }), false);
  assert.equal(t.riskyWhen({ action: 'openapi', file: 'a.json', write_stub: true }), true);
  assert.equal(t.riskyWhen({ action: 'graphql', url: 'https://x/gql' }), true);
});

// ── wiring: the three tools join the registry ────────────────────────────────

test('v041: local.js registers db, secret, schema beside perf/timetravel', async () => {
  const src = fs.readFileSync(new URL('../src/tools/local.js', import.meta.url), 'utf8');
  assert.match(src, /createDbTool\(\{ root: scope\.root \}\)/);
  assert.match(src, /createSecretTool\(\{\}\)/);
  assert.match(src, /createSchemaTool\(\{ root: scope\.root \}\)/);
});
