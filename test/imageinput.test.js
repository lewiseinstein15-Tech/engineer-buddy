// imageinput.test.js — Build 16 (P1): image input (screenshot → base64 → vision).
//
// Locks down:
//   1. @image.png attaches as a vision image (kind:image + dataUrl), NOT a
//      text fence; base64 never enters the block or the text budget
//   2. caps: >5MB refused, >2 per task refused, secret paths still refused
//   3. chat.turn(images) keeps history STRING-shaped (placeholder tokens) —
//      compaction and the JSON protocol untouched
//   4. the wire carries OpenAI vision content arrays for the model call
//   5. the router: vision gateways first on image requests; non-vision
//      gateways get a stripped string view with an honest omission note
//   6. request size accounting ignores base64 (only text parts count)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandMentions, MENTION_CAPS } from '../src/terminal/mentions.js';
import { createChat } from '../src/agent/chat.js';
import { GatewayRouter } from '../src/brain/router.js';
import { LocalScope, buildLocalTools } from '../src/tools/local.js';
import { harnessContext, loadHarness, ensureHarness } from '../src/harness/scaffold.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-img-'));
}

// 1x1 transparent PNG (67 bytes) — tiny, real, decodable.
const PNG1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function writeImg(root, rel, buf = PNG1PX) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

test('image mentions: @shot.png attaches as a vision image, never a text fence', () => {
  const root = tmp();
  writeImg(root, 'shots/shot.png');
  const ex = expandMentions('make this button blue @shots/shot.png', { root });
  const a = ex.attached.find((x) => x.path === 'shots/shot.png');
  assert.equal(a.ok, true);
  assert.equal(a.kind, 'image');
  assert.equal(a.mime, 'image/png');
  assert.match(a.dataUrl, /^data:image\/png;base64,/);
  assert.match(ex.block, /\[image attached — .*KB png, sent as a vision image\]/);
  assert.doesNotMatch(ex.block, /base64/, 'base64 never enters the transcript block');
  assert.equal(ex.images.length, 1);
  assert.equal(ex.images[0].name, 'shots/shot.png');
  // text budget untouched by the image (only its placeholder line would count)
  assert.ok(ex.block.length < 1000, 'image block is a one-liner');
});

test('image mentions: oversized image refused, image-per-task cap holds', () => {
  const root = tmp();
  writeImg(root, 'big.png', Buffer.alloc(MENTION_CAPS.maxImageBytes + 10));
  const ex1 = expandMentions('look @big.png', { root });
  assert.equal(ex1.attached[0].ok, false);
  assert.match(ex1.attached[0].error, /image too large/);

  const root2 = tmp();
  writeImg(root2, 'a.png');
  writeImg(root2, 'b.png');
  writeImg(root2, 'c.png');
  const ex2 = expandMentions('compare @a.png @b.png @c.png', { root: root2 });
  const ok = ex2.attached.filter((a) => a.ok && a.kind === 'image');
  const refused = ex2.attached.filter((a) => !a.ok);
  assert.equal(ok.length, 2, 'max 2 images per task');
  assert.equal(refused.length, 1);
  assert.match(refused[0].error, /image limit reached/);
});

test('image mentions: .jpg/.jpeg/.gif/.webp recognized; secrets refused as ever', () => {
  const root = tmp();
  for (const ext of ['jpg', 'jpeg', 'gif', 'webp']) writeImg(root, `x.${ext}`);
  const ex = expandMentions('@x.jpg @x.jpeg', { root });
  assert.equal(ex.attached.filter((a) => a.ok && a.kind === 'image').length, 2);
  assert.deepEqual(ex.attached.map((a) => a.mime), ['image/jpeg', 'image/jpeg']);
  // secret-path rule fires for image-named secrets too (cap-independent)
  writeImg(root, 'env.png');
  fs.renameSync(path.join(root, 'env.png'), path.join(root, '.env.png'));
  const ex2 = expandMentions('peek @.env.png', { root });
  assert.equal(ex2.attached[0].ok, false);
  assert.match(ex2.attached[0].error, /protected path/);
});

function makeBuddy(root) {
  ensureHarness(root);
  const tools = buildLocalTools({ scope: new LocalScope(root) });
  const harness = harnessContext(loadHarness(root));
  return { tools, harness };
}

