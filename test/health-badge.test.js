// The live-status line on the landing page and /agent reads /api/health: these fields have to stay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-health-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'META_API_KEY', 'OWNER_PASSCODE']) process.env[k] = '';

const { default: app } = await import('../src/server.js');

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('/api/health keeps the fields the live-status badge reads', async () => {
  const h = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(h.ok, true);
  assert.equal(typeof h.paypal, 'string'); // "sandbox" / "live", or "demo mode (no keys)"
  assert.equal(typeof h.ai, 'string'); // the model's label, or the scripted-demo label
  assert.equal(typeof h.aiReady, 'boolean');
  // No keys in tests: the badge says demo mode for both.
  assert.match(h.paypal, /^demo mode/);
  assert.equal(h.aiReady, false);
});

test('the landing page and /agent carry the live-status line', async () => {
  for (const page of ['/', '/agent']) {
    const html = await fetch(`${base}${page}`).then((r) => r.text());
    assert.ok(html.includes('id="live-status"'), `${page} has the live-status line`);
  }
});
