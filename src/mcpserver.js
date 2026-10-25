// mcpserver.js — Buddy as an MCP SERVER (v0.15.0): symmetry with the client.
//
// `buddy mcp-serve` exposes Buddy's core capabilities over the same
// newline-delimited JSON-RPC 2.0 stdio transport the MCP client speaks, so
// OTHER agents (Claude Code, opencode, another Buddy) can drive this repo:
//   buddy_fs_list / buddy_fs_read / buddy_fs_search / buddy_repo_map  (read)
//   buddy_run_tests                                                   (test)
//   buddy_apply_patch / buddy_fs_write                                (mutate, --allow-writes)
//   buddy_todo_state                                                  (shared plan)
//
// Safety model (mirrors the harness guardrail discipline):
//   - reads go through LocalScope (secret paths refused, caps enforced)
//   - writes are OFF by default — refuse unless --allow-writes is passed;
//     the driving agent's own approval gate is the intended human door
//   - tool failures are MCP isError results, never JSON-RPC protocol errors
//   - stdout carries ONLY protocol lines; all logs go to stderr
import path from 'node:path';
import fs from 'node:fs';
import { LocalScope, buildLocalTools } from './tools/local.js';
import { createRepoMapProvider } from './agent/repomap.js';
import { createTestTool } from './tools/testrunner.js';
import { truncate } from './util.js';

const PROTOCOL_VERSION = '2024-11-05';

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Latest todo plan, persisted by the todo tool (local.js) to .buddy/todo.json. */
function readTodoState(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.buddy', 'todo.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build the MCP tool table. `writes` flips the mutating pair on.
 * Each entry: {name, description, inputSchema, run(args) -> string}.
 */
export function serverTools(root, { writes = false, version = '0.15.0' } = {}) {
  const scope = new LocalScope(root);
  const repoMap = createRepoMapProvider(root, { maxChars: 2800 });
  const testTool = createTestTool({ root });
  const writeNote = writes ? '' : ' (disabled on this server — restart with --allow-writes)';

  const tools = [
    {
      name: 'buddy_fs_list',
      description: 'List files in a directory of the workspace Buddy is rooted at.',
      inputSchema: { type: 'object', properties: { dir: { type: 'string', description: 'relative dir, default "."' } } },
      run: async ({ dir = '.' } = {}) => scope.list(String(dir)).join('\n') || '(empty)',
    },
    {
      name: 'buddy_fs_read',
      description: 'Read a file (capped). Secret paths are refused by policy.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async ({ path: p } = {}) => {
        if (!p) return 'ERROR: path required';
        try {
          const r = scope.read(String(p));
          return `FILE ${p}${r.truncated ? ' (truncated)' : ''}:\n${r.content}`;
        } catch (e) {
          return `ERROR: ${e?.message || e}`;
        }
      },
    },
    {
      name: 'buddy_fs_search',
      description: 'Search the workspace (substring or regex). Cheapest way to locate code.',
      inputSchema: { type: 'object', properties: { needle: { type: 'string' }, regex: { type: 'boolean' } }, required: ['needle'] },
      run: async ({ needle, regex = false } = {}) => {
        if (!needle) return 'ERROR: needle required';
        const hits = scope.search(String(needle), { regex: Boolean(regex) });
        return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') || '(no matches)';
      },
    },
    {
      name: 'buddy_repo_map',
      description: 'Churn-ranked map of the workspace: files with module-level symbols. A hint, not the tree.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => repoMap() || '(empty map)',
    },
    {
      name: 'buddy_run_tests',
      description: `Run the workspace test suite (auto-detects node --test / pytest / go / npm). ${testTool.description || ''}`.trim(),
      inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'file or file::test-name' }, rerun_failures: { type: 'boolean' } } },
      run: async (args = {}) => testTool.run(args),
    },
    {
      name: 'buddy_todo_state',
      description: 'Read the todo plan Buddy last saved for this workspace (id/text/status/blocked_by), or clear it.',
      inputSchema: {
        type: 'object',
        properties: { clear: { type: 'boolean', description: 'true clears the shared plan' } },
      },
      run: async ({ clear = false } = {}) => {
        if (clear) {
          try { fs.rmSync(path.join(root, '.buddy', 'todo.json'), { force: true }); } catch { /* best effort */ }
          return 'PLAN cleared.';
        }
        const t = readTodoState(root);
        if (!t) return '(no todo plan saved for this workspace)';
        const lines = (t.items || []).map((it) => `- [${it.status === 'done' ? 'x' : it.status === 'in_progress' ? '~' : ' '}] #${it.id} ${it.text}${it.blocked_by?.length ? ` (after #${it.blocked_by.join(', #')})` : ''}`);
        return `PLAN (saved ${t.savedAt || 'unknown'}):\n${lines.join('\n')}`;
      },
    },
    {
      name: 'buddy_fs_write',
      description: `Create or fully rewrite a file in the workspace.${writeNote}`,
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      run: async ({ path: p, content } = {}) => {
        if (!writes) return 'ERROR: writes are disabled on this MCP server — restart `buddy mcp-serve --allow-writes` to enable';
        if (!p || typeof content !== 'string') return 'ERROR: path and content required';
        const r = scope.write(String(p), String(content));
        return `OK ${r.op} ${r.path} (${r.bytes} bytes)`;
      },
    },
    {
      name: 'buddy_apply_patch',
      description: `Replace an exact snippet in a workspace file (must match exactly once unless replace_all).${writeNote}`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, replace_all: { type: 'boolean' } },
        required: ['path', 'find', 'replace'],
      },
      run: async ({ path: p, find, replace, replace_all = false } = {}) => {
        if (!writes) return 'ERROR: writes are disabled on this MCP server — restart `buddy mcp-serve --allow-writes` to enable';
        if (!p || !find) return 'ERROR: path and find required';
        const r = scope.replace(String(p), String(find), String(replace ?? ''), { replace_all: Boolean(replace_all) });
        return `OK replaced ${r.count > 1 ? `${r.count} occurrences` : 'snippet'} in ${r.path}`;
      },
    },
  ];
  return tools;
}

