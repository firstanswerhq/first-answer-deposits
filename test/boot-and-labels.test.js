// Boot and honest labels (demo mode, no PayPal or AI keys): the sample day loads itself on an empty store, bad JSON
// and thrown errors come back as plain JSON, simulated holds and payouts say "(demo)", a refund after a payout
// records what the owner owes back, setup takes a time zone and https-only logo links, and the demo assistant
// calls MCP over loopback while the trace keeps the public address.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-boot-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'META_API_KEY', 'OWNER_PASSCODE']) process.env[k] = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const S = await import('../src/setup.js');
const { seedIfEmpty, hasSampleDay } = await import('../src/seed.js');
const { localDate } = await import('../src/slots.js');
const { presets, defaultPresetId } = await import('../src/business.js');
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

async function call(method, url, { body, raw, biz, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (biz) h['x-biz'] = biz;
  const res = await fetch(base + url, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, data: await res.json().catch(() => ({})), text: '' };
}

test('an empty data store gets the sample day on boot; a store with any booking is left alone', async () => {
  store.resetAll();
  const biz = presets[defaultPresetId];
  assert.equal(store.listBookings().length, 0);
  const first = await seedIfEmpty(biz);
  assert.equal(first.bookings, 3);
  assert.ok(hasSampleDay(biz));
  assert.deepEqual(store.listBookings().map((b) => b.customerName).sort(), ['Marcus Lee', 'Priya Natarajan', 'Sarah Kim']);
  // The sample day never takes tomorrow: the first chip ("tomorrow morning") gets the morning on a fresh boot.
  const tomorrow = localDate(new Date(Date.now() + 86400000), biz.timezone);
  assert.ok(store.listBookings().every((b) => localDate(new Date(b.slotStart), biz.timezone) !== tomorrow), 'sample bookings stay off tomorrow');
  if (biz.openDays.includes(new Date(`${tomorrow}T12:00:00Z`).getUTCDay())) {
    const morning = B.availableSlots(biz, { limit: 6, days: 2 }).find((s) => localDate(new Date(s.start), biz.timezone) === tomorrow);
    assert.ok(morning && /9:00 AM/.test(morning.label), `tomorrow 9:00 AM is still open: ${morning?.label}`);
  }
  // Not empty any more: nothing is added, and the button's own guard still answers "already".
  assert.deepEqual(await seedIfEmpty(biz), { bookings: 0, already: true });
  assert.equal(store.listBookings().length, 3);
  // A store with a real booking and no sample day is never seeded on its own.
  store.resetAll();
  const lead = store.createLead({ presetId: biz.id });
  const slot = B.availableSlots(biz, { limit: 1 })[0];
  await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: biz.services[0].id, size: Object.keys(biz.services[0].sizes)[0], slotStart: slot.start, customerName: 'Real Customer' });
  assert.deepEqual(await seedIfEmpty(biz), { bookings: 0, already: true });
  assert.equal(store.listBookings().length, 1);
});

test('malformed JSON is a 400 with {error}, never a stack trace', async () => {
  for (const url of ['/api/text/start', '/api/assistant', '/api/owner/text', '/mcp/cleaning']) {
    const r = await call('POST', url, { raw: '{"not": json' });
    assert.equal(r.status, 400, url);
    assert.deepEqual(Object.keys(r.data), ['error'], url);
    assert.doesNotMatch(r.data.error, /at .*\.js|SyntaxError/, url);
  }
});

