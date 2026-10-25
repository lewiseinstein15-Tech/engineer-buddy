// usertools.js — user-defined tools from .buddy/tools/ (v0.14.0).
//
// Each tool is a folder: <dir>/<name>/manifest.json + <name>/index.js.
//   manifest.json — { name, description, version, args?, argsSchema?, safe?, deprecated?, maxCalls?, timeoutMs? }
//   index.js      — zero-dep ESM: `export async function run(args, ctx) { return 'string result' }`
//
// Layers: project `.buddy/tools/` wins over personal `~/.buddy/tools/` on a
// name collision (same rule as custom commands). A user tool can never
// shadow a built-in — collisions with registry names are skipped loudly.
//
// Sandboxing (checklist §3): every call runs in a SHORT-LIVED CHILD PROCESS
// (`node src/tools/userruntime.js <index.js> <json-args> <root>`), so a
// crashing / hanging / process.exit()-ing tool can never kill the REPL. The
// child prints exactly one JSON envelope on stdout; author console.log is
// redirected to stderr by the runtime so the channel stays clean.
//
// Versioning (checklist §3): manifest.version is required (int >= 1) and
// surfaces in the tool description ([user-tool vN]); manifest.deprecated
// marks the description AND appends a migration note to every result.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { truncate } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const USER_RUNTIME = path.join(__dirname, 'userruntime.js');

const NAME_RE = /^[a-z][a-z0-9_-]{1,39}$/;
const OUTPUT_CAP = 8000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CALLS = 4;

/** Primitive JSON-schema-ish type check — 'string' | 'number' | 'boolean' | 'array' | 'object'. */
function argMatchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true; // unknown type annotations are the author's problem
  }
}

/** Compact prompt hint from a JSON Schema: example-shaped, like built-in tools. */
export function argsHintFromSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props).slice(0, 10);
  if (!keys.length) return null;
  const example = {};
  for (const k of keys) {
    const t = props[k]?.type;
    example[k] = t === 'number' ? 0 : t === 'boolean' ? false : t === 'array' ? [] : t === 'object' ? {} : '...';
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => keys.includes(k)) : [];
  const tail = required.length ? ` — required: ${required.join(', ')}` : '';
  return `${JSON.stringify(example)}${tail}`;
}

/**
 * Validate one tool folder. Returns { tool } | { warning }.
 * Never throws — a broken tool folder degrades to a warning, startup continues.
 */
export function parseUserToolDir(dir, source) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    return { warning: `${path.basename(dir)} (${source}): bad or missing manifest.json — ${truncate(e.message, 90)}` };
  }
  const name = typeof manifest?.name === 'string' ? manifest.name.trim() : '';
  if (!NAME_RE.test(name)) {
    return { warning: `${path.basename(dir)} (${source}): name must match ${NAME_RE} (got ${JSON.stringify(manifest?.name)})` };
  }
  const description = typeof manifest?.description === 'string' ? manifest.description.trim() : '';
  if (!description) return { warning: `${name} (${source}): manifest.description is required` };
  const version = manifest?.version;
  if (!Number.isInteger(version) || version < 1) {
    return { warning: `${name} (${source}): manifest.version must be an integer >= 1 (got ${JSON.stringify(version)})` };
  }
  const indexPath = path.join(dir, 'index.js');
  if (!fs.existsSync(indexPath)) return { warning: `${name} (${source}): index.js missing — nothing to run` };

  const deprecated = typeof manifest?.deprecated === 'string' ? manifest.deprecated.trim() : '';
  const schemaHint = argsHintFromSchema(manifest?.argsSchema);
  const argsHint = typeof manifest?.args === 'string' && manifest.args.trim()
    ? manifest.args.trim()
    : schemaHint || '{"...":"see manifest.argsSchema"}';
  const fullDescription = `[user-tool v${version}${deprecated ? ' · DEPRECATED' : ''}] ${description.slice(0, 300)}${deprecated ? ` [deprecated: ${truncate(deprecated, 120)}]` : ''}`;

  const maxCalls = Number.isInteger(manifest?.maxCalls) ? Math.min(Math.max(manifest.maxCalls, 1), 20) : DEFAULT_MAX_CALLS;
  const timeoutMs = Number.isInteger(manifest?.timeoutMs) ? Math.min(Math.max(manifest.timeoutMs, 250), 120000) : DEFAULT_TIMEOUT_MS;

  return {
    tool: {
      name,
      version,
      source,
      indexPath,
      dir,
      manifest,
      def: {
        name,
        description: fullDescription,
        args: argsHint,
        risky: manifest?.safe !== true, // arbitrary user code — gate unless the author opts out
        maxCalls,
        render: (a) => `${name} ${truncate(JSON.stringify(a ?? {}), 90)}`,
        run: null, // closed over below by createUserToolRun
      },
    },
  };
}

