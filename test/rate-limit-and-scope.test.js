// Rate limits and scope: the shared rate-limit backstop, the owner page's business per request, paying for a
// canceled booking, webhook Content-Length, and tips on deposits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-review3-${process.pid}.json`);
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
const { default: app } = await import('../src/server.js');
const { makeRateLimiter } = await import('../src/client-ip.js');
const { pinnedFetch } = await import('../src/safe-fetch.js');

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, { body, key, biz, headers: extra = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (key) headers['x-owner-key'] = key;
  if (biz) headers['x-biz'] = biz;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function book(name, { presetId = 'cleaning', slot = 0 } = {}) {
  const lead = store.createLead({ presetId });
  const biz = B.businessOf(lead);
  const s = B.availableSlots(biz, { limit: slot + 1 })[slot];
  const svc = biz.services[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: svc.id, size: Object.keys(svc.sizes)[0], slotStart: s.start, customerName: name });
  return store.getBooking(booking.id);
}

// ---------- 1. one visitor can't use up the backstop everyone behind the same proxy shares ----------
test('rate limit: a visitor hammering a route is refused without charging the shared backstop', () => {
  // A small backstop makes the point: 2 per visitor, 3 x 2 = 6 for the whole connecting address.
  const limit = makeRateLimiter({ backstop: 3 })(2, 60000, () => 'route');
  const run = (cf) => {
    let status = 200;
    const req = { ip: '162.158.0.1', headers: { 'cf-connecting-ip': cf }, get: (h) => (h === 'cf-connecting-ip' ? cf : undefined) };
    const res = { status: (s) => ((status = s), { json: () => {} }) };
    limit(req, res, () => {});
    return status;
  };
  let refused = 0;
  for (let i = 0; i < 300; i++) if (run('8.8.8.8') === 429) refused++;
  assert.equal(refused, 298, 'the spammer gets their own 2, then 429s');
  assert.equal(run('9.9.9.9'), 200, 'a different visitor through the same address is not locked out');
  assert.equal(run('9.9.9.9'), 200);
});

test('rate limit over HTTP: 300 requests from one visitor never cause a 429 for another on the same connection', async () => {
  const b = await book('Spam Target');
  const pay = b.payments[0].id;
  let spam429 = 0;
  for (let i = 0; i < 300; i++) {
    const r = await call('POST', `/api/pay/${pay}/order`, { body: {}, headers: { 'cf-connecting-ip': '7.7.7.1' } });
    if (r.status === 429) spam429++;
  }
  assert.ok(spam429 >= 260, 'the spammer is limited');
  const other = await call('POST', `/api/pay/${pay}/order`, { body: {}, headers: { 'cf-connecting-ip': '7.7.7.2' } });
  assert.notEqual(other.status, 429, 'another judge behind the same proxy still gets through');
});