/**
 * Newline-delimited JSON-RPC 2.0 stdio loop. Returns a stop() function.
 * Protocol errors (unknown method, bad params) are JSON-RPC errors; tool
 * failures are isError results — matching the MCP spec and our own client.
 */
export function startMcpServer(root, { writes = false, version = '0.15.0', stdin = process.stdin, stdout = process.stdout } = {}) {
  const tools = serverTools(root, { writes, version });
  let buffer = '';
  let stopped = false;

  const send = (obj) => {
    if (stopped) return;
    stdout.write(`${JSON.stringify(obj)}\n`);
  };

  const handle = async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const isRequest = msg.id !== undefined && msg.id !== null;
    const reply = (result, error) => {
      if (!isRequest) return; // notifications get no response
      if (error) send({ jsonrpc: '2.0', id: msg.id, error });
      else send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
    };
    switch (msg.method) {
      case 'initialize':
        reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'engineer-buddy', version },
        });
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: tools.map(({ run, ...rest }) => rest) });
        return;
      case 'tools/call': {
        const name = String(msg.params?.name || '');
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          reply(undefined, { code: -32602, message: `unknown tool: ${name}` });
          return;
        }
        try {
          const out = await tool.run(msg.params?.arguments || {});
          if (typeof out === 'string' && out.startsWith('ERROR')) reply(textResult(truncate(out, 8000), true));
          else reply(textResult(truncate(String(out ?? '(empty result)'), 16000)));
        } catch (e) {
          reply(textResult(truncate(`ERROR: ${e?.message || e}`, 8000), true));
        }
        return;
      }
      case 'notifications/initialized':
        return; // handshake acknowledgement — no response by design
      default:
        if (isRequest) reply(undefined, { code: -32601, message: `method not found: ${String(msg.method)}` });
    }
  };

  const onData = (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; } // non-JSON noise is ignored
      handle(msg).catch(() => {}); // one bad handler must not kill the loop
    }
  };
  const onClose = () => { stopped = true; };

  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.on('close', onClose);

  return {
    stop() {
      stopped = true;
      try { stdin.removeListener('data', onData); } catch { /* closing anyway */ }
    },
  };
}
