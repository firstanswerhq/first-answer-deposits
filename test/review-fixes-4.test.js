// Regression tests for the fourth review of the review-fixes branch: deposit links after the business cancels,
// closing a business-canceled unpaid booking, "Can't make it" on closed bookings, the owner table's business
// scope, and refunds that include the tip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-review4-${process.pid}.json`);
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
const { scriptedCustomerReply } = await import('../src/agent/scripted.js');
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

async function call(method, url, { body, biz } = {}) {
  const headers = { 'Content-Type': 'application/json' };
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

// A booking that is paid in full with a tip on the final bill.
async function paidWithTip(name, tip, opts) {
  const b = await book(name, opts);
  B.completeDemoPayment(b.payments[0].id);
  await B.markCompleted(b.id);
  const bal = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  B.completeDemoPayment(bal.id, { tip });
  return store.getBooking(b.id);
}

// ---------- 1. a deposit link dies when the business cancels an unpaid booking ----------
test('business cancels an unpaid hold: the deposit link is voided and order/capture refuse it', async () => {
  store.resetAll();
  const b = await book('Priya');
  const pay = b.payments[0].id;
  const r = await call('POST', `/api/owner/bookings/${b.id}/cancel`, { body: { reason: 'truck broke down' } });
  assert.equal(r.status, 200);
  assert.equal(store.getBooking(b.id).status, 'needs_rebook');
  assert.equal(store.findPayment(pay).payment.status, 'void');
  const order = await call('POST', `/api/pay/${pay}/order`, { body: {} });
  assert.equal(order.status, 400);
  assert.ok(!order.data.demo, 'no demo checkout offered');
  const cap = await call('POST', `/api/pay/${pay}/capture`, { body: {} });
  assert.equal(cap.status, 400);
  assert.equal(B.totals(store.getBooking(b.id)).paid, 0, 'no money taken');
  assert.match(store.getLead(b.leadId).messages.at(-1).text, /Nothing was charged/);

  // Picking a new time puts the hold back with a fresh deposit link that does take payment.
  const next = B.availableSlots(B.businessOf(b), { limit: 3 }).find((s) => s.start !== b.slotStart);
  const moved = await B.reschedule(b.id, next.start, { notify: true });
  assert.equal(moved.status, 'held');
  const fresh = moved.payments.find((p) => p.kind === 'deposit' && p.status === 'pending');
  assert.ok(fresh && fresh.id !== pay, 'a fresh deposit link');
  assert.match(store.getLead(b.leadId).messages.at(-1).text, new RegExp(`/p/${fresh.id}`));
  assert.equal((await call('POST', `/api/pay/${fresh.id}/capture`, { body: {} })).status, 200);
  assert.equal(store.getBooking(b.id).status, 'confirmed');
});

test('a deposit link still marked pending on a needs_rebook booking is not payable', async () => {
  store.resetAll();
  const b = await book('Split');
  // e.g. half the deposit paid (so businessCancel keeps the link), or older data.
  store.updateBooking(b.id, { status: 'needs_rebook' });
  const pay = b.payments[0].id;
  assert.equal(store.findPayment(pay).payment.status, 'pending');
  assert.match(B.notPayable(store.getBooking(b.id), store.findPayment(pay).payment), /business canceled/i);
  assert.equal((await call('POST', `/api/pay/${pay}/order`, { body: {} })).status, 400);
  assert.equal((await call('POST', `/api/pay/${pay}/capture`, { body: {} })).status, 400);
  assert.equal(B.totals(store.getBooking(b.id)).paid, 0);
});

// ---------- 2. the customer can close a business-canceled booking they never paid for ----------
test('unpaid booking the business canceled: customer cancel closes it (MCP, scripted text, and the helper)', async () => {
  store.resetAll();
  // MCP cancel_booking
  const mcpBooking = await book('Mia');
  await B.businessCancel(mcpBooking.id);
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/cleaning`)));
  try {
    const r = await client.callTool({ name: 'cancel_booking', arguments: { booking_id: mcpBooking.id, booking_key: store.getBooking(mcpBooking.id).secret } });
    const data = r.structuredContent ?? JSON.parse(r.content[0].text);
    assert.ok(!r.isError, JSON.stringify(data));
    assert.equal(data.outcome, 'released');
    assert.equal(data.status, 'canceled');
  } finally {
    await client.close();
  }
  assert.equal(store.getBooking(mcpBooking.id).status, 'canceled');

  // Scripted text reply ("cancel")
  const textBooking = await book('Tom', { slot: 1 });
  await B.businessCancel(textBooking.id);
  store.addMessage(textBooking.leadId, 'customer', 'cancel please');
  const reply = await scriptedCustomerReply(store.getLead(textBooking.leadId));
  assert.match(reply, /canceled/i);
  assert.doesNotMatch(reply, /nothing to refund\b.*hasn't paid/);
  assert.equal(store.getBooking(textBooking.id).status, 'canceled');

  // A paid booking the business canceled still refunds in full.
  const paid = await book('Paid', { slot: 2 });
  B.completeDemoPayment(paid.payments[0].id);
  await B.businessCancel(paid.id);
  const rf = await B.acceptBusinessCancel(paid.id, { notify: false });
  assert.equal(rf.outcome, 'refunded_in_full');
  assert.equal(rf.refunded, paid.deposit);
  assert.equal(store.getBooking(paid.id).status, 'refunded');
});

// ---------- 3. "Can't make it" never reopens a closed booking ----------
test("\"Can't make it\" works only on held or confirmed bookings", async () => {
  store.resetAll();
  const b = await book('Rae');
  B.completeDemoPayment(b.payments[0].id);
  await B.refund(b.id, { reason: 'test', notify: false });
  assert.equal(store.getBooking(b.id).status, 'refunded');
  const r = await call('POST', `/api/owner/bookings/${b.id}/cancel`, { body: {} });
  assert.equal(r.status, 400);
  assert.equal(store.getBooking(b.id).status, 'refunded', 'still refunded, not waiting on the customer');

  const done = await paidWithTip('Done', 10, { slot: 1 });
  assert.equal(done.status, 'paid_in_full');
  assert.equal((await call('POST', `/api/owner/bookings/${done.id}/cancel`, { body: {} })).status, 400);
  assert.equal(store.getBooking(done.id).status, 'paid_in_full');

  const held = await book('Held', { slot: 2 });
  assert.equal((await call('POST', `/api/owner/bookings/${held.id}/cancel`, { body: {} })).status, 200);
});

// ---------- 4. owner table display ----------
test('owner page bookings are scoped to the business shown; closed bookings owe $0', async () => {
  store.resetAll();
  assert.equal((await call('POST', '/api/owner/seed', { biz: 'cleaning' })).status, 200);
  assert.equal((await call('POST', '/api/owner/seed', { biz: 'hvac' })).status, 200);
  const hvac = await call('GET', '/api/owner/state', { biz: 'hvac' });
  assert.ok(hvac.data.bookings.length > 0);
  assert.ok(hvac.data.bookings.every((b) => store.getBooking(b.id).presetId === 'hvac'), 'only HVAC bookings');
  assert.ok(hvac.data.leads.every((l) => l.presetId === 'hvac'), 'only HVAC leads');
  assert.equal(hvac.data.waitlist.length, 1, 'only the HVAC waitlist');
  assert.ok(hvac.data.waitlist.every((w) => w.presetId === 'hvac'));
  const cleaningIds = new Set(store.listBookings().filter((b) => b.presetId === 'cleaning').map((b) => b.id));
  assert.ok(hvac.data.activity.length > 0 && hvac.data.activity.every((a) => !cleaningIds.has(a.bookingId)), 'no cleaning activity on the HVAC page');
  const clean = await call('GET', '/api/owner/state', { biz: 'cleaning' });
  assert.ok(clean.data.bookings.every((b) => store.getBooking(b.id).presetId === 'cleaning'));

  // A canceled booking owes nothing.
  const priya = store.listBookings().find((b) => b.presetId === 'cleaning' && b.status === 'held');
  await B.releaseHold(priya.id);
  const row = (await call('GET', '/api/owner/state', { biz: 'cleaning' })).data.bookings.find((b) => b.id === priya.id);
  assert.equal(row.status, 'canceled');
  assert.equal(row.totals.due, 0);
});

test('a full refund returns the tip too; a partial refund keeps it and says so', async () => {
  store.resetAll();
  const m = await paidWithTip('Marcus', 500);
  const paidBefore = B.totals(m).paid;
  const r = await call('POST', `/api/owner/bookings/${m.id}/refund`, { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.refunded, paidBefore + 500);
  assert.equal(r.data.result.tipRefunded, 500);
  const after = store.getBooking(m.id);
  assert.equal(after.status, 'refunded');
  assert.equal(B.totals(after).tips, 0, 'no tip kept');
  assert.equal(B.totals(after).tipsRefunded, 500);
  assert.match(store.getLead(m.leadId).messages.at(-1).text, /plus the \$500 tip/);

  const p = await paidWithTip('Pat', 20, { slot: 1 });
  const pr = await B.refund(p.id, { amount: 50, reason: 'missed a spot', notify: true });
  assert.equal(pr.refunded, 50);
  assert.equal(pr.tipRefunded, 0);
  assert.equal(B.totals(store.getBooking(p.id)).tips, 20, 'tip kept on a partial refund');
  assert.match(store.getLead(p.leadId).messages.at(-1).text, /The \$20 tip was not refunded/);

  // Nothing paid: a refund is refused (the owner page hides the button for these rows).
  const z = await book('Zed', { slot: 2 });
  assert.equal((await call('POST', `/api/owner/bookings/${z.id}/refund`, { body: {} })).status, 400);
});
