// Minimal PayPal REST client: Orders v2 (capture, authorize, vault), Payments v2 (authorizations, refunds),
// Invoicing v2, Payouts, Disputes (evidence) and webhook verification.
// Uses the sandbox by default. No SDK needed: plain fetch.
import crypto from 'node:crypto';
import { config, paypalApiBase } from './config.js';

let fetchImpl = (...args) => fetch(...args);
export function _setFetch(fn) {
  fetchImpl = fn;
  token = { value: null, expiresAt: 0 };
}

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let token = { value: null, expiresAt: 0 };

async function accessToken() {
  if (token.value && Date.now() < token.expiresAt - 60_000) return token.value;
  const { clientId, clientSecret } = config.paypal;
  if (!clientId || !clientSecret) throw new PayPalError('PayPal keys are not set (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).', 0);
  const res = await fetchImpl(`${paypalApiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError('Could not get a PayPal access token.', res.status, data);
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 300) * 1000 };
  return token.value;
}

async function api(pathname, { method = 'GET', body, rawBody, form, idempotencyKey, headers = {} } = {}) {
  const t = await accessToken();
  const res = await fetchImpl(`${paypalApiBase}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      // A multipart form sets its own Content-Type (with the boundary).
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      Prefer: 'return=representation',
      ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {}),
      ...headers,
    },
    body: form || (rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const issue = data?.details?.[0]?.issue || data?.name || 'PAYPAL_ERROR';
    throw new PayPalError(`PayPal ${method} ${pathname} failed: ${issue}`, res.status, data);
  }
  return data;
}

const money = (amount, currency = 'USD') => ({ currency_code: currency, value: Number(amount).toFixed(2) });

// ---------------- Orders: deposit, balance and tip checkout ----------------
// One PayPal order per payment row. custom_id = "<bookingId>:<paymentId>" so webhooks map back.
//   intent   'CAPTURE' (money moves on approval) or 'AUTHORIZE' (a deposit hold, captured or voided later).
//   vault    true: save the buyer's PayPal wallet on success (the mandate for their assistant, with consent).
//   vaultId  a saved wallet: the order is paid from it without the buyer present (within their limit).
function orderBody({ bookingId, paymentId, amount, tip = 0, description, brandName, softDescriptor, returnUrl, cancelUrl, currency = 'USD', redirect = true, intent = 'CAPTURE', vault = false, vaultId = null }) {
  const total = Number(amount) + Number(tip || 0);
  const unit = {
    reference_id: paymentId,
    custom_id: `${bookingId}:${paymentId}`,
    description: String(description || 'Booking payment').slice(0, 127),
    amount: money(total, currency),
  };
  if (tip > 0) {
    // Show the tip as its own line on the PayPal page. item_total must equal the order total.
    unit.amount.breakdown = { item_total: money(total, currency) };
    unit.items = [
      { name: String(description || 'Service').slice(0, 127), quantity: '1', unit_amount: money(amount, currency), category: 'DIGITAL_GOODS' },
      { name: 'Tip for the crew', quantity: '1', unit_amount: money(tip, currency), category: 'DIGITAL_GOODS' },
    ];
  }
  if (softDescriptor) unit.soft_descriptor = String(softDescriptor).replace(/[^A-Za-z0-9 .\-*]/g, '').slice(0, 22);
  const body = { intent, purchase_units: [unit] };
  if (vaultId) {
    body.payment_source = { paypal: { vault_id: vaultId } };
  } else if (redirect || vault) {
    // Buttons on our payment page pick the funding source (PayPal, Venmo, Pay Later, card) themselves, so a plain
    // order is left open. The redirect fallback, and saving the wallet, name PayPal as the source.
    body.payment_source = {
      paypal: {
        experience_context: {
          brand_name: String(brandName || 'First Answer').slice(0, 127),
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
        ...(vault ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } } } : {}),
      },
    };
  }
  return { body, total };
}

export async function createOrder(opts) {
  const { body, total } = orderBody(opts);
  const order = await api('/v2/checkout/orders', {
    method: 'POST',
    idempotencyKey: `order-${opts.paymentId}-${total.toFixed(2)}-${opts.redirect === false ? 'b' : 'r'}-${Date.now()}`,
    body,
  });
  const payLink = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  return { orderId: order.id, status: order.status, payLink };
}

// Back-compat name used in early code.
export const createDepositOrder = ({ bookingId, amount, description, brandName, returnUrl, cancelUrl }) =>
  createOrder({ bookingId, paymentId: `${bookingId}-dep`, amount, description, brandName, returnUrl, cancelUrl });

