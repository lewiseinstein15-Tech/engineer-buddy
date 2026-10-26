// userruntime.js — the child-process half of user-defined tool sandboxing.
//
// Usage: node userruntime.js <index.js> <json-args> <root>
// Prints EXACTLY one JSON envelope on stdout: {"ok":true,"result":"..."} or
// {"ok":false,"error":"..."}. The tool author's console.log is redirected to
// stderr so their debugging output can never corrupt the result channel.
// Exit code is always 0 — errors travel inside the envelope.

const [, , toolPath, argsJson, root] = process.argv;

// Keep stdout clean: everything the author logs goes to stderr.
console.log = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
console.info = console.log;
console.warn = console.log;

function emit(envelope) {
  // Wait for the pipe to flush before exiting — process.exit() right after
  // write() truncates piped stdout (the parent would read an empty envelope).
  process.stdout.write(`${JSON.stringify(envelope)}\n`, () => process.exit(0));
}

(async () => {
  try {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(toolPath).href);
    if (typeof mod.run !== 'function') {
      emit({ ok: false, error: 'index.js must export `export async function run(args, ctx)`' });
      return;
    }
    let args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }
    let result;
    try {
      result = await mod.run(args, { root: root || process.cwd(), cwd: process.cwd() });
    } catch (e) {
      emit({ ok: false, error: (e && e.stack) || String(e) });
      return; // emit schedules exit via the flush callback — never fall through
    }
    emit({ ok: true, result: result == null ? '' : typeof result === 'string' ? result : JSON.stringify(result) });
  } catch (e) {
    emit({ ok: false, error: (e && e.stack) || String(e) });
  }
})();
