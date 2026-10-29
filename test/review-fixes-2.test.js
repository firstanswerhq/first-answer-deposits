// Regression tests for the second review of the review-fixes branch: customer cancel after the owner canceled,
// one visitor's /setup not taking over the demo, rate limits keyed on the real visitor, SSRF gaps, small leaks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import netMod from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-review2-${process.pid}.json`);
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
const { clientIp, fromTrustedProxy, makeRateLimiter } = await import('../src/client-ip.js');
const { isInternalIp, safeFetch, pinnedFetch } = await import('../src/safe-fetch.js');

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, { body, key, headers: extra = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (key) headers['x-owner-key'] = key;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function bookPaid(name, { presetId = 'cleaning', slot = 0 } = {}) {
  const lead = store.createLead({ presetId });
  const biz = B.businessOf(lead);
  const s = B.availableSlots(biz, { limit: slot + 1 })[slot];
  const svc = biz.services[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: svc.id, size: Object.keys(svc.sizes)[0], slotStart: s.start, customerName: name });
  B.completeDemoPayment(booking.payments[0].id);
  return store.getBooking(booking.id);
}

async function setUpBusiness(name = 'Keyed Lawn') {
  const profile = { name, trade: 'lawn care', city: 'Franklin, TN', services: [{ id: 'mow', name: 'Mowing', sizes: { standard: 60 } }], deposit: { type: 'flat', amount: 20 }, payoutEmail: 'owner@keyed.example' };
  const made = await call('POST', '/api/setup/create', { body: { profile } });
  assert.equal(made.status, 200);
  return made.data;
}

