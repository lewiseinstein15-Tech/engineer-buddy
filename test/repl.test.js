// Tests for the interactive REPL glue that is safe to exercise headlessly.
//
// v0.8.1 regression guard: startRepl used to print the MCP status line BEFORE
// `const { mcp } = await createBuddySession(...)` was initialized — a temporal
// dead zone ReferenceError that crashed every interactive startup but slipped
// past the suite (startRepl bails at the TTY check under `node --test`).
// These tests lock the ordering down and unit-test the extracted helper.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { printMcpStatus } from '../src/terminal/repl.js';

const REPL_SRC = await readFile(new URL('../src/terminal/repl.js', import.meta.url), 'utf8');

// --- capture console.log without leaking between tests -----------------------
function captureConsole(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...args) => out.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

describe('repl: MCP banner status', () => {
  test('startRepl reads mcp only after createBuddySession returns (TDZ tripwire)', () => {
    const replStart = REPL_SRC.indexOf('export async function startRepl');
    const sessionIdx = REPL_SRC.indexOf('await createBuddySession', replStart);
    const statusIdx = REPL_SRC.indexOf('printMcpStatus(mcp);', replStart);
    assert.ok(sessionIdx !== -1, 'startRepl should create the session via createBuddySession');
    assert.ok(statusIdx !== -1, 'startRepl should print the MCP status line');
    assert.ok(
      statusIdx > sessionIdx,
      'MCP status must be printed AFTER createBuddySession — `mcp` only exists once it returns (v0.8.1 TDZ regression)'
    );
    // and no direct mcp.connected/failed access left inside startRepl's pre-session zone
    // (scoped to startRepl only — makeScopeAndTools legally owns its own local `mcp`)
    const preSession = REPL_SRC.slice(replStart, sessionIdx);
    assert.doesNotMatch(preSession, /mcp\.(connected|failed)/, 'no mcp property access before the session exists');
  });

  test('printMcpStatus: silent when nothing connected and nothing failed', () => {
    const out = captureConsole(() => printMcpStatus({ connected: [], failed: [] }));
    assert.deepEqual(out, []);
  });

  test('printMcpStatus: lists connected servers with tool counts', () => {
    const mcp = {
      connected: [
        { name: 'fetch', tools: [{ name: 'get' }, { name: 'post' }] },
        { name: 'git', tools: [{ name: 'diff' }] },
      ],
      failed: [],
    };
    const out = captureConsole(() => printMcpStatus(mcp));
    assert.equal(out.length, 1);
    assert.match(out[0], /mcp: fetch, git connected \(3 tools\)/);
    assert.match(out[0], /\/mcp for details/);
  });

  test('printMcpStatus: singular "tool" for exactly one tool', () => {
    const out = captureConsole(() =>
      printMcpStatus({ connected: [{ name: 'lone', tools: [{ name: 'only' }] }], failed: [] })
    );
    assert.match(out[0], /\(1 tool\)/);
  });

  test('printMcpStatus: warns about failed servers', () => {
    const out = captureConsole(() =>
      printMcpStatus({ connected: [], failed: [{ name: 'broken' }, { name: 'late' }] })
    );
    assert.equal(out.length, 1);
    assert.match(out[0], /mcp failed: broken, late/);
  });

  test('printMcpStatus: never throws on null/undefined/garbage input', () => {
    assert.doesNotThrow(() => captureConsole(() => printMcpStatus(null)));
    assert.doesNotThrow(() => captureConsole(() => printMcpStatus(undefined)));
    assert.doesNotThrow(() => captureConsole(() => printMcpStatus({})));
    assert.doesNotThrow(() => captureConsole(() => printMcpStatus({ connected: [{ name: 'x' }], failed: 'oops' })));
  });
});
