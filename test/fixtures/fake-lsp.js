// fake-lsp.js — a minimal language-server speaking LSP Content-Length
// framing, for tests. Answers initialize and nothing else (extra requests
// time out, which is exactly what the suite expects from a hostile server).
//
// This file lives under test/ so `node --test` scans it — bail out when that
// happens (it is a spawned fixture, never a test).
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd);
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) return;
    const len = Number(m[1]);
    if (buffer.length < headerEnd + 4 + len) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len);
    buffer = buffer.slice(headerEnd + 4 + len);
    try {
      const msg = JSON.parse(body);
      if (msg.method === 'initialize') {
        const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
        const b = Buffer.from(resp, 'utf8');
        process.stdout.write(`Content-Length: ${b.length}\r\n\r\n${resp}`);
      }
      // anything else: deliberately unanswered
    } catch { /* noise */ }
  }
});
// Keep alive until killed.
setInterval(() => {}, 10_000);
