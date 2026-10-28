// schema.js — API schema fetching + typed client stubs (v0.41.0, checklist §10).
//
// "API schema fetching — pull OpenAPI specs / GraphQL introspection into
// context and generate typed client stubs."
//
// Two actions:
//   openapi  — read a spec from a URL (safe GET) or a project file, summarize
//              every endpoint into the context, and optionally WRITE a
//              zero-dep typed client stub (write_stub → approval gate, the
//              same class as fs writes).
//   graphql  — POST a standard introspection query and summarize the type
//              system (gated — it is a POST to the user's endpoint).
//
// Zero-dep by construction: the stub is plain ESM over globalThis.fetch with
// per-operation functions, path/query params and JSDoc types from the spec's
// own schemas. JSON specs only — a YAML spec is refused honestly (convert it
// first; half-parsed YAML would lie to the model).

import fs from 'node:fs';
import path from 'node:path';
import { blockedHost } from './web.js';
import { truncate } from '../util.js';

export const MAX_ENDPOINTS = 60;
export const MAX_TYPES = 40;

const INTROSPECTION_QUERY = `query IntrospectionQuery { __schema { queryType { name } mutationType { name } types { kind name description fields { name description type { kind name ofType { kind name ofType { kind name } } } args { name type { kind name ofType { kind name ofType { kind name } } } } } } } }`;

/** Parse + validate an OpenAPI document. Returns {ok, spec} or {error}. */
export function parseOpenApi(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { error: 'the spec is empty' };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const spec = JSON.parse(trimmed);
      if (!spec || typeof spec !== 'object') return { error: 'the spec is not a JSON object' };
      if (!spec.paths || typeof spec.paths !== 'object') return { error: 'not an OpenAPI document — no "paths" object (is it a YAML spec? convert to JSON first — Buddy parses JSON specs only)' };
      return { ok: true, spec };
    } catch (e) {
      return { error: `invalid JSON: ${truncate(String(e?.message || e), 160)}` };
    }
  }
  if (/^openapi\s*:/m.test(trimmed) || /^paths\s*:/m.test(trimmed)) {
    return { error: 'this looks like a YAML OpenAPI spec — Buddy parses JSON specs only (convert it once: `js-yaml spec.yaml > spec.json` — then re-run)' };
  }
  return { error: 'not an OpenAPI document (no "paths" object, not JSON)' };
}

const camelize = (s) => String(s || '').replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));

/** A function name for an operation: operationId, else method+path. */
export function opName(method, p, op) {
  if (op?.operationId && /^[A-Za-z_][A-Za-z0-9_]*$/.test(op.operationId)) return op.operationId;
  const seg = String(p).replace(/\{([^}]+)\}/g, 'by $1').split('/').filter(Boolean).join(' ');
  const name = camelize(`${method.toLowerCase()} ${seg}`);
  return name || `${method.toLowerCase()}_root`;
}

/** jsdoc-ish type from an OpenAPI schema object. */
function schemaType(s) {
  if (!s || typeof s !== 'object') return 'any';
  if (s.type === 'integer' || s.type === 'number') return 'number';
  if (s.type === 'string') return 'string';
  if (s.type === 'boolean') return 'boolean';
  if (s.type === 'array') return `Array<${schemaType(s.items)}>`;
  if (s.type === 'object') return 'object';
  if (Array.isArray(s.enum)) return s.enum.map((e) => JSON.stringify(e)).join('|');
  if (s.$ref) return String(s.$ref).split('/').pop() || 'any';
  return 'any';
}