// ---------- 1. customer "cancel" never comes back as a failed send ----------
test('scripted: "cancel" after the owner canceled refunds in full; on a finished job it answers in words', async () => {
  store.resetAll();
  const b = await bookPaid('Nia');
  await B.businessCancel(b.id, 'truck broke down');
  const r = await call('POST', `/api/text/${b.leadId}`, { body: { text: 'cancel' } });
  assert.equal(r.status, 200, 'not a 500');
  assert.match(r.data.reply, /on its way back/);
  assert.equal(store.getBooking(b.id).status, 'refunded');
  assert.equal(B.totals(store.getBooking(b.id)).paid, 0);

  const c = await bookPaid('Ola', { slot: 1 });
  await B.markCompleted(c.id);
  const r2 = await call('POST', `/api/text/${c.leadId}`, { body: { text: 'I want to cancel' } });
  assert.equal(r2.status, 200, 'not a 500');
  assert.match(r2.data.reply, /can't be canceled/);
  assert.equal(store.getBooking(c.id).status, 'completed');
});

test('MCP cancel_booking on a booking the business canceled refunds it, not "reply REFUND"', async () => {
  store.resetAll();
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/cleaning`)));
  try {
    const b = await bookPaid('Mo');
    await B.businessCancel(b.id, '');
    const r = await client.callTool({ name: 'cancel_booking', arguments: { booking_id: b.id, booking_key: b.secret } });
    assert.ok(!r.isError, JSON.stringify(r.content));
    const data = r.structuredContent ?? JSON.parse(r.content[0].text);
    assert.equal(data.outcome, 'refunded_in_full');
    assert.equal(data.refunded, 50);
    assert.doesNotMatch(data.message, /reply REFUND/);
    assert.equal(store.getBooking(b.id).status, 'refunded');
  } finally {
    await client.close();
  }
});

// ---------- 2. one visitor's /setup doesn't take over the demo ----------
test('after someone opens their set-up business, the next visitor still lands on the demo business', async () => {
  store.resetAll();
  store.setPreset('cleaning');
  const { business, ownerKey } = await setUpBusiness();
  // The owner opens their owner link: the saved setting now points at their business.
  assert.equal((await call('POST', '/api/owner/preset', { body: { presetId: business.id }, key: ownerKey })).status, 200);
  assert.equal(store.getSettings().presetId, business.id);

  // /text with no ?biz= opens the demo business, not the stranger's.
  const start = await call('POST', '/api/text/start', { body: {} });
  assert.equal(start.status, 200);
  assert.equal(start.data.business, B.businessById('cleaning').name);
  assert.equal(store.getLead(start.data.leadId).presetId, 'cleaning');

  // The owner page without the key: the demo business, and its chat and "Fill sample day" work.
  const state = await call('GET', '/api/owner/state');
  assert.equal(state.data.business.id, 'cleaning');
  assert.equal((await call('POST', '/api/owner/text', { body: { text: 'who owes me?' } })).status, 200);
  const seed = await call('POST', '/api/owner/seed');
  assert.equal(seed.status, 200);
  assert.ok(store.listBookings().every((b) => b.presetId !== business.id), 'sample day went to the demo business');

  // The owner, with the key, still sees their own business.
  assert.equal((await call('GET', '/api/owner/state', { key: ownerKey })).data.business.id, business.id);
  assert.equal(store.getSettings().presetId, business.id, 'a stranger visiting does not change the saved setting');
});

// ---------- 3. rate limits key on the real visitor ----------
test('client IP: Cloudflare and internal proxies are believed; direct visitors cannot fake a header', () => {
  const req = (ip, headers = {}) => ({ ip, headers, get: (h) => headers[h.toLowerCase()] });
  // From a Cloudflare edge: cf-connecting-ip, then true-client-ip, then x-forwarded-for's first entry.
  assert.equal(clientIp(req('172.70.1.2', { 'cf-connecting-ip': '8.8.8.8', 'true-client-ip': '9.9.9.9' })), '8.8.8.8');
  assert.equal(clientIp(req('172.70.1.2', { 'true-client-ip': '9.9.9.9' })), '9.9.9.9');
  assert.equal(clientIp(req('10.0.0.5', { 'x-forwarded-for': '4.4.4.4, 172.70.1.2' })), '4.4.4.4');
  assert.equal(clientIp(req('2606:4700::1', { 'cf-connecting-ip': '2001:4860::1' })), '2001:4860::1');
  // Junk header values are ignored.
  assert.equal(clientIp(req('172.70.1.2', { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'x' })), '172.70.1.2');
  // A visitor connecting straight from the internet keeps their own address, whatever headers they send.
  assert.equal(clientIp(req('203.0.114.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })), '203.0.114.9');
  assert.ok(fromTrustedProxy('::ffff:127.0.0.1'));
  assert.ok(!fromTrustedProxy('8.8.8.8'));
});

test('rate limit: visitors behind one proxy get their own bucket; rotating fake IPs is capped', () => {
  const limit = makeRateLimiter({ backstop: 3 })(2, 60000, () => 'route');
  const run = (ip, cf) => {
    let status = 200;
    const req = { ip, headers: { 'cf-connecting-ip': cf }, get: (h) => (h === 'cf-connecting-ip' ? cf : undefined) };
    const res = { status: (s) => ((status = s), { json: () => {} }) };
    limit(req, res, () => {});
    return status;
  };
  const edge = '162.158.0.1';
  assert.deepEqual([run(edge, '8.8.8.8'), run(edge, '8.8.8.8'), run(edge, '8.8.8.8')], [200, 200, 429]);
  assert.equal(run(edge, '8.8.4.4'), 200, 'another visitor on the same edge is not blocked');
  // Rotating a new fake IP each time from one source: at most backstop x limit (3 x 2 = 6) get through.
  let passed = 0;
  for (let i = 0; i < 20; i++) if (run('10.1.1.1', `1.0.0.${i + 1}`) === 200) passed++;
  assert.equal(passed, 6);
  // A direct visitor's fake header changes nothing: limited on their own address as before.
  assert.deepEqual([run('203.0.114.9', '1.1.1.1'), run('203.0.114.9', '1.1.1.2'), run('203.0.114.9', '1.1.1.3')], [200, 200, 429]);
});

test('the HTTP routes use the visitor header (from a trusted proxy)', async () => {
  // The test server is reached over loopback, which counts as the host's own proxy.
  const lead = store.createLead({ presetId: 'cleaning' });
  let last;
  for (let i = 0; i < 41; i++) last = await call('POST', `/api/text/${lead.id}`, { body: { text: 'hi' }, headers: { 'cf-connecting-ip': '7.7.7.7' } });
  assert.equal(last.status, 429);
  const other = await call('POST', `/api/text/${lead.id}`, { body: { text: 'hi' }, headers: { 'cf-connecting-ip': '7.7.7.8' } });
  assert.equal(other.status, 200);
});

// ---------- 5. SSRF gaps ----------
test('IPv6 forms that carry an internal IPv4 address are refused; the checked address is the one fetched', async () => {
  for (const ip of ['64:ff9b::a00:1', '64:ff9b::7f00:1', '64:ff9b::808:808', '::7f00:1', '::127.0.0.1', '2002:7f00:1::1', '2002:a00:1::', '2001:0:a00:1::1', '::ffff:7f00:1', '::ffff:0:7f00:1', '::', '::1', 'fec0::1', '198.51.100.1']) {
    assert.ok(isInternalIp(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.ok(!isInternalIp(ip), ip);

  // DNS rebinding: the first answer is public, a second would be loopback. Only the first lookup counts, and the
  // fetch is told to connect to exactly that checked address.
  let lookups = 0;
  const lookup = async () => (lookups++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  const pins = [];
  const fetchImpl = async (url, opts, pin) => {
    pins.push(pin);
    return { status: 200, headers: { get: () => null } };
  };
  await safeFetch('https://rebind.example/cal.ics', {}, { lookup, fetchImpl });
  assert.equal(lookups, 1);
  assert.deepEqual(pins, [{ address: '93.184.216.34', family: 4 }]);

  // The real fetcher connects to the pinned address even for a host name that would never resolve.
  const seen = [];
  const tcp = netMod.createServer((sock) => {
    seen.push(sock.remoteAddress);
    sock.destroy();
  });
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  const port = tcp.address().port;
  await assert.rejects(pinnedFetch(`https://never-resolves.invalid:${port}/x`, {}, { address: '127.0.0.1', family: 4 }));
  tcp.close();
  assert.equal(seen.length, 1, 'connected to the pinned address, no DNS lookup');
});

// ---------- 4, 6, 7. reset flag, logo check, small leaks ----------
test('owner state: reset flag, summary scoped to the business; rebook scoped; no manage key in results; logo checked', async () => {
  store.resetAll();
  store.setPreset('cleaning');
  const st0 = await call('GET', '/api/owner/state');
  assert.equal(st0.data.resetAllowed, false, 'the page hides "Start over" when it would fail');

  const { business, ownerKey } = await setUpBusiness('Scoped Lawn');
  const mine = await bookPaid('Kim', { presetId: business.id });
  await bookPaid('Lou', { presetId: 'cleaning' });
  await bookPaid('Max', { presetId: 'cleaning', slot: 1 });
  const st = await call('GET', '/api/owner/state');
  assert.equal(st.data.summary.confirmed, 2, 'counts only the demo business it shows');
  assert.equal(st.data.summary.leads, 2);
  await call('POST', '/api/owner/preset', { body: { presetId: business.id }, key: ownerKey });
  const own = await call('GET', '/api/owner/state', { key: ownerKey });
  assert.equal(own.data.summary.confirmed, 1);

  // A paid-in-full job at the set-up business is not nudged from the demo owner page.
  await B.markCompleted(mine.id);
  B.completeDemoPayment(store.getBooking(mine.id).payments.find((p) => p.status === 'pending').id);
  assert.equal(store.getBooking(mine.id).status, 'paid_in_full');
  const rb = await call('POST', '/api/owner/rebook');
  assert.equal(rb.status, 200);
  assert.ok(!store.getBooking(mine.id).rebookNudgedAt, 'not another business');
  const rb2 = await call('POST', '/api/owner/rebook', { key: ownerKey });
  assert.deepEqual(rb2.data.result.nudged, ['Kim']);

  // Owner actions never send the booking's manage key back.
  const lou = store.listBookings().find((b) => b.customerName === 'Lou');
  const done = await call('POST', `/api/owner/bookings/${lou.id}/done`, { body: {} });
  assert.equal(done.status, 200);
  assert.ok(!JSON.stringify(done.data).includes(lou.secret));
  const cancel = await call('POST', `/api/owner/bookings/${store.listBookings().find((b) => b.customerName === 'Max').id}/cancel`, { body: {} });
  assert.equal(cancel.status, 200);
  assert.ok(!JSON.stringify(cancel.data).includes('"secret"'));

  // The logo link from the owner page gets the same check as setup.
  for (const bad of ['javascript:alert(1)', 'https://x.example/a.png" onerror="alert(1)', 'https://x.example/<b>.png', 'data:image/png;base64,AAA']) {
    assert.equal((await call('POST', '/api/owner/connections', { key: ownerKey, body: { logoUrl: bad } })).status, 200);
    assert.equal(store.getBusiness(business.id).brand.logoUrl, '', bad);
  }
  await call('POST', '/api/owner/connections', { key: ownerKey, body: { logoUrl: 'https://x.example/logo.png' } });
  assert.equal(store.getBusiness(business.id).brand.logoUrl, 'https://x.example/logo.png');
});

// ---------- 8. webhook capture uses the captured order's tip ----------
test('PAYMENT.CAPTURE.COMPLETED records the tip, so the payout includes it when the webhook comes first', async () => {
  store.resetAll();
  const b = await bookPaid('Tia');
  await B.markCompleted(b.id);
  const bal = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  store.updatePayment(bal.id, { mode: 'paypal', orderId: 'ORDER-2', orders: [{ id: 'ORDER-1', tip: 0 }, { id: 'ORDER-2', tip: 25 }] });
  await B.handlePayPalEvent({
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAP-1', custom_id: `${b.id}:${bal.id}`, amount: { value: String(bal.amount + 25) }, supplementary_data: { related_ids: { order_id: 'ORDER-2' } } },
  });
  const after = store.getBooking(b.id);
  assert.equal(after.payments.find((p) => p.id === bal.id).tip, 25);
  assert.equal(after.status, 'paid_in_full');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getBooking(b.id).payout.amount, 50 + bal.amount + 25);
  // Without a known order, the tip is what was captured above the amount owed.
  assert.equal(B.capturedTip({ amount: 100, orders: [] }, { amount: { value: '112.50' } }), 12.5);
  assert.equal(B.capturedTip({ amount: 100 }, { amount: { value: '100.00' } }), null);
});