/**
 * One sandboxed call: spawn the runtime child, feed args, read one JSON
 * envelope from stdout. Everything except a clean envelope becomes an
 * `ERROR: ...` string (the observation shape the loop already handles).
 */
export function runUserTool(entry, args = {}, { root = process.cwd(), timeoutMs = entry?.manifest?.timeoutMs ?? DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [USER_RUNTIME, entry.indexPath, JSON.stringify(args ?? {}), root], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve(`ERROR (${entry.name}): could not spawn sandbox — ${truncate(e.message, 200)}`);
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(`ERROR (${entry.name}): timed out after ${timeoutMs}ms — killed. Raise manifest.timeoutMs if this tool is legitimately slow.`), timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > OUTPUT_CAP * 2) finish(`ERROR (${entry.name}): output exceeded the cap — the sandbox killed it.`); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(`ERROR (${entry.name}): ${truncate(e.message, 200)}`));
    child.on('close', (code) => {
      // The envelope is the FIRST line of stdout — anything after it (a
      // misbehaving runtime, a second emit) must not corrupt the parse.
      const firstLine = out.split('\n').find((l) => l.trim());
      let envelope = null;
      try { envelope = JSON.parse(firstLine ?? ''); } catch { /* not our envelope */ }
      if (envelope && envelope.ok) {
        const note = entry.manifest?.deprecated ? `\n[deprecated tool: ${truncate(String(entry.manifest.deprecated), 200)}]` : '';
        const body = envelope.result == null || envelope.result === '' ? '(empty result)' : String(envelope.result);
        finish(`${truncate(body, OUTPUT_CAP)}${note}`);
      } else if (envelope && envelope.error) {
        finish(`ERROR (${entry.name}): ${truncate(String(envelope.error), 600)}`);
      } else if (code === 0) {
        finish(`ERROR (${entry.name}): no result envelope — did index.js export run(args, ctx)?${err.trim() ? ` stderr: ${truncate(err.trim(), 300)}` : ''}`);
      } else {
        finish(`ERROR (${entry.name}): exited with code ${code}${err.trim() ? ` — ${truncate(err.trim(), 400)}` : ''}`);
      }
    });
  });
}

/**
 * Scan user tool dirs and return registry-ready tool defs + warnings.
 * Project (.buddy/tools) shadows personal (~/.buddy/tools); registry-name
 * collisions (built-ins etc.) are refused by the caller-side filter below.
 */
export function loadUserTools(root, { home = os.homedir(), extraNames = new Set() } = {}) {
  const layers = [
    { source: 'project', dir: path.join(root, '.buddy', 'tools') },
    { source: 'personal', dir: path.join(home, '.buddy', 'tools') },
  ];
  const tools = [];
  const warnings = [];
  const seen = new Map(); // name -> source that owns it (project first)
  for (const layer of layers) {
    let entries = [];
    try {
      entries = fs
        .readdirSync(layer.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      continue; // layer absent — normal
    }
    for (const name of entries) {
      const { tool, warning } = parseUserToolDir(path.join(layer.dir, name), layer.source);
      if (warning) { warnings.push(warning); continue; }
      if (seen.has(tool.name)) { warnings.push(`${tool.name}: ${layer.source} copy ignored — ${seen.get(tool.name)} one wins`); continue; }
      if (extraNames.has(tool.name)) { warnings.push(`${tool.name}: user tool cannot shadow a built-in (${layer.source}) — skipped`); continue; }
      seen.set(tool.name, layer.source);
      const def = tool.def;
      def.run = (args = {}) => {
        // Schema gate BEFORE the sandbox spawns — a wrong call costs nothing.
        const schema = tool.manifest?.argsSchema;
        if (schema && typeof schema === 'object') {
          const required = Array.isArray(schema.required) ? schema.required : [];
          const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
          if (missing.length) return Promise.resolve(`ERROR (${tool.name}): missing required arg${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} — schema: ${truncate(JSON.stringify(schema), 200)}`);
          const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
          for (const [k, v] of Object.entries(args ?? {})) {
            const t = props[k]?.type;
            if (t && !argMatchesType(v, t)) {
              return Promise.resolve(`ERROR (${tool.name}): arg "${k}" must be ${t} (got ${Array.isArray(v) ? 'array' : typeof v}) — schema: ${truncate(JSON.stringify(schema), 200)}`);
            }
          }
        }
        return runUserTool(tool, args, { root });
      };
      tools.push(def);
    }
  }
  return { tools, warnings };
}