/** Summarize an OpenAPI spec into context: one line per endpoint, capped. */
export function summarizeOpenApi(spec, { max = MAX_ENDPOINTS } = {}) {
  const info = spec?.info || {};
  const lines = [];
  lines.push(`OpenAPI ${spec.openapi || spec.swagger || ''} — ${truncate(String(info.title || 'untitled'), 80)}${info.version ? ` v${info.version}` : ''}`);
  if (spec.servers?.length) lines.push(`servers: ${spec.servers.map((s) => s.url).slice(0, 3).join(', ')}`);
  let count = 0;
  for (const [p, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = pathItem?.[method];
      if (!op) continue;
      count++;
      if (lines.length > max + 2) continue;
      const params = [];
      for (const param of [...(pathItem.parameters || []), ...(op.parameters || [])].slice(0, 6)) {
        params.push(`${param.name}${param.required ? '!' : ''}:${schemaType(param.schema)}`);
      }
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      const req = bodySchema ? ` body:${schemaType(bodySchema)}` : '';
      const resp200 = op.responses?.['200'] || op.responses?.['201'] || op.responses?.default;
      const respSchema = resp200?.content?.['application/json']?.schema;
      const resp = respSchema ? ` → ${schemaType(respSchema)}` : '';
      lines.push(`• ${method.toUpperCase()} ${p}${op.deprecated ? ' (deprecated)' : ''} — ${truncate(String(op.summary || op.description || opName(method, p, op)), 90)}${params.length ? ` | ${params.join(', ')}` : ''}${req}${resp}`);
    }
  }
  if (count > max) lines.push(`… ${count - max} more operations (cap ${max})`);
  lines.push(`${count} operation${count === 1 ? '' : 's'} total`);
  return lines.join('\n');
}

/** Generate the zero-dep typed client stub. Returns {ok, code, ops} or {error}. */
export function generateStub(spec, { name = 'api-client', fetchName = 'fetch' } = {}) {
  const ops = [];
  for (const [p, pathItem] of Object.entries(spec?.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = pathItem?.[method];
      if (!op) continue;
      const pname = opName(method, p, op);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pname)) continue;
      const pathParams = [...(pathItem.parameters || []), ...(op.parameters || [])].filter((x) => x.in === 'path').map((x) => x.name);
      const queryParams = [...(pathItem.parameters || []), ...(op.parameters || [])].filter((x) => x.in === 'query').map((x) => x.name);
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      const doc = [];
      doc.push(`  /** ${truncate(String(op.summary || opName(method, p, op)), 120)} — ${method.toUpperCase()} ${p}`);
      if (pathParams.length) doc.push(`   * @param {{ ${pathParams.map((n) => `${n}: ${schemaType([...(pathItem.parameters || []), ...(op.parameters || [])].find((x) => x.name === n)?.schema)}`).join(', ')} }} path`);
      if (queryParams.length) doc.push(`   * @param {{ ${queryParams.map((n) => `${n}?: ${schemaType([...(pathItem.parameters || []), ...(op.parameters || [])].find((x) => x.name === n)?.schema)}`).join(', ')} }} [query]`);
      if (bodySchema) doc.push(`   * @param {${schemaType(bodySchema)}} body`);
      doc.push(`   */`);
      const argsSig = [
        pathParams.length ? 'path' : null,
        bodySchema ? 'body' : null,
        queryParams.length ? 'query' : null,
      ].filter(Boolean);
      const callPath = pathParams.length
        ? '`' + p.replace(/\{([^}]+)\}/g, '${encodeURIComponent(path.$1)}') + '`'
        : JSON.stringify(p);
      const initParts = [`method: '${method.toUpperCase()}'`];
      if (bodySchema) initParts.push(`headers: { 'content-type': 'application/json' }`, `body: JSON.stringify(body)`);
      const queryPart = queryParams.length ? `+ (query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : '')` : '';
      ops.push({
        pname,
        block: [
          ...doc,
          `  ${pname}(${argsSig.join(', ')}) {`,
          `    return call(${callPath}${queryPart}, { ${initParts.join(', ')} });`,
          `  }`,
        ].join('\n'),
      });
    }
  }
  if (!ops.length) return { error: 'no operations found in the spec — nothing to stub' };
  const shown = ops.slice(0, 120);
  const code = `// ${name}.client.js — generated by engineer-buddy from the OpenAPI spec (${shown.length}${ops.length > shown.length ? ` of ${ops.length}` : ''} operations).\n// Zero dependencies: plain fetch. Review before committing — the spec is the contract.\n\nexport function makeClient({ baseUrl = ${JSON.stringify(String(spec?.servers?.[0]?.url || 'https://example.com'))}, headers = {}, fetchImpl = globalThis.${fetchName} } = {}) {\n  async function call(path, init = {}) {\n    const res = await fetchImpl(baseUrl.replace(/\\/$/, '') + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });\n    const text = await res.text();\n    let data = text;\n    try { data = JSON.parse(text); } catch { /* keep text */ }\n    if (!res.ok) throw new Error(\`HTTP \${res.status} \${path}: \${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}\`);\n    return data;\n  }\n  return {\n${shown.map((o) => o.block).join(',\n')},\n  };\n}\n`;
  return { ok: true, code, ops: ops.length };
}

