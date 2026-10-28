// Regression tests for the code-review fixes: money rules and security checks, all in demo mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-review-${process.pid}.json`);
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');

async function bookPaid(name = 'Sarah', { presetId = 'cleaning', slot = 0 } = {}) {
  const lead = store.createLead({ presetId });
  const biz = B.businessOf(lead);
  const s = B.availableSlots(biz, { limit: slot + 1 })[slot];
  const svc = biz.services[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: svc.id, size: Object.keys(svc.sizes)[0], slotStart: s.start, customerName: name });
  B.completeDemoPayment(booking.payments[0].id);
  return store.getBooking(booking.id);
}

test('customers can only cancel a held or confirmed booking (no refund after the job is paid)', async () => {
  store.resetAll();
  const b = await bookPaid('Pia');
  await B.markCompleted(b.id);
  const bal = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  B.completeDemoPayment(bal.id);
  assert.equal(store.getBooking(b.id).status, 'paid_in_full');
  const paidBefore = B.totals(store.getBooking(b.id)).paid;
  await assert.rejects(B.customerCancel(b.id), /can't be canceled/);
  assert.equal(store.getBooking(b.id).status, 'paid_in_full');
  assert.equal(B.totals(store.getBooking(b.id)).paid, paidBefore);

  // Job done with a balance open: also not cancelable by the customer.
  const c = await bookPaid('Cy', { slot: 1 });
  await B.markCompleted(c.id);
  await assert.rejects(B.customerCancel(c.id), /can't be canceled/);
  assert.equal(store.getBooking(c.id).status, 'completed');

  // A held or confirmed booking still cancels as before.
  const d = await bookPaid('Dot', { slot: 2 });
  const r = await B.customerCancel(d.id);
  assert.ok(['refunded', 'kept_deposit'].includes(r.outcome));
});

test('payouts count only PayPal money; cash is capped at what is owed and must be positive', async () => {
  store.resetAll();
  const b = await bookPaid('Cash'); // $50 deposit through (demo) PayPal
  const total = B.totals(b).total;
  await B.markCompleted(b.id);
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: -500, method: 'cash' }), /amount/);
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: 'abc', method: 'cash' }), /amount/);
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: 0, method: 'cash' }), /amount/);
  const after = B.recordOutsidePayment(b.id, { amount: 1000000, method: 'paypal' });
  const cash = after.payments.at(-1);
  assert.equal(cash.amount, total - 50, 'capped at the balance still due');
  assert.equal(cash.mode, 'outside');
  assert.equal(cash.method, 'other', 'cannot pretend to be a PayPal payment');
  assert.equal(after.status, 'paid_in_full');
  assert.equal(B.totals(after).paid, total);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getBooking(b.id).payout.amount, 50, 'only the PayPal deposit is paid out, never the cash');
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: 10 }), /doesn't owe anything/);
});