test('demo mode: the hold figure and the payout summary are labeled (demo); a refund after a payout records what the owner owes', async () => {
  store.resetAll();
  const biz = presets.cleaning;
  // A hold: a job tomorrow sits inside PayPal's 3-day honor period.
  const lead = store.createLead({ presetId: 'cleaning' });
  const slot = B.availableSlots(biz, { limit: 1, days: 2 })[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: 'Sarah' });
  assert.equal(B.intentFor(booking, booking.payments[0]), 'authorize');
  B.completeDemoPayment(booking.payments[0].id);
  const page = await call('GET', `/api/pay/${booking.payments[0].id}`);
  assert.equal(page.data.paypal, null);
  assert.equal(page.data.booking.hold, '$50 held in PayPal (demo)');
  const money = B.moneySummary({ days: 7, presetId: 'cleaning' });
  assert.equal(money.demo, true);
  assert.equal(money.onHoldLabel, '$50 (demo)');

  // Paid in full, paid out (simulated), then refunded: the booking carries the clawback line, no PayPal call.
  await B.markCompleted(booking.id);
  const bal = store.getBooking(booking.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  B.completeDemoPayment(bal.id);
  await new Promise((r) => setTimeout(r, 30));
  const paid = store.getBooking(booking.id);
  assert.equal(paid.status, 'paid_in_full');
  assert.equal(paid.payout.status, 'simulated');
  assert.equal(B.moneySummary({ days: 7, presetId: 'cleaning' }).paidOutLabel, `$${paid.payout.amount} (demo)`);
  const r = await B.refund(booking.id, { amount: 100, reason: 'Missed a room', notify: false });
  assert.equal(r.refunded, 100);
  const after = store.getBooking(booking.id);
  assert.equal(after.clawback.amount, 100);
  assert.equal(after.clawback.simulated, true);
  assert.match(after.timeline.at(-1).text, /^Owner owes \$100 back: \$100 was refunded after the \$\d+ payout went out \(demo: simulated\)\. Recorded against the business; no new PayPal call\./);
  // A second refund adds to it, never past what was paid out.
  await B.refund(booking.id, { reason: 'Full refund', notify: false });
  assert.equal(store.getBooking(booking.id).clawback.amount, Math.min(paid.payout.amount, 260));
});

test('setup: the city answer takes a time zone (Central by default); logo links must be https', () => {
  assert.deepEqual(S.applyAnswer('city', 'Franklin, TN').patch, { city: 'Franklin, TN', timezone: 'America/Chicago' });
  assert.deepEqual(S.applyAnswer('city', 'Denver, CO, Mountain time').patch, { city: 'Denver, CO', timezone: 'America/Denver' });
  assert.deepEqual(S.applyAnswer('city', 'Boise, ID (America/Boise)').patch, { city: 'Boise, ID', timezone: 'America/Boise' });
  assert.equal(S.parseTimezone('Miami, FL, EST'), 'America/New_York');
  // State abbreviations and city names that contain a zone word are left alone.
  assert.deepEqual(S.applyAnswer('city', 'Hartford, CT').patch, { city: 'Hartford, CT', timezone: 'America/Chicago' });
  assert.deepEqual(S.applyAnswer('city', 'Mountain View, CA').patch, { city: 'Mountain View, CA', timezone: 'America/Chicago' });
  assert.deepEqual(S.applyAnswer('city', 'Billings, MT').patch, { city: 'Billings, MT', timezone: 'America/Chicago' });
  assert.deepEqual(S.applyAnswer('city', 'Portland, OR, pst').patch, { city: 'Portland, OR', timezone: 'America/Los_Angeles' });
  assert.equal(S.cleanLogoUrl('http://x.example/logo.png'), '');
  assert.equal(S.cleanLogoUrl('https://x.example/logo.png'), 'https://x.example/logo.png');
  const bad = S.applyAnswer('brand', 'green, logo http://x.example/logo.png');
  assert.equal(bad.ok, false);
  assert.match(bad.say, /https:\/\//);
  const biz = S.cleanProfile({ name: 'Boise Lawn', services: [{ name: 'Mowing', sizes: { standard: 45 } }], timezone: 'America/Boise', brand: { logoUrl: 'http://x.example/logo.png' } });
  assert.equal(biz.timezone, 'America/Boise');
  assert.equal(biz.brand.logoUrl, '');
});

test('the demo assistant calls MCP over loopback; the trace and the business info keep the public address', async () => {
  store.resetAll();
  const r = await call('POST', '/api/assistant', { body: { sessionId: 'loop-1', bizId: 'cleaning', text: "Book a deep clean for my 3-bedroom tomorrow morning, keep it under $300. I'm Sarah." } });
  assert.equal(r.status, 200);
  assert.equal(r.data.endpoint, `${base}/mcp/cleaning`);
  assert.equal(r.data.trace[0].tool, 'get_business_info');
  assert.equal(r.data.trace[0].result.mcp_endpoint, `${base}/mcp/cleaning`, 'links in tool results carry the public address, not 127.0.0.1');
  assert.equal(r.data.traceTotal, r.data.trace.length);
  // The session trace is filled as calls happen, so a page polling mid-turn sees the same entries.
  const s = await call('GET', '/api/assistant/loop-1');
  assert.equal(s.data.trace.length, r.data.traceTotal);
  // An outside caller cannot name a public base: the header is believed only with the internal secret.
  const outside = await fetch(`${base}/.well-known/agent-card.json?biz=cleaning`, { headers: { 'x-fad-public-base': 'https://evil.example' } });
  assert.equal((await outside.json()).url, `${base}/mcp/cleaning`);
});