/** Summarize a GraphQL introspection result. */
export function summarizeGraphQl(data, { max = MAX_TYPES } = {}) {
  const schema = data?.data?.__schema || data?.__schema;
  if (!schema) return { error: 'the response has no __schema — is introspection enabled?' };
  const types = (schema.types || []).filter((t) => !String(t.name).startsWith('__') && !['Int', 'Float', 'String', 'Boolean', 'ID'].includes(t.name));
  const lines = [];
  lines.push(`GraphQL schema — query root: ${schema.queryType?.name || '?'}, mutation root: ${schema.mutationType?.name || 'none'}`);
  const shown = types.slice(0, max);
  for (const t of shown) {
    const kind = { OBJECT: 'type', INTERFACE: 'interface', ENUM: 'enum', SCALAR: 'scalar', INPUT_OBJECT: 'input', UNION: 'union' }[t.kind] || t.kind;
    const fields = (t.fields || []).slice(0, 12).map((f) => {
      const ty = f.type?.name || (f.type?.ofType ? `${f.type.kind.toLowerCase()}<${f.type.ofType.name || f.type.ofType.kind}>` : '?');
      return `${f.name}: ${ty}`;
    });
    lines.push(`• ${kind} ${t.name}${fields.length ? ` — ${truncate(fields.join(', '), 300)}` : ''}`);
  }
  if (types.length > max) lines.push(`… ${types.length - max} more types`);
  lines.push(`${types.length} type${types.length === 1 ? '' : 's'} total`);
  return { ok: true, text: lines.join('\n') };
}

