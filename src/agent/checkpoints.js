// checkpoints.js — automatic snapshots of every file the agent is about to
// touch (Claude Code's checkpoints, Buddy edition).
//
// Why: kilo's v0.9.6 live test ended with a half-applied fs_replace that left
// src/tools/local.js broken and the brain offline before it could recover.
// Every mutating tool now snapshots its target BEFORE the edit lands, into a
// content-addressed store under .buddy/checkpoints/ — /rewind restores files.
//
// Layout:
//   .buddy/checkpoints/objects/<sha256>   raw file contents (deduped by hash)
//   .buddy/checkpoints/<ts>-<tool>.json   manifest: {time, tool, files:[{path, hash, bytes, existed}]}
//
// Safety properties:
//   - .buddy/** is never snapshotted (no self-amplification loops)
//   - files > 2 MB are skipped (documented limitation)
//   - bash edits are NOT captured — only fs_write/fs_replace/fs_append funnel
//     through LocalScope.write/replace/append, which call snapshotPaths
//   - retention keeps the newest 50 manifests and prunes orphan objects
//   - restore refuses traversal paths (defense against hand-edited manifests)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MANIFESTS = 50;

// Monotonic per-process sequence — manifests created in the same millisecond
// must sort by creation order, not alphabetically (a same-ms fs_write →
// fs_append → fs_replace burst sorted w-r-a without this).
let seq = 0;

function ckptDir(root) {
  return path.join(root, '.buddy', 'checkpoints');
}
function objectsDir(root) {
  return path.join(ckptDir(root), 'objects');
}
function ensureDirs(root) {
  fs.mkdirSync(objectsDir(root), { recursive: true });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeRel(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/** True when a repo-relative path is safe to snapshot/restore. */
function safeRel(rel) {
  return Boolean(rel) && !rel.startsWith('/') && !rel.split('/').includes('..') && rel !== '.buddy' && !rel.startsWith('.buddy/');
}

/**
 * Snapshot the given repo-relative paths (call BEFORE a mutation). Returns
 * the manifest filename, or null when nothing was snapshotted. Individual
 * file problems never throw — bad paths are skipped; a missing file is
 * recorded with existed:false so a restore removes whatever the agent went
 * on to create there.
 */
export function snapshotPaths(root, relPaths, { tool = 'tool' } = {}) {
  const seen = new Set();
  const entries = [];
  for (const raw of relPaths || []) {
    const rel = normalizeRel(raw);
    if (!safeRel(rel) || seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(root, rel);
    let buf;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch {
      entries.push({ path: rel, hash: null, bytes: 0, existed: false });
      continue;
    }
    const hash = sha256(buf);
    const obj = path.join(objectsDir(root), hash);
    if (!fs.existsSync(obj)) {
      ensureDirs(root);
      fs.writeFileSync(obj, buf);
    }
    entries.push({ path: rel, hash, bytes: buf.length, existed: true });
  }
  if (!entries.length) return null;
  ensureDirs(root);
  const time = new Date().toISOString();
  seq += 1;
  const base = `${time.replace(/[:.]/g, '-')}-${String(seq).padStart(3, '0')}-${tool}`;
  let file = path.join(ckptDir(root), `${base}.json`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(ckptDir(root), `${base}-${n}.json`);
  fs.writeFileSync(file, JSON.stringify({ time, tool, files: entries }, null, 2));
  pruneCheckpoints(root);
  return path.basename(file);
}

/**
 * Restore every file in a checkpoint manifest to its pre-mutation state:
 * existed:true → copy the object blob back; existed:false → remove the file
 * (the agent created it in that step). Never throws — per-file problems land
 * in `lost`. Returns {restored, removed, lost}.
 */
export function restoreCheckpoint(root, manifestFile) {
  const out = { restored: [], removed: [], lost: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ckptDir(root), path.basename(manifestFile)), 'utf8'));
  } catch {
    out.lost.push('(manifest unreadable)');
    return out;
  }
  for (const f of manifest.files || []) {
    const rel = normalizeRel(f.path);
    if (!safeRel(rel)) {
      out.lost.push(f.path);
      continue;
    }
    const abs = path.join(root, rel);
    if (!f.existed || !f.hash) {
      try {
        fs.rmSync(abs, { force: true });
        out.removed.push(rel);
      } catch {
        out.lost.push(rel);
      }
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(path.join(objectsDir(root), f.hash));
    } catch {
      out.lost.push(rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      out.restored.push(rel);
    } catch {
      out.lost.push(rel);
    }
  }
  return out;
}

/** Newest-first checkpoint list (newest = index 0 → "/rewind 1"). */
export function listCheckpoints(root, n = 10) {
  let files = [];
  try {
    files = fs.readdirSync(ckptDir(root)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (out.length >= n) break;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ckptDir(root), f), 'utf8'));
      out.push({ file: f, time: m.time || '', tool: m.tool || '?', files: m.files || [] });
    } catch {
      /* skip broken manifests */
    }
  }
  return out;
}

/** Keep the newest MAX_MANIFESTS manifests; delete objects none of them reference. */
export function pruneCheckpoints(root) {
  let files = [];
  try {
    files = fs.readdirSync(ckptDir(root)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return;
  }
  const cut = Math.max(0, files.length - MAX_MANIFESTS);
  const drop = files.slice(0, cut);
  const keep = files.slice(cut);
  for (const f of drop) {
    try {
      fs.rmSync(path.join(ckptDir(root), f), { force: true });
    } catch {
      /* best effort */
    }
  }
  const referenced = new Set();
  for (const f of keep) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ckptDir(root), f), 'utf8'));
      for (const e of m.files || []) if (e.hash) referenced.add(e.hash);
    } catch {
      /* skip broken manifests */
    }
  }
  let objs = [];
  try {
    objs = fs.readdirSync(objectsDir(root));
  } catch {
    return;
  }
  for (const o of objs) {
    if (!referenced.has(o)) {
      try {
        fs.rmSync(path.join(objectsDir(root), o), { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
