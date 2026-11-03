// control.js — the private control endpoint (v0.68.0, wave 1).
//
// Hermes mechanism (control_socket.py): a private socket under the state
// directory plus a pointer file, serving identify/status/pause/stop — the
// operator's handle on a background process that owns no terminal. Buddy's
// version is newline-delimited JSON both ways over a unix socket (Windows:
// a named pipe, day one, not a port — the serve plane never listens on TCP).
//
// The pointer file (.buddy/serve/control.json) is written by the daemon
// AFTER it listens and removed on the way out; a stale pointer with no live
// listener degrades to an honest "unreachable", never a hang.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { controlPath, atomicWrite, readJson } from './paths.js';

const slug = (root) => createHash('sha1').update(path.resolve(String(root ?? '.'))).digest('hex').slice(0, 12);

/** The endpoint this root's daemon listens on. */
export function controlEndpoint(root) {
  if (process.platform === 'win32') {
    return { transport: 'pipe', path: `\\\\.\\pipe\\buddy-serve-${slug(root)}` };
  }
  return { transport: 'unix', path: path.join(String(root ?? '.'), '.buddy', 'serve', `control-${slug(root)}.sock`) };
}

/** The daemon side: bind + serve newline-JSON requests through `handler`.
 *  Returns the server once listening. A stale socket file from a dead
 *  daemon is removed and the bind retried once — an EADDRINUSE on a LIVE
 *  endpoint is an honest error (the lease should have stopped us first). */
export function createControlServer(root, handler) {
  const ep = controlEndpoint(root);
  const listenOnce = () => new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let req = null;
          try { req = JSON.parse(line); } catch { req = { cmd: '(torn)' }; }
          Promise.resolve()
            .then(() => handler(req))
            .then((resp) => {
              socket.write(JSON.stringify(resp ?? { ok: true }) + '\n');
              if (req && req.cmd === 'stop') socket.end();
            })
            .catch((e) => {
              try { socket.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + '\n'); } catch { /* client gone */ }
            });
        }
      });
      socket.on('error', () => { /* a dropped control client never takes the daemon down */ });
    });
    server.once('error', reject);
    server.listen(ep.path, () => resolve(server));
  });
  return (async () => {
    try {
      return await listenOnce();
    } catch (e) {
      if (e && (e.code === 'EADDRINUSE' || e.code === 'EEXIST') && ep.transport === 'unix') {
        try { fs.unlinkSync(ep.path); } catch { /* nothing to clear */ }
        return listenOnce();
      }
      throw e;
    }
  })();
}

/** Write the pointer file (daemon, after listen) / remove it (on exit). */
export function writePointer(root, bootId) {
  const ep = controlEndpoint(root);
  atomicWrite(controlPath(root), JSON.stringify({ ...ep, pid: process.pid, bootId, at: new Date().toISOString() }, null, 2) + '\n');
}
export function clearPointer(root) {
  try { fs.unlinkSync(controlPath(root)); } catch { /* already gone */ }
}

/** The operator side: one request, one response, bounded. Never throws —
 *  an unreachable daemon is an honest {ok:false, unreachable:true}. */
export function controlRequest(root, cmd, { timeoutMs = 3000, extra = {} } = {}) {
  return new Promise((resolve) => {
    const pointer = readJson(controlPath(root));
    const ep = pointer && pointer.path ? { transport: pointer.transport, path: pointer.path } : controlEndpoint(root);
    const socket = net.connect(ep.path);
    let buf = '';
    const done = (r) => { try { socket.destroy(); } catch { /* already down */ } resolve(r); };
    const timer = setTimeout(() => done({ ok: false, unreachable: true, error: `the control endpoint did not answer within ${timeoutMs}ms` }), timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({ cmd, ...extra }) + '\n'));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      try { done(JSON.parse(buf.slice(0, idx))); } catch { done({ ok: false, error: 'torn control response' }); }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, unreachable: true, error: `no daemon reachable at ${ep.path} — ${e.code || e.message}` });
    });
  });
}
