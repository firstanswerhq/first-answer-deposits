// Fixes from the mock judge's report: the one-tap demo on a shared server, the scripted bots, owner money
// confirmations, the sample day, and honest labels. Demo mode (no PayPal or AI keys).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-judge-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.META_API_KEY = '';
process.env.OWNER_PASSCODE = '';
delete process.env.ALLOW_RESET;

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { scriptedCustomerReply, scriptedOwnerReply } = await import('../src/agent/scripted.js');
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

async function call(method, url, { body, biz, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (biz) h['x-biz'] = biz;
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const assistant = (body) => call('POST', '/api/assistant', { body }).then((r) => r.data);
const HEADLINE = "Book a deep clean for my 3-bedroom this Friday morning, keep it under $300. I'm Sarah.";

// ---------- 1. the headline one-tap demo works for every visitor ----------
test('the headline chip still gets an approval card after other visitors took Friday morning', async () => {
  store.resetAll();
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(await assistant({ sessionId: `visitor-${i}`, bizId: 'cleaning', text: HEADLINE }));
  for (const [i, r] of runs.entries()) {
    assert.ok(r.approval, `run ${i + 1} shows the approval card (${r.reply})`);
    assert.equal(r.approval.amount, 50);
    assert.doesNotMatch(r.reply, /Which one\?/);
  }
  assert.match(runs[0].reply, /^Done\. I held/);
  assert.match(runs[1].reply, /Friday in the morning was taken, so I held the closest open time instead/);
  const starts = runs.map((r) => store.getBooking(r.approval.bookingId).slotStart);
  assert.equal(new Set(starts).size, 4, 'four different times');
  // The second run stays on Friday (the nearest open time that day).
  assert.match(store.getBooking(runs[1].approval.bookingId).slotLabel, /^Fri/);
});
