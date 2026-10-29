// Deposits as PayPal holds (authorize, then capture or void), the assistant's pre-approved spending limit, and the
// automatic dispute defense, in demo mode (no PayPal keys: simulated and labeled as such).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-holds-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.META_API_KEY = '';
process.env.OWNER_PASSCODE = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
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
const assistant = (body) => call('POST', '/api/assistant', { body }).then((r) => r.data);

const biz = B.businessById('cleaning');
// A booking whose deposit can be a hold (job ends well inside the 3-day window) or one that cannot.
async function bookWhere(want, name = 'Sarah Kim') {
  const slots = B.availableSlots(biz, { limit: 60, days: 14 });
  const slot = slots.find((s) => B.intentFor({ slotStart: s.start, presetId: 'cleaning' }, { kind: 'deposit' }) === want);
  assert.ok(slot, `an open slot that is ${want}-eligible`);
  const lead = store.createLead({ presetId: 'cleaning' });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: name });
  return store.getBooking(booking.id);
}

test('a deposit inside the 3-day window is held, not charged, and captured on the final bill', async () => {
  store.resetAll();
  const b = await bookWhere('authorize');
  B.completeDemoPayment(b.payments[0].id);
  let nb = store.getBooking(b.id);
  const dep = nb.payments[0];
  assert.equal(nb.status, 'confirmed');
  assert.equal(dep.hold.status, 'authorized');
  assert.match(dep.hold.authorizationId, /^DEMO-AUTH-/);
  assert.equal(dep.captureId, null, 'nothing captured yet');
  assert.equal(B.totals(nb).onHold, 50);
  assert.equal(B.totals(nb).paid, 50, 'the hold counts toward the bill');
  const m = B.moneySummary({ presetId: 'cleaning' });
  assert.equal(m.gross, 0, 'a hold is not money in yet');
  assert.equal(m.onHold, 50);
  assert.match(store.getLead(nb.leadId).messages.at(-1).text, /hold on your PayPal: you're not charged until the job is done/);
  const r = await B.markCompleted(b.id);
  nb = store.getBooking(b.id);
  assert.equal(nb.payments[0].hold.status, 'captured');
  assert.match(nb.payments[0].captureId, /^DEMO-CAPTURE-/);
  assert.equal(r.due, 210, 'the hold is applied to the bill');
  assert.equal(B.moneySummary({ presetId: 'cleaning' }).gross, 50);
});

test('a free cancel releases the hold (never charged); a no-show captures it; later jobs capture at booking', async () => {
  store.resetAll();
  const a = await bookWhere('authorize', 'Ana');
  B.completeDemoPayment(a.payments[0].id);
  const c = await B.customerCancel(a.id);
  assert.equal(c.outcome, 'refunded');
  assert.equal(c.released, true);
  assert.match(c.reference, /^DEMO-VOID-/);
  const na = store.getBooking(a.id);
  assert.equal(na.status, 'refunded');
  assert.equal(na.payments[0].hold.status, 'voided');
  assert.equal(B.totals(na).paid, 0);
  assert.match(store.getLead(na.leadId).messages.at(-1).text, /hold on your PayPal is released\. You were never charged/);

  const n = await bookWhere('authorize', 'Noah');
  B.completeDemoPayment(n.payments[0].id);
  const ns = await B.markNoShow(n.id);
  assert.equal(ns.status, 'no_show');
  assert.equal(ns.depositKept, 50);
  assert.equal(ns.payments[0].hold.status, 'captured');

  const later = await bookWhere('capture', 'Lena');
  B.completeDemoPayment(later.payments[0].id);
  const nl = store.getBooking(later.id);
  assert.equal(nl.payments[0].hold, undefined, 'past the honor window: captured at booking, as before');
  assert.match(nl.payments[0].captureId, /^DEMO-pay_/);
});

test('a hold is captured when the booking moves past the window or the honor period is ending; a partial refund releases part', async () => {
  store.resetAll();
  const a = await bookWhere('authorize', 'Moe');
  B.completeDemoPayment(a.payments[0].id);
  const far = B.availableSlots(biz, { limit: 80, days: 14 }).find((s) => B.intentFor({ slotStart: s.start, presetId: 'cleaning' }, { kind: 'deposit' }) === 'capture');
  await B.reschedule(a.id, far.start, { notify: false });
  assert.equal(store.getBooking(a.id).payments[0].hold.status, 'captured');
  assert.match(store.getBooking(a.id).timeline.at(-2).text + store.getBooking(a.id).timeline.at(-1).text, /3-day hold window/);

  const e = await bookWhere('authorize', 'Eve');
  B.completeDemoPayment(e.payments[0].id);
  assert.equal(await B.settleExpiringHolds(Date.now()), 0, 'nothing ending yet');
  const honor = Date.parse(store.getBooking(e.id).payments[0].hold.honorUntil);
  assert.equal(await B.settleExpiringHolds(honor - 3600 * 1000), 1);
  assert.equal(store.getBooking(e.id).payments[0].hold.status, 'captured');

  const p = await bookWhere('authorize', 'Pia');
  B.completeDemoPayment(p.payments[0].id);
  const r = await B.refund(p.id, { amount: 20, reason: 'goodwill', notify: false });
  assert.equal(r.refunded, 20);
  const np = store.getBooking(p.id);
  assert.equal(np.payments[0].hold.status, 'captured');
  assert.equal(np.payments[0].hold.amount, 30, 'only what the business keeps is captured');
  assert.equal(B.totals(np).paid, 30);
  assert.equal(np.status, 'confirmed');
});

test("the assistant pays the final bill inside the human's limit, shows the check, and asks when it is over", async () => {
  store.resetAll();
  const HEADLINE = "Book a deep clean for my 3-bedroom this Friday morning, keep it under $300. I'm Sarah.";
  const booked = await assistant({ sessionId: 'limit-1', bizId: 'cleaning', text: HEADLINE });
  const payId = booked.approval.url.split('/p/')[1];
  const page = await call('GET', `/api/pay/${payId}`);
  assert.equal(page.data.mandateOffer.agent, 'Demo assistant');
  assert.equal(page.data.mandateOffer.suggested, 260);
  // The human approves the deposit and grants the limit in one step (demo checkout).
  await call('POST', `/api/pay/${payId}/capture`, { body: { mandate: { limit: 260 } } });
  const b = store.getBooking(booked.approval.bookingId);
  assert.equal(b.mandate.status, 'active');
  assert.equal(b.mandate.limit, 260);
  assert.match(b.mandate.vaultId, /^DEMO-VAULT-/);

  // Before the job is done there is nothing to pay.
  const early = await assistant({ sessionId: 'limit-1', text: 'Pay the final bill and add a $20 tip' });
  assert.equal(early.trace.at(-1).tool, 'pay_balance');
  assert.equal(early.trace.at(-1).result.reason, 'job_not_done');

  const done = await call('POST', `/api/owner/bookings/${b.id}/done`, { biz: 'cleaning' });
  assert.equal(done.data.result.due, 210);
  const paid = await assistant({ sessionId: 'limit-1', text: 'Pay the final bill and add a $20 tip' });
  const pb = paid.trace.at(-1);
  assert.equal(pb.tool, 'pay_balance');
  assert.equal(pb.args.tip, 20);
  assert.deepEqual(
    { limit: pb.result.limit_check.limit, spent: pb.result.limit_check.already_spent, amount: pb.result.limit_check.this_payment, decision: pb.result.limit_check.decision },
    { limit: 260, spent: 0, amount: 230, decision: 'within_limit_pay' },
  );
  assert.equal(pb.result.payment_made, true);
  assert.equal(paid.approval, null, 'no approval card: it was inside the limit');
  assert.match(paid.reply, /Paid \$230 \(\$210 balance \+ \$20 tip\) from your saved PayPal, inside the \$260 limit/);
  assert.match(paid.reply, /Demo: simulated/);
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'paid_in_full');
  assert.equal(B.totals(nb).tips, 20);
  assert.equal(nb.mandate.spent, 230);
  assert.equal(nb.mandate.status, 'used');
});