export async function getOrder(orderId) {
  return api(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

// The saved wallet, when the buyer agreed to save it: payment_source.paypal.attributes.vault.
export function vaultFrom(data) {
  const v = data?.payment_source?.paypal?.attributes?.vault;
  return v ? { id: v.id || null, status: v.status || null, customerId: v.customer?.id || null } : null;
}

function payerOf(data) {
  return {
    payerEmail: data?.payer?.email_address || null,
    payerName: [data?.payer?.name?.given_name, data?.payer?.name?.surname].filter(Boolean).join(' ') || null,
  };
}

function captureFrom(data) {
  const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
  const breakdown = capture?.seller_receivable_breakdown || {};
  return {
    status: data.status,
    captureId: capture?.id || null,
    captureStatus: capture?.status || null,
    amount: capture?.amount?.value ? Number(capture.amount.value) : null,
    fee: breakdown.paypal_fee?.value ? Number(breakdown.paypal_fee.value) : null,
    net: breakdown.net_amount?.value ? Number(breakdown.net_amount.value) : null,
    vault: vaultFrom(data),
    ...payerOf(data),
  };
}

export async function captureOrder(orderId) {
  const data = await api(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    idempotencyKey: `capture-${orderId}`,
    rawBody: '{}',
  });
  return captureFrom(data);
}

// ---------------- Authorizations: the deposit as a hold ----------------
// An AUTHORIZE order the buyer approved becomes an authorization: the money is held on their account, not taken.
// PayPal honors it for 3 days and it stays valid up to 29; captured on a no-show or the final bill, voided on a free cancel.
export async function authorizeOrder(orderId) {
  const data = await api(`/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
    method: 'POST',
    idempotencyKey: `authorize-${orderId}`,
    rawBody: '{}',
  });
  return authorizationFrom(data);
}

export function authorizationFrom(data) {
  const auth = data?.purchase_units?.[0]?.payments?.authorizations?.[0];
  return {
    status: data?.status || null,
    authorizationId: auth?.id || null,
    authStatus: auth?.status || null,
    amount: auth?.amount?.value ? Number(auth.amount.value) : null,
    expirationTime: auth?.expiration_time || null,
    vault: vaultFrom(data),
    ...payerOf(data),
  };
}

export async function captureAuthorization(authorizationId, { amount, currency = 'USD', finalCapture = true, note } = {}) {
  const body = { final_capture: Boolean(finalCapture) };
  if (amount !== undefined && amount !== null) body.amount = money(amount, currency);
  if (note) body.note_to_payer = String(note).slice(0, 255);
  const data = await api(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
    method: 'POST',
    idempotencyKey: `capture-auth-${authorizationId}-${amount ?? 'full'}`,
    body,
  });
  const breakdown = data.seller_receivable_breakdown || {};
  return {
    captureId: data.id || null,
    status: data.status || null,
    fee: breakdown.paypal_fee?.value ? Number(breakdown.paypal_fee.value) : null,
    net: breakdown.net_amount?.value ? Number(breakdown.net_amount.value) : null,
  };
}

export async function voidAuthorization(authorizationId) {
  await api(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, {
    method: 'POST',
    idempotencyKey: `void-${authorizationId}`,
  });
  return { ok: true, status: 'VOIDED' };
}

// ---------------- Paying from a saved wallet (the assistant, within the human's limit) ----------------
// A CAPTURE order with payment_source.paypal.vault_id. PayPal may complete it on creation; if it comes back
// approved instead, it is captured right away.
export async function chargeVault(opts) {
  const { body, total } = orderBody({ ...opts, intent: 'CAPTURE', vaultId: opts.vaultId, redirect: false });
  const data = await api('/v2/checkout/orders', {
    method: 'POST',
    idempotencyKey: `vault-charge-${opts.paymentId}-${total.toFixed(2)}`,
    body,
  });
  if (data.status === 'COMPLETED') return { orderId: data.id, ...captureFrom(data) };
  if (data.status === 'APPROVED' || data.status === 'CREATED') return { orderId: data.id, ...(await captureOrder(data.id)) };
  return { orderId: data.id, status: data.status, captureId: null, captureStatus: null };
}

export async function refundCapture(captureId, { amount, currency = 'USD', note } = {}) {
  const body = {};
  if (amount) body.amount = money(amount, currency);
  if (note) body.note_to_payer = String(note).slice(0, 255);
  const data = await api(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    idempotencyKey: `refund-${captureId}-${amount || 'full'}`,
    body,
  });
  return { refundId: data.id, status: data.status };
}

// ---------------- Invoicing: deposit by email, reminders, cancel ----------------
export async function createAndSendDepositInvoice({ bookingId, requestKey = bookingId, amount, itemName, customerName, customerEmail, businessName, note, currency = 'USD' }) {
  const [given, ...rest] = String(customerName || 'Customer').trim().split(/\s+/);
  const draft = await api('/v2/invoicing/invoices', {
    method: 'POST',
    idempotencyKey: `invoice-${requestKey}-${customerEmail}`,
    body: {
      detail: {
        currency_code: currency,
        invoice_number: `${bookingId}-${Date.now().toString().slice(-6)}`,
        reference: bookingId,
        note: note || 'Deposit to hold your appointment. It is applied to your final bill.',
        payment_term: { term_type: 'DUE_ON_RECEIPT' },
      },
      invoicer: { business_name: businessName || 'First Answer' },
      primary_recipients: [
        {
          billing_info: {
            name: { given_name: given || 'Customer', surname: rest.join(' ') || undefined },
            email_address: customerEmail,
          },
        },
      ],
      items: [{ name: String(itemName || 'Booking deposit').slice(0, 200), quantity: '1', unit_amount: money(amount, currency) }],
    },
  });
  const invoiceId = draft.id || String(draft.href || '').split('/').pop();
  const sent = await api(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
    method: 'POST',
    idempotencyKey: `invoice-send-${invoiceId}`,
    body: { send_to_invoicer: false, send_to_recipient: true },
  });
  const payLink = sent.href || (sent.links || []).find((l) => /payer/i.test(l.rel))?.href || null;
  return { invoiceId, payLink };
}

export async function getInvoice(invoiceId) {
  return api(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
}

export async function remindInvoice(invoiceId, { subject, note } = {}) {
  await api(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, {
    method: 'POST',
    idempotencyKey: `remind-${invoiceId}-${crypto.randomUUID()}`,
    body: { subject: subject || 'Reminder: your deposit', note: note || '', send_to_invoicer: false, send_to_recipient: true },
  });
  return { ok: true };
}

export async function cancelInvoice(invoiceId, { subject, note } = {}) {
  await api(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`, {
    method: 'POST',
    body: { subject: subject || 'Invoice canceled', note: note || '', send_to_invoicer: false, send_to_recipient: true },
  });
  return { ok: true };
}

// ---------------- Payouts: the business gets its money when the job is done ----------------
// First Answer collects on the platform account; Payouts sends the net to the owner's PayPal email.
export async function sendPayout({ bookingId, amount, email, note, currency = 'USD' }) {
  const data = await api('/v1/payments/payouts', {
    method: 'POST',
    idempotencyKey: `payout-${bookingId}-${Number(amount).toFixed(2)}`,
    body: {
      sender_batch_header: {
        sender_batch_id: `${bookingId}-${Date.now().toString(36)}`,
        email_subject: 'You have been paid for a completed job',
        email_message: String(note || 'Payment for a completed booking.').slice(0, 1000),
      },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: email,
          amount: money(amount, currency),
          note: String(note || '').slice(0, 4000),
          sender_item_id: bookingId,
          notification_language: 'en-US',
        },
      ],
    },
  });
  return { batchId: data.batch_header?.payout_batch_id || null, status: data.batch_header?.batch_status || null };
}