/** One schema tool call → observation (never throws). Injectable fetchImpl. */
export async function runSchemaFetch(args = {}, { root = process.cwd(), fetchImpl = globalThis.fetch, writeText = null } = {}) {
  const action = String(args?.action || 'openapi');
  const t0 = Date.now();

  if (action === 'openapi') {
    let text = '';
    let source = '';
    const url = String(args?.url || '').trim();
    const file = String(args?.file || '').trim();
    if (url && file) return 'ERROR: use ONE of url or file — not both';
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { return 'ERROR: url must be an absolute http(s) URL'; }
      if (!/^https?:$/.test(parsed.protocol)) return 'ERROR: only http(s) URLs are allowed';
      if (blockedHost(parsed.hostname)) return 'ERROR: requests to local/internal addresses are blocked';
      try {
        const res = await fetchImpl(parsed.href, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        text = await res.text();
        source = `fetched ${parsed.href} (HTTP ${res.status})`;
        if (!res.ok) return `ERROR: HTTP ${res.status} fetching the spec from ${parsed.href}`;
      } catch (e) {
        return `ERROR: fetching the spec failed — ${truncate(String(e?.message || e), 200)}`;
      }
    } else if (file) {
      const abs = path.isAbsolute(file) ? file : path.join(root, file);
      const inside = path.resolve(abs).startsWith(path.resolve(root) + path.sep) || path.resolve(abs) === path.resolve(root);
      if (!inside) return `ERROR: file escapes the project root: ${file}`;
      try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return `ERROR: cannot read ${file} — ${truncate(String(e?.message || e), 160)}`; }
      source = `file ${file}`;
    } else {
      return 'ERROR: openapi needs a source — {"url":"https://…/openapi.json"} or {"file":"openapi.json"}';
    }
    const parsed = parseOpenApi(text);
    if (parsed.error) return `ERROR: ${parsed.error}`;
    const spec = parsed.spec;
    const summary = summarizeOpenApi(spec);
    if (String(args?.write_stub) === 'true') {
      const name = String(args?.name || 'api-client').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'api-client';
      const gen = generateStub(spec, { name });
      if (gen.error) return `spec summarized, but the stub failed: ${gen.error}\n\n${summary}`;
      const target = path.join(root, `${name}.client.js`);
      try {
        if (writeText) writeText(target, gen.code);
        else fs.writeFileSync(target, gen.code);
      } catch (e) {
        return `spec summarized, but writing the stub failed — ${truncate(String(e?.message || e), 200)}\n\n${summary}`;
      }
      return `OpenAPI spec parsed from ${source} — client stub WRITTEN to ${name}.client.js (${gen.ops} operations, zero-dep fetch; review before committing)\n\n${summary}\n(${Date.now() - t0}ms)`;
    }
    return `OpenAPI spec from ${source}:\n\n${summary}\n(pass write_stub:true to generate ${String(args?.name || 'api-client')}.client.js — that writes a file and asks for approval)\n(${Date.now() - t0}ms)`;
  }

  if (action === 'graphql') {
    const url = String(args?.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { return 'ERROR: graphql needs an absolute http(s) endpoint URL'; }
    if (!/^https?:$/.test(parsed.protocol)) return 'ERROR: only http(s) URLs are allowed';
    if (blockedHost(parsed.hostname)) return 'ERROR: requests to local/internal addresses are blocked';
    try {
      const res = await fetchImpl(parsed.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: INTROSPECTION_QUERY }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.text();
      if (!res.ok) return `ERROR: HTTP ${res.status} from ${parsed.href} — ${truncate(body, 200)}`;
      let data;
      try { data = JSON.parse(body); } catch { return 'ERROR: the endpoint did not return JSON'; }
      if (data?.errors?.length) return `ERROR: introspection returned errors — ${truncate(JSON.stringify(data.errors), 300)}`;
      const s = summarizeGraphQl(data, { max: args?.max_types });
      if (s.error) return `ERROR: ${s.error}`;
      return `GraphQL introspection from ${parsed.href}:\n\n${s.text}\n(${Date.now() - t0}ms)`;
    } catch (e) {
      return `ERROR: introspection failed — ${truncate(String(e?.message || e), 200)}`;
    }
  }
  return `ERROR: action must be "openapi" or "graphql" (got "${truncate(String(action), 24)}")`;
}

export function createSchemaTool({ root } = {}) {
  return {
    name: 'schema',
    description:
      'Pull an API schema into context and generate a typed client: action:"openapi" reads a JSON OpenAPI spec (from url or project file), summarizes every endpoint, and with write_stub:true generates <name>.client.js — a zero-dep fetch client with one function per operation (YAML specs are refused honestly — convert to JSON first). action:"graphql" runs a standard introspection query against an endpoint and summarizes the type system. Stub writing is gated like any file write.',
    args: '{"action":"openapi","url":"https://api.example.test/openapi.json","write_stub":true,"name":"petstore"} | {"action":"graphql","url":"https://api.example.test/graphql"}',
    riskyWhen: (a) => String(a?.action || 'openapi') === 'graphql' || String(a?.write_stub) === 'true',
    render: (a) => `schema ${a?.action || 'openapi'} ${a?.url || a?.file || ''}`.trim(),
    run: async (args) => runSchemaFetch(args, { root }),
  };
}
