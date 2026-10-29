// The PayPal REST calls the new money features make, checked against a fake PayPal (no network, fake keys):
// AUTHORIZE orders and the authorize/capture/void calls for deposit holds, saving the wallet with consent and paying
// from it inside the limit, Invoicing v2 for "email me an invoice", and Disputes provide-evidence.
// (Its own file: PayPal keys are read when the app loads.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-pp-requests-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.META_API_KEY = '';

// ---------- a fake PayPal ----------
const calls = [];
const orders = new Map();
let n = 0;
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || 'GET';
  let body = null;
  if (init.body instanceof FormData) body = init.body;
  else if (typeof init.body === 'string' && init.body) body = init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
  calls.push({ method, path: u.pathname, body, headers: init.headers || {} });
  const p = u.pathname;
  if (p === '/v1/oauth2/token') return json({ access_token: 'tok', expires_in: 3600 });
  if (p === '/v2/checkout/orders' && method === 'POST') {
    const id = `ORDER-${++n}`;
    if (body.payment_source?.paypal?.vault_id) {
      const amt = body.purchase_units[0].amount.value;
      return json({ id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP-VAULT-${n}`, status: 'COMPLETED', amount: { value: amt }, seller_receivable_breakdown: { paypal_fee: { value: '1.10' }, net_amount: { value: String(Number(amt) - 1.1) } } }] } }] });
    }
    orders.set(id, body);
    return json({ id, status: 'CREATED', links: [{ rel: 'approve', href: `https://sandbox.paypal.test/checkoutnow?token=${id}` }] }, 201);
  }
  let m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
  if (m && method === 'GET') return json({ id: m[1], intent: orders.get(m[1])?.intent, status: 'APPROVED' });
  m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/);
  if (m) {
    const vault = orders.get(m[1])?.payment_source?.paypal?.attributes?.vault;
    return json({
      id: m[1],
      status: 'COMPLETED',
      ...(vault ? { payment_source: { paypal: { attributes: { vault: { id: 'VAULT-1', status: 'VAULTED', customer: { id: 'CUST-1' } } } } } } : {}),
      purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${m[1]}`, status: 'CREATED', amount: { value: '50.00' }, expiration_time: '2026-11-26T00:00:00Z' }] } }],
    }, 201);
  }
  m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/);
  if (m) return json({ id: `CAP-${m[1]}`, status: 'COMPLETED', seller_receivable_breakdown: { paypal_fee: { value: '2.04' }, net_amount: { value: '47.96' } } }, 201);
  m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/);
  if (m) return new Response(null, { status: 204 });
  if (p === '/v2/invoicing/invoices' && method === 'POST') return json({ id: 'INV2-TEST-0001' }, 201);
  if (p === '/v2/invoicing/invoices/INV2-TEST-0001/send') return json({ href: 'https://sandbox.paypal.test/invoice/p/#INV2-TEST-0001' });
  if (p === '/v2/invoicing/invoices/INV2-TEST-0001/cancel') return new Response(null, { status: 204 });
  if (p === '/v1/customer/disputes/PP-D-1') return json({ dispute_id: 'PP-D-1', status: 'WAITING_FOR_SELLER_RESPONSE', links: [{ rel: 'provide_evidence', href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence', method: 'POST' }] });
  if (p === '/v1/customer/disputes/PP-D-1/provide-evidence') return json({ links: [{ rel: 'self', href: 'x' }] });
  if (p === '/v1/payments/payouts') return json({ batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } }, 201);
  return json({ name: 'NOT_FOUND', path: p }, 404);
};
after(() => {
  globalThis.fetch = realFetch;
});

const { paypalReady } = await import('../src/config.js');
const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const biz = B.businessById('cleaning');
const last = (re) => [...calls].reverse().find((c) => re.test(`${c.method} ${c.path}`));

// An agent-booked booking whose deposit can be a hold.
async function agentBooking(name) {
  const slot = B.availableSlots(biz, { limit: 60, days: 14 }).find((s) => B.intentFor({ slotStart: s.start, presetId: 'cleaning' }, { kind: 'deposit' }) === 'authorize');
  const lead = store.createLead({ presetId: 'cleaning' });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: name });
  store.updateBooking(booking.id, { source: 'agent', bookedBy: 'Claude' });
  return store.getBooking(booking.id);
}

test('deposit hold + mandate: AUTHORIZE order with vault consent, authorize, capture on the bill, pay from the vault', async () => {
  assert.ok(paypalReady);
  store.resetAll();
  const b = await agentBooking('Sarah Kim');
  const dep = b.payments[0];
  const co = await B.checkoutFor(dep.id, { mandate: { limit: 260 } });
  assert.match(co.orderId, /^ORDER-/);
  const create = last(/POST \/v2\/checkout\/orders$/);
  assert.equal(create.body.intent, 'AUTHORIZE');
  assert.equal(create.body.purchase_units[0].custom_id, `${b.id}:${dep.id}`);
  assert.equal(create.body.purchase_units[0].amount.value, '50.00');
  assert.deepEqual(create.body.payment_source.paypal.attributes.vault, { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' });
  assert.ok(create.body.payment_source.paypal.experience_context.return_url);
  assert.ok(create.headers['PayPal-Request-Id']);

  // The buyer approves; the app authorizes (a hold), and PayPal returns the saved wallet.
  await B.syncPayment(dep.id, { orderId: co.orderId });
  assert.ok(last(new RegExp(`POST /v2/checkout/orders/${co.orderId}/authorize$`)));
  assert.ok(!calls.some((c) => c.path === `/v2/checkout/orders/${co.orderId}/capture`), 'a hold is never captured on approval');
  let nb = store.getBooking(b.id);
  assert.equal(nb.status, 'confirmed');
  assert.equal(nb.payments[0].hold.authorizationId, `AUTH-${co.orderId}`);
  assert.equal(nb.payments[0].hold.expiresAt, '2026-11-26T00:00:00Z');
  assert.deepEqual({ vault: nb.mandate.vaultId, customer: nb.mandate.customerId, limit: nb.mandate.limit, status: nb.mandate.status }, { vault: 'VAULT-1', customer: 'CUST-1', limit: 260, status: 'active' });

  // Job done: the hold is captured for the deposit amount, final.
  const done = await B.markCompleted(b.id);
  const cap = last(/POST \/v2\/payments\/authorizations\/.+\/capture$/);
  assert.equal(cap.path, `/v2/payments/authorizations/AUTH-${co.orderId}/capture`);
  assert.deepEqual(cap.body, { final_capture: true, amount: { currency_code: 'USD', value: '50.00' }, note_to_payer: 'Applied to the final bill' });
  nb = store.getBooking(b.id);
  assert.equal(nb.payments[0].captureId, `CAP-AUTH-${co.orderId}`);
  assert.equal(nb.payments[0].fee, 2.04);
  assert.equal(done.due, 210);

  // The assistant pays the bill + tip from the saved wallet, inside the limit.
  const r = await B.payWithMandate(b.id, { tip: 20, agent: 'Claude' });
  assert.equal(r.paid, true);
  const vault = last(/POST \/v2\/checkout\/orders$/);
  assert.deepEqual(vault.body.payment_source, { paypal: { vault_id: 'VAULT-1' } });
  assert.equal(vault.body.intent, 'CAPTURE');
  assert.equal(vault.body.purchase_units[0].amount.value, '230.00');
  assert.equal(vault.body.purchase_units[0].items[1].unit_amount.value, '20.00', 'the tip is its own line');
  nb = store.getBooking(b.id);
  assert.equal(nb.status, 'paid_in_full');
  assert.match(nb.payments.find((p) => p.kind === 'balance').captureId, /^CAP-VAULT-/);
  assert.equal(nb.mandate.spent, 230);

  // A second attempt over what is left calls nothing at PayPal.
  const before = calls.length;
  const again = await B.payWithMandate(b.id, { tip: 5 });
  assert.equal(again.paid, false);
  assert.equal(calls.length, before);
});

test('a free cancel voids the authorization; a later job is a plain CAPTURE order', async () => {
  store.resetAll();
  const b = await agentBooking('Ana');
  const co = await B.checkoutFor(b.payments[0].id, {});
  assert.equal(last(/POST \/v2\/checkout\/orders$/).body.payment_source, undefined, 'no mandate, buttons mode: the buttons pick the funding source');
  await B.syncPayment(b.payments[0].id, { orderId: co.orderId });
  const r = await B.customerCancel(b.id, { notify: false });
  assert.equal(r.outcome, 'refunded');
  assert.ok(last(new RegExp(`POST /v2/payments/authorizations/AUTH-${co.orderId}/void$`)));
  assert.equal(r.reference, `VOID-AUTH-${co.orderId}`);
  assert.ok(!calls.some((c) => /\/refund$/.test(c.path)), 'nothing to refund: it was never charged');

  const slot = B.availableSlots(biz, { limit: 80, days: 14 }).find((s) => B.intentFor({ slotStart: s.start, presetId: 'cleaning' }, { kind: 'deposit' }) === 'capture');
  const lead = store.createLead({ presetId: 'cleaning' });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: 'Lena' });
  await B.checkoutFor(booking.payments[0].id, {});
  assert.equal(last(/POST \/v2\/checkout\/orders$/).body.intent, 'CAPTURE');
});

test('"email me an invoice" creates and sends an Invoicing v2 invoice; INVOICING.INVOICE.PAID confirms the booking', async () => {
  store.resetAll();
  const b = await agentBooking('Dana Cole');
  const r = await B.emailDepositInvoice(b.id, { email: 'dana@example.com' });
  assert.match(r.message, /PayPal just emailed a \$50 deposit invoice to dana@example\.com/);
  const create = last(/POST \/v2\/invoicing\/invoices$/);
  assert.equal(create.body.primary_recipients[0].billing_info.email_address, 'dana@example.com');
  assert.equal(create.body.items[0].unit_amount.value, '50.00');
  assert.equal(create.body.detail.reference, b.id);
  assert.deepEqual(last(/POST \/v2\/invoicing\/invoices\/INV2-TEST-0001\/send$/).body, { send_to_invoicer: false, send_to_recipient: true });
  await B.handlePayPalEvent({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-TEST-0001', payments: { transactions: [{ payment_id: 'TXN-INV-1' }] } } } });
  const nb = store.getBooking(b.id);
  assert.equal(nb.status, 'confirmed');
  assert.equal(nb.payments[0].via, 'PayPal invoice');
  assert.equal(nb.payments[0].captureId, 'TXN-INV-1');
  assert.ok(!calls.some((c) => c.path.endsWith('/INV2-TEST-0001/cancel')), 'the invoice that was paid is not canceled');
});

test('CUSTOMER.DISPUTE.CREATED: the evidence file is sent with provide-evidence as multipart (input JSON + PDF)', async () => {
  store.resetAll();
  const b = await agentBooking('Sarah Kim');
  const co = await B.checkoutFor(b.payments[0].id, { mandate: { limit: 300 } });
  await B.syncPayment(b.payments[0].id, { orderId: co.orderId });
  await B.markCompleted(b.id);
  await B.payWithMandate(b.id, { tip: 0 });
  const capId = store.getBooking(b.id).payments.find((p) => p.kind === 'balance').captureId;
  await B.handlePayPalEvent({ event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dispute_amount: { value: '210.00' }, disputed_transactions: [{ seller_transaction_id: capId }] } });
  const ev = last(/POST \/v1\/customer\/disputes\/PP-D-1\/provide-evidence$/);
  assert.ok(ev, 'evidence was sent');
  assert.ok(ev.body instanceof FormData);
  assert.equal(ev.headers['Content-Type'], undefined, 'the form sets its own multipart content type');
  const input = JSON.parse(await ev.body.get('input').text());
  assert.equal(input.evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.match(input.evidences[0].notes, /Sarah Kim booked Deep clean/);
  const file = ev.body.get('evidence-file');
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.name, `booking-${b.id}.pdf`);
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const nb = store.getBooking(b.id);
  assert.equal(nb.disputes[0].status, 'evidence_sent');
  assert.match(store.listActivity()[0].text, /^The AI defended your chargeback: Sarah Kim opened a PayPal dispute/);
});