test('over the limit, or with no limit, nothing is paid and the human gets a final-bill approval', async () => {
  store.resetAll();
  const HEADLINE = "Book a deep clean for my 3-bedroom this Friday morning, keep it under $300. I'm Sarah.";
  const one = await assistant({ sessionId: 'limit-over', bizId: 'cleaning', text: HEADLINE });
  await call('POST', `/api/pay/${one.approval.url.split('/p/')[1]}/capture`, { body: { mandate: { limit: 100 } } });
  await call('POST', `/api/owner/bookings/${one.approval.bookingId}/done`, { biz: 'cleaning' });
  const over = await assistant({ sessionId: 'limit-over', text: 'Pay the final bill' });
  const r = over.trace.at(-1).result;
  assert.equal(r.payment_made, false);
  assert.equal(r.reason, 'over_limit');
  assert.equal(r.limit_check.decision, 'over_limit_ask_human');
  assert.equal(over.approval.label, 'Final bill');
  assert.equal(over.approval.amount, 210);
  assert.match(over.reply, /over the \$100 limit you set/);
  assert.equal(store.getBooking(one.approval.bookingId).status, 'completed', 'still owed: nothing was paid');

  const two = await assistant({ sessionId: 'limit-none', bizId: 'cleaning', text: HEADLINE });
  await call('POST', `/api/pay/${two.approval.url.split('/p/')[1]}/capture`, { body: {} });
  await call('POST', `/api/owner/bookings/${two.approval.bookingId}/done`, { biz: 'cleaning' });
  const none = await assistant({ sessionId: 'limit-none', text: 'Pay the final bill' });
  assert.equal(none.trace.at(-1).result.reason, 'no_mandate');
  assert.ok(none.approval);

  // A limit is only offered on a booking an assistant made: a text booking ignores it.
  const lead = store.createLead({ presetId: 'cleaning' });
  const s = B.availableSlots(biz, { limit: 1 })[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: s.start, customerName: 'Text Customer' });
  assert.equal((await call('GET', `/api/pay/${booking.payments[0].id}`)).data.mandateOffer, null);
  await call('POST', `/api/pay/${booking.payments[0].id}/capture`, { body: { mandate: { limit: 500 } } });
  assert.equal(store.getBooking(booking.id).mandate, undefined);
});