// ---------------- Disputes: send the evidence file ----------------
export async function getDispute(disputeId) {
  return api(`/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
}

// POST /v1/customer/disputes/{id}/provide-evidence as multipart/form-data: an "input" JSON part with the
// evidences array and the evidence file. PayPal only accepts it while the dispute shows a provide-evidence link.
export async function provideEvidence(disputeId, { evidenceType = 'OTHER', notes = '', file }) {
  const form = new FormData();
  const input = { evidences: [{ evidence_type: evidenceType, notes: String(notes).slice(0, 2000) }] };
  form.append('input', new Blob([JSON.stringify(input)], { type: 'application/json' }));
  if (file) form.append('evidence-file', new Blob([file.data], { type: file.type || 'application/pdf' }), file.name || 'evidence.pdf');
  const data = await api(`/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, { method: 'POST', form });
  return { ok: true, links: data.links || [] };
}

// ---------------- Webhooks ----------------
// PayPal recommends verifying with the exact body it sent, so the raw string is spliced in as-is.
export async function verifyWebhook(headers, rawBody) {
  if (!config.paypal.webhookId) return { verified: false, reason: 'PAYPAL_WEBHOOK_ID not set' };
  const h = (k) => headers[k] || headers[k.toLowerCase()] || '';
  const payload =
    '{' +
    `"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},` +
    `"cert_url":${JSON.stringify(h('paypal-cert-url'))},` +
    `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},` +
    `"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},` +
    `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},` +
    `"webhook_id":${JSON.stringify(config.paypal.webhookId)},` +
    `"webhook_event":${rawBody}` +
    '}';
  const data = await api('/v1/notifications/verify-webhook-signature', { method: 'POST', rawBody: payload });
  return { verified: data.verification_status === 'SUCCESS', reason: data.verification_status };
}
