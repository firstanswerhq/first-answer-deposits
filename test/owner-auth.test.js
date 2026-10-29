// The owner side over HTTP: a business set up at /setup is managed only with its owner key, secrets stay
// masked, reset is off by default, and the demo businesses stay open for anyone trying the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-owner-auth-${process.pid}.json`);
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
const C = await import('../src/connect.js');
const { default: app } = await import('../src/server.js');

let server;
let base;
const sent = [];
before(async () => {
  C._setOutFetch(async (url, opts) => {
    sent.push({ url, opts });
    return { ok: true };
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, { body, key, passcode, biz } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-owner-key'] = key;
  if (biz) headers['x-biz'] = biz;
  if (passcode) headers['x-owner-passcode'] = passcode;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('trust proxy is on so rate limits see the visitor, not the host proxy', () => {
  assert.equal(app.get('trust proxy'), 1);
});

test('a set-up business needs its owner key; demo businesses stay open', async () => {
  store.resetAll();
  store.setPreset('cleaning');
  const profile = { name: 'Keyed Lawn', trade: 'lawn care', city: 'Franklin, TN', services: [{ id: 'mow', name: 'Mowing', sizes: { standard: 60 } }], deposit: { type: 'flat', amount: 20 }, payoutEmail: 'owner@keyed.example' };
  const made = await call('POST', '/api/setup/create', { body: { profile } });
  assert.equal(made.status, 200);
  const { ownerKey, business } = made.data;
  assert.ok(ownerKey && ownerKey.length >= 20);
  assert.ok(made.data.links.owner.includes(`key=${ownerKey}`));
  const saved = store.getBusiness(business.id);
  assert.ok(saved.ownerKeyHash && saved.ownerKeyHash !== ownerKey, 'only a hash is stored');

  // Switching the owner page to it needs the key.
  assert.equal((await call('POST', '/api/owner/preset', { body: { presetId: business.id } })).status, 403);
  assert.equal((await call('POST', '/api/owner/preset', { body: { presetId: business.id }, key: 'wrong-key' })).status, 403);
  assert.equal((await call('POST', '/api/owner/preset', { body: { presetId: business.id }, key: ownerKey })).status, 200);

  // Payout email and connections: only with the key. Without it the request lands on the read-only demo business.
  const hijack = await call('POST', '/api/owner/connections', { body: { payoutEmail: 'thief@evil.example' } });
  assert.equal(hijack.status, 400);
  assert.equal(store.getBusiness(business.id).payoutEmail, 'owner@keyed.example');
  const peek = await call('GET', '/api/owner/connections');
  assert.equal(peek.data.business.id, 'cleaning', 'a stranger sees the demo business, not the keyed one');
  assert.ok(!JSON.stringify(peek.data).includes('keyed.example'));

  const set = await call('POST', '/api/owner/connections', { key: ownerKey, biz: business.id, body: { payoutEmail: 'new@keyed.example', webhookUrl: 'https://1.1.1.1/hook' } });
  assert.equal(set.status, 200);
  const full = set.data.webhookSecret;
  assert.match(full, /^whsec_/, 'the new signing secret is shown once');
  const own = await call('GET', '/api/owner/connections', { key: ownerKey, biz: business.id });
  assert.equal(own.data.payoutEmail, 'new@keyed.example');
  assert.ok(own.data.webhookSecret && own.data.webhookSecret !== full && !own.data.webhookSecret.includes(full.slice(6, -4)), 'secret is masked afterwards');

  // Internal webhook addresses are refused when saved.
  const ssrf = await call('POST', '/api/owner/connections', { key: ownerKey, biz: business.id, body: { webhookUrl: 'https://169.254.169.254/latest' } });
  assert.equal(ssrf.status, 400);

  // A booking at the keyed business: refunds, the owner AI and the evidence file need the key.
  const lead = store.createLead({ presetId: business.id });
  const slot = B.availableSlots(B.businessById(business.id), { limit: 1 })[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'mow', size: 'standard', slotStart: slot.start, customerName: 'Zed' });
  B.completeDemoPayment(booking.payments[0].id);
  assert.equal((await call('POST', `/api/owner/bookings/${booking.id}/refund`, { body: {} })).status, 403);
  assert.equal((await call('POST', `/api/owner/bookings/${booking.id}/cash`, { body: { amount: 40 } })).status, 403);
  assert.equal((await call('GET', `/api/evidence/${booking.id}`)).status, 403);
  // Without the key the owner AI runs for the demo business, which can't reach the keyed business's customers.
  assert.equal((await call('POST', '/api/owner/text', { body: { text: 'refund Zed' } })).status, 200);
  assert.equal(B.totals(store.getBooking(booking.id)).refunded, 0);

  // From an open demo business, the owner AI can't reach the keyed business's customers either.
  assert.equal((await call('POST', '/api/owner/preset', { body: { presetId: 'cleaning' } })).status, 200);
  const r = await call('POST', '/api/owner/text', { body: { text: 'refund Zed' } });
  assert.equal(r.status, 200);
  assert.equal(B.totals(store.getBooking(booking.id)).refunded, 0);
  const state = await call('GET', '/api/owner/state');
  assert.ok(!state.data.bookings.some((b) => b.id === booking.id), 'not listed to strangers');
  assert.ok((await call('GET', '/api/owner/state', { key: ownerKey, biz: business.id })).data.bookings.some((b) => b.id === booking.id), 'listed to its owner');

  // With the key, the owner can refund.
  const ok = await call('POST', `/api/owner/bookings/${booking.id}/refund`, { key: ownerKey, body: { amount: 5 } });
  assert.equal(ok.status, 200);
  assert.equal(B.totals(store.getBooking(booking.id)).refunded, 5);
  // Bad amounts are refused at the route too.
  assert.equal((await call('POST', `/api/owner/bookings/${booking.id}/refund`, { key: ownerKey, body: { amount: 'lots' } })).status, 400);
  assert.equal(B.totals(store.getBooking(booking.id)).refunded, 5);

  // Demo businesses: the owner page still works without any key.
  const demoLead = store.createLead({ presetId: 'cleaning' });
  const s2 = B.availableSlots(B.businessById('cleaning'), { limit: 1 })[0];
  const demo = await B.bookAndRequestDeposit({ leadId: demoLead.id, serviceId: 'standard', size: '3 bedrooms', slotStart: s2.start, customerName: 'Judge' });
  B.completeDemoPayment(demo.booking.payments[0].id);
  assert.equal((await call('POST', `/api/owner/bookings/${demo.booking.id}/done`, { body: {} })).status, 200);
});

test('reset is off unless ALLOW_RESET=1; the pay page gets a view-only booking link', async () => {
  const before = store.listBookings().length;
  const r = await call('POST', '/api/owner/reset');
  assert.equal(r.status, 403);
  assert.equal(store.listBookings().length, before);
  process.env.ALLOW_RESET = '1';
  assert.equal((await call('POST', '/api/owner/reset')).status, 200);
  delete process.env.ALLOW_RESET;

  const lead = store.createLead({ presetId: 'cleaning' });
  const s = B.availableSlots(B.businessById('cleaning'), { limit: 1 })[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'standard', size: '3 bedrooms', slotStart: s.start, customerName: 'Viv' });
  const pay = await call('GET', `/api/pay/${booking.payments[0].id}`);
  assert.ok(!pay.data.bookingUrl.includes(booking.secret), 'pay page never sees the manage key');
  const k = new URL(pay.data.bookingUrl).searchParams.get('k');
  assert.equal((await call('GET', `/api/booking/${booking.id}?k=${k}`)).status, 200);
  assert.equal((await call('GET', `/api/booking/${booking.id}?k=nope`)).status, 404);
});