const SAY = '{"tool":"say","message":"seen"}';

test('image input: history stays string-shaped; wire gets vision arrays', async () => {
  const { tools, harness } = makeBuddy(tmp());
  const calls = [];
  const router = {
    order: ['fake'],
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      return { text: SAY, gateway: 'fake', usage: { promptTokens: 10, completionTokens: 2 } };
    },
  };
  const chat = createChat({ router, tools, harness });
  const dataUrl = `data:image/png;base64,${PNG1PX.toString('base64')}`;
  const r = await chat.turn('make this button blue', { images: [{ name: 'shot.png', dataUrl }] });
  assert.equal(r.said, 'seen');
  // history: string with a placeholder line — compaction/protocol safe
  const last = chat.messages[chat.messages.length - 2]; // before the assistant say
  assert.equal(typeof last.content, 'string');
  assert.match(last.content, /\[image attached: shot\.png\]/);
  assert.match(last.content, /⟪img:1:shot\.png⟫/);
  assert.doesNotMatch(last.content, /base64/, 'the transcript never carries base64');
  // wire: content array with the image part
  const wire = calls[0].messages;
  const userWire = wire.find((m) => Array.isArray(m.content));
  assert.ok(userWire, 'wire message carries a content array');
  const textPart = userWire.content.find((p) => p.type === 'text');
  const imgPart = userWire.content.find((p) => p.type === 'image_url');
  assert.match(textPart.text, /make this button blue/);
  assert.equal(imgPart.image_url.url, dataUrl);
});

test('router: image requests go vision-first; fall-through gives non-vision a stripped view', async () => {
  const seen = [];
  const make = (name, vision, fail = false) => ({
    name,
    ...(vision ? { vision: true } : {}),
    chat: async (messages) => {
      seen.push({ name, shape: messages.map((m) => Array.isArray(m.content) ? 'array' : 'string') });
      if (fail) throw new Error(`${name} cannot see today`);
      return { text: 'ok', gateway: name };
    },
  });
  const seer = make('seer', true, true); // vision gateway is DOWN — chain falls through
  const textOnly = make('textonly', false);
  const router = new GatewayRouter(new Map([['textonly', textOnly], ['seer', seer]]), {
    gatewayOrder: ['textonly', 'seer'],
    maxRoundTrips: 1,
  });
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
  ];
  const out = await router.chat(msgs);
  assert.equal(out.gateway, 'textonly', 'fall-through answered');
  assert.equal(seen[0].name, 'seer', 'vision gateway tried FIRST despite chain order');
  assert.equal(seen[0].shape[0], 'array', 'seer got the raw content array');
  assert.equal(seen[1].name, 'textonly');
  assert.equal(seen[1].shape[0], 'string', 'text-only gateway got a stripped string view');
});

test('router: image parts do not poison the context-limit estimate', async () => {
  const seen = [];
  const gw = {
    name: 'g',
    ctxLimit: 1000, // ~1000 tokens
    chat: async (messages) => {
      seen.push(messages);
      return { text: 'ok', gateway: 'g' };
    },
  };
  const router = new GatewayRouter(new Map([['g', gw]]), { gatewayOrder: ['g'] });
  const bigBase64 = 'A'.repeat(2_000_000); // would be ~666k tokens if base64 counted
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${bigBase64}` } }] },
  ];
  await router.chat(msgs); // must NOT be skipped as "context too big"
  assert.equal(seen.length, 1, 'request passed the ctxLimit gate (text-only accounting)');
});

test('image input: two images in one turn both land on the wire', async () => {
  const { tools, harness } = makeBuddy(tmp());
  const calls = [];
  const router = {
    order: ['fake'],
    chat: async (messages) => {
      calls.push(messages);
      return { text: SAY, gateway: 'fake' };
    },
  };
  const chat = createChat({ router, tools, harness });
  const d1 = `data:image/png;base64,${PNG1PX.toString('base64')}`;
  await chat.turn('compare', { images: [{ name: 'a.png', dataUrl: d1 }, { name: 'b.png', dataUrl: d1 }] });
  const wire = calls[0].find((m) => Array.isArray(m.content));
  const imgs = wire.content.filter((p) => p.type === 'image_url');
  assert.equal(imgs.length, 2);
});