// ---------- 2. the owner page's business is per request, never a global setting ----------
test('picking a business on one owner page does not change anyone else\'s page; bare /mcp and discovery use the default', async () => {
  store.resetAll();
  // One judge picks HVAC: their page sends x-biz on every request.
  const hvac = await call('GET', '/api/owner/state', { biz: 'hvac' });
  assert.equal(hvac.data.business.id, 'hvac');
  assert.equal((await call('POST', '/api/owner/preset', { body: { presetId: 'hvac' } })).status, 200);
  assert.equal(store.getSettings().presetId, 'cleaning', 'the dropdown never writes the shared setting');
  // Another judge's page, naming nothing or its own business, is unaffected.
  assert.equal((await call('GET', '/api/owner/state')).data.business.id, 'cleaning');
  assert.equal((await call('GET', '/api/owner/state', { biz: 'detailing' })).data.business.id, 'detailing');
  // ?biz= works too (the owner link from setup), and the seed goes to the business the page names.
  assert.equal((await call('GET', '/api/owner/connections?biz=hvac')).data.business.id, 'hvac');
  assert.equal((await call('POST', '/api/owner/seed', { biz: 'hvac' })).status, 200);
  assert.ok(store.listBookings().length > 0 && store.listBookings().every((b) => b.presetId === 'hvac'));

  // The owner link of a set-up business still opens that business, and only with its key.
  const profile = { name: 'Per Request Lawn', trade: 'lawn care', city: 'Franklin, TN', services: [{ id: 'mow', name: 'Mowing', sizes: { standard: 60 } }], deposit: { type: 'flat', amount: 20 } };
  const made = await call('POST', '/api/setup/create', { body: { profile } });
  const { business, ownerKey } = made.data;
  assert.equal((await call('GET', `/api/owner/state?biz=${business.id}&key=${ownerKey}`)).data.business.id, business.id);
  assert.equal((await call('GET', '/api/owner/state', { biz: business.id, key: ownerKey })).data.business.id, business.id);
  assert.equal((await call('GET', '/api/owner/state', { biz: business.id })).data.business.id, 'cleaning', 'no key: the demo business');

  // Even if an old saved setting points elsewhere, bare /mcp and the discovery files use the default business.
  store.setPreset('hvac');
  try {
    const llms = await (await fetch(`${base}/llms.txt`)).text();
    assert.ok(llms.includes(B.businessById('cleaning').name) && !llms.startsWith(`# ${B.businessById('hvac').name}`));
    const card = await call('GET', '/.well-known/agent-card.json');
    assert.match(card.data.name, new RegExp(B.businessById('cleaning').name));
    const client = new Client({ name: 'test-assistant', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const r = await client.callTool({ name: 'get_business_info', arguments: {} });
      const info = r.structuredContent ?? JSON.parse(r.content[0].text);
      assert.equal(info.name, B.businessById('cleaning').name);
    } finally {
      await client.close();
    }
  } finally {
    store.setPreset('cleaning');
  }
});

// ---------- 3. a canceled booking's deposit can't be paid ----------
test('customer cancels before paying: the deposit link is turned off and checkout and capture refuse it', async () => {
  store.resetAll();
  const b = await book('Cal');
  const pay = b.payments[0].id;
  const r = await B.customerCancel(b.id, { notify: false });
  assert.equal(r.outcome, 'released');
  assert.equal(store.findPayment(pay).payment.status, 'void', 'the link is voided like releaseHold does');

  const order = await call('POST', `/api/pay/${pay}/order`, { body: {} });
  assert.equal(order.status, 400);
  assert.match(order.data.error, /canceled/i);
  const cap = await call('POST', `/api/pay/${pay}/capture`, { body: {} });
  assert.equal(cap.status, 400);
  assert.match(cap.data.error, /canceled/i);
  const after = store.getBooking(b.id);
  assert.equal(after.status, 'canceled');
  assert.equal(B.totals(after).paid, 0, 'no money taken');

  // Even a link still marked pending on a closed booking is refused (older data, refunded bookings).
  const c = await book('Dee', { slot: 1 });
  store.updateBooking(c.id, { status: 'refunded' });
  const co = await B.checkoutFor(c.payments[0].id);
  assert.match(co.error, /refunded/i);
  assert.equal((await call('POST', `/api/pay/${c.payments[0].id}/capture`, { body: {} })).status, 400);
  assert.equal(store.findPayment(c.payments[0].id).payment.status, 'pending');
});

// ---------- 6. tips only on the final bill ----------
test('a deposit link takes no tip; the final bill does', async () => {
  store.resetAll();
  const b = await book('Tess');
  const dep = b.payments[0].id;
  const r = await call('POST', `/api/pay/${dep}/capture`, { body: { tip: 500 } });
  assert.equal(r.status, 200);
  assert.equal(store.findPayment(dep).payment.tip || 0, 0, 'no tip on a deposit');
  await B.markCompleted(b.id);
  const bal = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  await call('POST', `/api/pay/${bal.id}/capture`, { body: { tip: 20 } });
  assert.equal(store.findPayment(bal.id).payment.tip, 20);
  assert.equal(store.getBooking(b.id).status, 'paid_in_full');
});

// ---------- 5. webhook POSTs carry Content-Length, not chunked ----------
test('pinnedFetch sends a body with Content-Length', async () => {
  // Catch the headers the request is built with, then stop before any connection is made.
  const https = (await import('node:https')).default;
  const orig = https.request;
  let headers;
  https.request = (url, opts, cb) => {
    headers = opts.headers;
    return orig.call(https, url, { ...opts, lookup: (h, o, c) => c(new Error('stop')) }, cb);
  };
  try {
    await pinnedFetch('https://hook.example/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":"é"}' }, { address: '127.0.0.1', family: 4 }).catch(() => {});
  } finally {
    https.request = orig;
  }
  assert.equal(headers['Content-Length'], Buffer.byteLength('{"a":"é"}'));
  assert.equal(headers['Content-Type'], 'application/json');
});
