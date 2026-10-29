// "Load a sample day" on a server that HAS PayPal keys: its payments are demo money. Refunds settle them here
// without calling PayPal, and payouts never send them. (Its own file: PayPal keys are read when the app loads.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-demo-money-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.META_API_KEY = '';
process.env.OWNER_PASSCODE = '';

// Any call to PayPal (or anywhere) fails the test.
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url) => {
  outbound.push(String(url));
  throw new Error(`unexpected network call to ${url}`);
};
after(() => {
  globalThis.fetch = realFetch;
});

const { paypalReady } = await import('../src/config.js');
const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { seedSampleDay } = await import('../src/seed.js');

test('sample day with PayPal keys set: refunds work locally and payouts skip demo money', async () => {
  assert.ok(paypalReady, 'this test runs with PayPal keys set');
  store.resetAll();
  // A business with a payout email, so a real payout would be attempted if demo money counted.
  const business = { ...B.businessById('cleaning'), payoutEmail: 'owner@example.com' };
  await B.withBusiness(business, () => seedSampleDay(business));

  const paid = store.listBookings().find((b) => b.customerName === 'Sarah Kim');
  assert.equal(paid.status, 'paid_in_full');
  assert.ok(paid.payments.every((p) => p.status !== 'completed' || (p.demo && p.mode === 'demo' && p.captureId.startsWith('DEMO-'))), 'saved as demo money');
  assert.ok(!paid.payout, 'no payout is made from demo money');

  const confirmed = store.listBookings().find((b) => b.customerName === 'Marcus Lee');
  const r = await B.refund(confirmed.id, { reason: 'test', notify: false });
  assert.ok(r.refunded > 0);
  assert.match(r.reference, /^DEMO-(REFUND|VOID)-[0-9A-F]{6}$/, "one reference: a refund, or a released deposit hold");
  assert.equal(store.getBooking(confirmed.id).status, 'refunded');

  const r2 = await B.refund(paid.id, { amount: 10, reason: 'partial', notify: false });
  assert.equal(r2.refunded, 10);
  assert.equal(await B.payoutForBooking(paid.id), null, 'still nothing to pay out');
  assert.deepEqual(outbound, [], 'PayPal was never called');
});
