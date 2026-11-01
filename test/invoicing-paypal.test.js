// Invoicing and racing payments, real-mode money paths (PayPal keys set) against a fake PayPal that answers after 40 ms, so calls
// that race really do overlap: pay_balance racing itself, invoices paid on closed or replaced deposits, split
// deposits released with a share paid, and payouts on a keyed server.
// (Its own file: PayPal keys are read when the app loads.)
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-review5-pp-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
for (const k of ['GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'META_API_KEY']) process.env[k] = '';

// ---------- a fake PayPal with latency and idempotency ----------
const calls = [];
const orders = new Map();
const seenKeys = new Map();
let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (b, s = 200) => new Response(b === null ? null : JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const fake = { failCancel: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || 'GET';
  const p = u.pathname;
  let body = null;
  if (typeof init.body === 'string' && init.body.startsWith('{')) body = JSON.parse(init.body);
  const key = init.headers?.['PayPal-Request-Id'];
  calls.push({ method, path: p, body, key });
  if (p === '/v1/oauth2/token') return json({ access_token: 'tok', expires_in: 3600 });
  await sleep(40);
  if (key && seenKeys.has(key)) return json(seenKeys.get(key));
  let out;
  let m;
  if (p === '/v2/checkout/orders' && method === 'POST') {
    const id = `ORDER-${++n}`;
    if (body.payment_source?.paypal?.vault_id) out = { id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP-VAULT-${n}`, status: 'COMPLETED', amount: { value: body.purchase_units[0].amount.value } }] } }] };
    else {
      orders.set(id, body);
      out = { id, status: 'CREATED', links: [{ rel: 'approve', href: `https://x/${id}` }] };
    }
  } else if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) out = { id: m[1], intent: orders.get(m[1])?.intent, status: 'APPROVED' };
  else if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/))) {
    const v = orders.get(m[1])?.payment_source?.paypal?.attributes?.vault;
    out = { id: m[1], status: 'COMPLETED', ...(v ? { payment_source: { paypal: { attributes: { vault: { id: 'VAULT-1', status: 'VAULTED' } } } } } : {}), purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${m[1]}`, status: 'CREATED' }] } }] };
  } else if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
    const v = orders.get(m[1])?.payment_source?.paypal?.attributes?.vault;
    out = { id: m[1], status: 'COMPLETED', ...(v ? { payment_source: { paypal: { attributes: { vault: { id: 'VAULT-1', status: 'VAULTED' } } } } } : {}), purchase_units: [{ payments: { captures: [{ id: `CAP-${m[1]}`, status: 'COMPLETED' }] } }] };
  } else if ((m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/))) out = { id: `CAP-${m[1]}-${calls.length}`, status: 'COMPLETED' };
  else if (/\/void$/.test(p)) return new Response(null, { status: 204 });
  else if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) out = { id: `REF-${m[1]}`, status: 'COMPLETED' };
  else if (p === '/v2/invoicing/invoices' && method === 'POST') out = { id: `INV2-${++n}` };
  else if (/\/v2\/invoicing\/invoices\/[^/]+\/cancel$/.test(p)) {
    if (fake.failCancel > 0) {
      fake.failCancel--;
      return json({ name: 'INTERNAL_SERVER_ERROR' }, 500);
    }
    return new Response(null, { status: 204 });
  } else if (/\/v2\/invoicing\/invoices\/[^/]+\/(send|remind)$/.test(p)) out = { href: 'https://x/inv' };
  else if (p === '/v1/payments/payouts') out = { batch_header: { payout_batch_id: `BATCH-${n}`, batch_status: 'PENDING' } };
  if (!out) return json({ name: 'NOT_FOUND', path: p }, 404);
  if (key) seenKeys.set(key, out);
  return json(out, 201);
};
after(() => {
  globalThis.fetch = realFetch;
});

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const biz = B.businessById('cleaning');
beforeEach(() => store.resetAll());

async function agentBooking(name, { hold = true } = {}) {
  const slot = B.availableSlots(biz, { limit: 80, days: 14 }).find((s) => B.intentFor({ slotStart: s.start, presetId: 'cleaning' }, { kind: 'deposit' }) === (hold ? 'authorize' : 'capture'));
  const lead = store.createLead({ presetId: 'cleaning' });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: name });
  store.updateBooking(booking.id, { source: 'agent', bookedBy: 'Claude' });
  return store.getBooking(booking.id);
}
async function pay(paymentId, opts = {}) {
  const co = await B.checkoutFor(paymentId, opts);
  await B.syncPayment(paymentId, { orderId: co.orderId });
}
async function paidWithMandate(name, limit, opts) {
  const b = await agentBooking(name, opts);
  await pay(b.payments[0].id, { mandate: { limit } });
  return store.getBooking(b.id);
}
const vaultCharges = () => calls.filter((c) => c.path === '/v2/checkout/orders' && c.body?.payment_source?.paypal?.vault_id);
const invoicePaid = (inv, txn) => B.handlePayPalEvent({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: inv, payments: { transactions: [{ payment_id: txn }] } } } });
const refundsOf = (cap) => calls.filter((c) => c.path === `/v2/payments/captures/${cap}/refund`);

// ---------- 1. pay_balance racing itself ----------
test('four parallel pay_balance calls charge the saved wallet once, inside the limit', async () => {
  const b = await paidWithMandate('Race', 260);
  await B.markCompleted(b.id);
  const before = vaultCharges().length;
  const rs = await Promise.all([0, 10, 20, 30].map((tip) => B.payWithMandate(b.id, { tip, agent: 'Claude' })));
  const charges = vaultCharges().slice(before);
  const total = charges.reduce((a, c) => a + Number(c.body.purchase_units[0].amount.value), 0);
  assert.equal(charges.length, 1, `one PayPal charge, got ${charges.length}`);
  assert.ok(total <= 260, `charged ${total}, limit 260`);
  assert.equal(rs.filter((r) => r.paid).length, 1);
  assert.ok(rs.filter((r) => !r.paid).every((r) => r.reason === 'nothing_due'));
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'paid_in_full');
  assert.ok(nb.mandate.spent <= 260);
  // The PayPal-Request-Id is the payment alone, so a retry of the same bill with another tip is de-duplicated.
  assert.match(charges[0].key, /^vault-charge-pay_[^-]+$/);
});

// ---------- 4. invoices paid on closed or replaced deposits ----------
test('invoice paid after the customer canceled: refunded automatically, owner alerted, nothing counted', async () => {
  const b = await agentBooking('Canceled');
  await B.emailDepositInvoice(b.id, { email: 'c@example.com' });
  const inv = store.getBooking(b.id).payments[0].invoice.id;
  await B.customerCancel(b.id, { notify: false });
  await invoicePaid(inv, 'TXN-INV-C');
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'canceled');
  assert.equal(B.totals(nb).paid, 0);
  assert.equal(refundsOf('TXN-INV-C').length, 1, 'PayPal refund called on the invoice payment');
  assert.equal(nb.invoiceRefunds[0].status, 'COMPLETED');
  assert.ok(store.listActivity().some((a) => a.kind === 'invoice_refund' && a.text.includes(inv)), 'logged on the owner feed');
  assert.ok(store.listOwnerMessages('cleaning').some((m) => m.alert && /refunded it automatically/.test(m.text)));
  // The same webhook again refunds nothing more.
  await invoicePaid(inv, 'TXN-INV-C');
  assert.equal(refundsOf('TXN-INV-C').length, 1);
});

test('bill split after an invoice: the paid invoice (voided original) is refunded, the shares stay the way to pay', async () => {
  const b = await agentBooking('Splitter');
  await B.emailDepositInvoice(b.id, { email: 's@example.com' });
  const inv = store.getBooking(b.id).payments[0].invoice.id;
  await B.splitDue(b.id, 2);
  await invoicePaid(inv, 'TXN-INV-S');
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'held');
  assert.equal(B.totals(nb).depositPaid, 0, 'the voided original never counts');
  assert.equal(refundsOf('TXN-INV-S').length, 1);
  assert.equal(nb.payments.filter((p) => p.status === 'pending').length, 2);
});

test('link paid first, then the invoice: the invoice money is refunded, not silently dropped', async () => {
  const b = await agentBooking('DoublePay');
  await B.emailDepositInvoice(b.id, { email: 'dp@example.com' });
  const inv = store.getBooking(b.id).payments[0].invoice.id;
  await pay(b.payments[0].id);
  await invoicePaid(inv, 'TXN-INV-9');
  const nb = store.getBooking(b.id);
  assert.equal(refundsOf('TXN-INV-9').length, 1);
  assert.match(nb.timeline.at(-1).text, /refunded automatically/);
  assert.equal(nb.payments[0].via, 'paypal');
});

test('a replaced invoice paid late is found and refunded; paying the current invoice voids the other deposit links', async () => {
  const b = await agentBooking('TwoInvoices');
  await B.emailDepositInvoice(b.id, { email: 'one@example.com' });
  const first = store.getBooking(b.id).payments[0].invoice.id;
  await B.emailDepositInvoice(b.id, { email: 'two@example.com', confirmNewAddress: true });
  const second = store.getBooking(b.id).payments[0].invoice.id;
  assert.notEqual(first, second);
  await invoicePaid(first, 'TXN-OLD');
  assert.equal(refundsOf('TXN-OLD').length, 1, 'the replaced invoice is refunded');
  await invoicePaid(second, 'TXN-NEW');
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'confirmed');
  assert.equal(refundsOf('TXN-NEW').length, 0);
  assert.equal(nb.payments[0].via, 'PayPal invoice');
});

test('cancel of a replaced invoice is retried until PayPal confirms; a reschedule cancels the emailed invoice', async () => {
  const b = await agentBooking('Retry');
  await B.emailDepositInvoice(b.id, { email: 'r@example.com' });
  const inv = store.getBooking(b.id).payments[0].invoice.id;
  fake.failCancel = 5; // more than the immediate retries
  await B.customerCancel(b.id, { notify: false });
  let p = store.getBooking(b.id).payments[0];
  assert.equal(p.invoice.status, 'canceled');
  assert.equal(p.invoice.cancelConfirmed, false);
  fake.failCancel = 0;
  assert.equal(await B.reconcileInvoices(), 1);
  p = store.getBooking(b.id).payments[0];
  assert.equal(p.invoice.cancelConfirmed, true);
  assert.ok(calls.filter((c) => c.path === `/v2/invoicing/invoices/${inv}/cancel`).length >= 4);

  const c = await agentBooking('Mover');
  await B.emailDepositInvoice(c.id, { email: 'm@example.com' });
  const inv2 = store.getBooking(c.id).payments[0].invoice.id;
  const next = B.availableSlots(biz, { limit: 20 }).find((s) => s.start !== c.slotStart);
  await B.reschedule(c.id, next.start);
  const nc = store.getBooking(c.id);
  assert.equal(nc.payments[0].invoice.status, 'canceled');
  assert.ok(calls.some((x) => x.path === `/v2/invoicing/invoices/${inv2}/cancel`));
  assert.match(store.getLead(nc.leadId).messages.at(-1).text, /invoice had the old time/);
});

// ---------- 5. split deposit, one share paid, the rest never comes ----------
test('a stale split hold with one share paid voids that share in PayPal and tells the customer', async () => {
  const b = await agentBooking('StaleSplit');
  await B.splitDue(b.id, 2);
  const shares = store.getBooking(b.id).payments.filter((p) => p.status === 'pending');
  await pay(shares[0].id);
  const auth = store.findPayment(shares[0].id).payment.hold.authorizationId;
  store.updateBooking(b.id, { createdAt: new Date(Date.now() - 3 * 3600e3).toISOString() });
  await B.releaseStaleHolds();
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'canceled');
  assert.equal(nb.payments.find((p) => p.id === shares[0].id).hold.status, 'voided');
  assert.ok(calls.some((c) => c.path === `/v2/payments/authorizations/${auth}/void`), 'PayPal void called');
  assert.equal(B.totals(nb).paid, 0);
  assert.match(store.getLead(nb.leadId).messages.at(-1).text, /released from your PayPal/);
});

test('a captured share is refunded when the owner releases the hold; an ending honor period on a held split releases it', async () => {
  const b = await agentBooking('CapturedShare', { hold: false });
  await B.splitDue(b.id, 2);
  const share = store.getBooking(b.id).payments.find((p) => p.status === 'pending');
  await pay(share.id);
  const cap = store.findPayment(share.id).payment.captureId;
  await B.releaseHold(b.id, 'Released by the owner');
  assert.equal(refundsOf(cap).length, 1, 'PayPal refund of the captured share');
  assert.equal(B.totals(store.getBooking(b.id)).paid, 0);

  const c = await agentBooking('EndingSplit');
  await B.splitDue(c.id, 2);
  const s1 = store.getBooking(c.id).payments.find((p) => p.status === 'pending');
  await pay(s1.id);
  const n = await B.settleExpiringHolds(Date.now() + 70 * 3600e3);
  assert.equal(n, 1);
  const nc = store.getBooking(c.id);
  assert.equal(nc.status, 'canceled');
  assert.equal(nc.payments.find((p) => p.id === s1.id).hold.status, 'voided');
});

// ---------- 8. a reset never deletes a booking with an open PayPal object ----------
test('Reset demo keeps bookings with a sent invoice or an open PayPal order, even ones this visitor made', async () => {
  const { resetBusinessDemo } = await import('../src/seed.js');
  const vid = 'cccccccccccccccccccccccc';
  const mk = async (name) => {
    const b = await agentBooking(name);
    store.updateBooking(b.id, { visitorId: vid });
    return b;
  };
  const invoiced = await mk('Invoiced');
  await B.emailDepositInvoice(invoiced.id, { email: 'i@example.com' });
  const ordered = await mk('Ordered');
  await B.checkoutFor(ordered.payments[0].id, {});
  const plain = await mk('Plain');
  await resetBusinessDemo(biz, { visitorId: vid });
  assert.ok(store.getBooking(invoiced.id), 'sent-but-unpaid invoice: kept');
  assert.ok(store.getBooking(ordered.id), 'open PayPal order: kept');
  assert.ok(!store.getBooking(plain.id), 'nothing open in PayPal: cleared');
});

// ---------- 10. payouts on a keyed server ----------
test('keyed server: no payout email means no payout and an honest message; with one, PayPal Payouts is called', async () => {
  const b = await paidWithMandate('NoEmail', 0, { hold: false });
  await B.markCompleted(b.id);
  const bal = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  await pay(bal.id);
  const before = calls.filter((c) => c.path === '/v1/payments/payouts').length;
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'paid_in_full');
  await new Promise((r) => setTimeout(r, 120));
  const pb = store.getBooking(b.id);
  assert.equal(pb.payout.status, 'no_payout_email');
  assert.ok(!store.listActivity().some((a) => a.bookingId === b.id && /on its way/.test(a.text)), 'never says money is on its way');
  assert.ok(store.listActivity().some((a) => a.bookingId === b.id && /no PayPal payout email/.test(a.text)));
  assert.equal(calls.filter((c) => c.path === '/v1/payments/payouts').length, before);
  // The owner adds a payout email: the next try sends it.
  store.saveBusiness({ ...biz, id: 'cleaning-copy' });
  store.updateBooking(b.id, { presetId: 'cleaning-copy' });
  store.saveBusiness({ id: 'cleaning-copy', payoutEmail: 'owner@example.com' });
  const sent = await B.payoutForBooking(b.id);
  assert.equal(sent.payout.email, 'owner@example.com');
  assert.ok(calls.filter((c) => c.path === '/v1/payments/payouts').length > before);
});