test('a test dispute (demo) gets the evidence file sent automatically and the owner feed says so', async () => {
  store.resetAll();
  await call('POST', '/api/owner/seed', { biz: 'cleaning' });
  const st = (await call('GET', '/api/owner/state', { biz: 'cleaning' })).data;
  const paid = st.bookings.find((b) => b.status === 'paid_in_full');
  const r = await call('POST', `/api/owner/bookings/${paid.id}/demo-dispute`, { biz: 'cleaning' });
  assert.equal(r.status, 200);
  const b = store.getBooking(paid.id);
  assert.equal(b.disputes[0].status, 'simulated');
  assert.equal(b.disputes[0].evidenceType, 'PROOF_OF_FULFILLMENT');
  const after = (await call('GET', '/api/owner/state', { biz: 'cleaning' })).data;
  assert.match(after.activity[0].text, /^The AI defended your chargeback \(demo: simulated, no PayPal call\)/);
  const pdf = B.evidencePdf(paid.id);
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(pdf.toString('latin1'), /Terms the customer saw before paying/);
  assert.match(pdf.toString('latin1'), /%%EOF\n$/);
  // A booking with nothing paid can't be disputed.
  const held = after.bookings.find((x) => x.status === 'held');
  assert.equal((await call('POST', `/api/owner/bookings/${held.id}/demo-dispute`, { biz: 'cleaning' })).status, 400);
});
