// The shared booking record and every money move around it.
// Customer AI, owner AI, dashboard buttons and PayPal webhooks all go through here,
// so the calendar and the money can never disagree.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { presets, depositFor, priceFor } from './business.js';
import * as store from './store.js';
import * as paypal from './paypal.js';
import { config, paypalReady } from './config.js';
import { openSlots, isSlotOpen, formatSlot } from './slots.js';
import { cachedBusy } from './busy.js';
import { textPdf } from './pdf.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sum = (arr) => round2(arr.reduce((a, b) => a + Number(b || 0), 0));
export const usd = (n) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`;

// Deposit holds. PayPal honors an authorization for 3 days (valid up to 29, but funds are only reliably there in the
// honor period). So a deposit is authorized (held, not charged) only when the job and its final bill fit inside that
// window: the job must end at least BILL_MARGIN_HOURS before the honor period does. Anything later is captured at
// booking, as before. A hold whose honor period is about to end on an active booking is captured then.
export const HONOR_HOURS = 72;
export const BILL_MARGIN_HOURS = 6;
const HOUR = 3600 * 1000;

// A canceled, refunded or no-show booking is closed: its links take no money and nothing is owed on it.
const CLOSED = ['canceled', 'refunded', 'no_show'];

export const STATUS_WORDS = {
  held: 'Held, waiting on the deposit',
  confirmed: 'Confirmed',
  completed: 'Job done, balance due',
  paid_in_full: 'Paid in full',
  needs_rebook: 'Waiting on the customer to pick a new time or a refund',
  canceled: 'Canceled',
  refunded: 'Canceled and refunded',
  no_show: 'No-show (deposit kept per policy)',
};

// ---------------- one money move at a time per booking ----------------
// Two calls that move money on the same booking (two pay_balance calls racing, the customer paying the link while
// the assistant pays from the saved wallet) run one after the other, never interleaved across an await.
const bookingLocks = new Map();
export function withBookingLock(bookingId, fn) {
  const prev = bookingLocks.get(bookingId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  bookingLocks.set(bookingId, tail);
  tail.then(() => {
    if (bookingLocks.get(bookingId) === tail) bookingLocks.delete(bookingId);
  });
  return run;
}

// ---------------- lookups ----------------
// A business is either a built-in demo preset or one an owner set up (stored in the data file).
export function businessById(id) {
  return presets[id] || store.getBusiness(id) || null;
}
export function listAllBusinesses() {
  return [...Object.values(presets), ...store.listBusinesses()];
}
// The owner page works on one business at a time (the saved setting). A request can be pinned to another
// business with withBusiness(), e.g. a visitor without the owner key of a set-up business gets the demo one.
const businessScope = new AsyncLocalStorage();
export function withBusiness(business, fn) {
  return businessScope.run(business, fn);
}
export function currentBusiness() {
  return businessScope.getStore() || businessById(store.getSettings().presetId) || presets.cleaning;
}
// True when the booking belongs to that business id (or no id is given).
const ofBusiness = (presetId) => (b) => !presetId || businessOf(b).id === presetId;
export function businessOf(x) {
  return (x && businessById(x.presetId)) || currentBusiness();
}
// The owner AI works only on the business it is running for, the same one the owner page shows. A demo
// business's office manager never touches another demo business's customers, and a business set up at /setup
// is never touched from another business's owner page.
export function ownerCanTouch(booking, current = currentBusiness()) {
  return Boolean(current) && businessOf(booking)?.id === current.id;
}
export function availableSlots(business, opts = {}) {
  return openSlots(business, store.listBookings(), { busy: cachedBusy(business), ...opts });
}
function slotOpen(business, bookings, iso) {
  return isSlotOpen(business, bookings, iso, { busy: cachedBusy(business) });
}
export function quote(business, serviceId, size) {
  const q = priceFor(business, serviceId, size);
  if (!q) return null;
  return { serviceId: q.service.id, service: q.service.name, size: q.size, price: q.price, deposit: depositFor(business, q.price) };
}
export function activeBookingForLead(leadId) {
  return store
    .listBookings()
    .find((b) => b.leadId === leadId && ['held', 'confirmed', 'completed', 'needs_rebook'].includes(b.status)) || null;
}
export function latestBookingForLead(leadId) {
  return store.listBookings().find((b) => b.leadId === leadId) || null;
}
export function findBookingsByName(name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return [];
  return store.listBookings().filter((b) => (b.customerName || '').toLowerCase().includes(q));
}

// ---------------- money math ----------------
export function totals(booking) {
  const approved = sum(booking.changes.filter((c) => c.status === 'approved').map((c) => c.amount));
  const total = round2(booking.price + approved);
  const done = booking.payments.filter((p) => p.status === 'completed' || p.status === 'refunded');
  const paidGross = sum(done.filter((p) => p.kind !== 'tip').map((p) => p.amount));
  const tipsGross = sum(done.map((p) => p.tip || 0));
  const tipsRefunded = sum(booking.payments.map((p) => p.refund?.tip || 0));
  const refunded = sum(booking.payments.map((p) => p.refund?.amount || 0));
  const paid = round2(paidGross - refunded);
  // A canceled, refunded or no-show booking is closed: nothing more is owed on it.
  const due = CLOSED.includes(booking.status) ? 0 : Math.max(0, round2(total - paid));
  const depositPaid = sum(done.filter((p) => p.kind === 'deposit').map((p) => p.amount)) - sum(booking.payments.filter((p) => p.kind === 'deposit').map((p) => p.refund?.amount || 0));
  // onHold: deposits the customer approved that are authorized on their PayPal but not captured yet. They count
  // toward the bill (paid) like any deposit; they are just not in the business's account yet.
  const onHold = sum(booking.payments.filter((p) => p.status === 'completed' && p.hold?.status === 'authorized').map((p) => p.amount - (p.refund?.amount || 0)));
  // tips: tips the crew keeps (net of any tip refunded). refunded: job money refunded; tipsRefunded: tips refunded.
  return { total, paid, due, tips: round2(tipsGross - tipsRefunded), tipsRefunded, refunded, depositPaid: round2(depositPaid), onHold };
}

// What the customer owes right now: only the deposit while the booking is held, then the balance.
export function owedNow(booking) {
  const t = totals(booking);
  if (booking.status === 'held') return Math.max(0, round2(booking.deposit - t.depositPaid));
  return t.due;
}

// Free to cancel until 24 hours before the job. Last-minute bookings still get an hour to change their mind,
// so nobody is ever shown a free-cancel deadline that has already passed.
export function freeCancelDeadline(slotStart, fromMs = Date.now()) {
  const slot = Date.parse(slotStart);
  const standard = slot - 24 * 3600 * 1000;
  const grace = Math.min(fromMs + 3600 * 1000, slot - 30 * 60 * 1000);
  return new Date(Math.max(standard, grace)).toISOString();
}

export function freeCancelLabel(booking) {
  const tz = businessOf(booking).timezone;
  return formatSlot(booking.freeCancelUntil, tz) + ' ' + tzAbbrev(booking.freeCancelUntil, tz);
}

function tzAbbrev(iso, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName');
  return part ? part.value : '';
}

// The plain-words terms the customer sees before any money moves.
export function termsLine(booking) {
  const t = totals(booking);
  const parts = [`Total ${usd(t.total)}.`];
  if (booking.deposit > 0 && t.depositPaid < booking.deposit) parts.push(`Due now: a ${usd(booking.deposit)} deposit that counts toward the bill.`);
  parts.push(`Balance after the job: ${usd(Math.max(0, t.total - Math.max(t.paid, booking.deposit)))}.`);
  parts.push(`Free to cancel or move until ${freeCancelLabel(booking)}.`);
  return parts.join(' ');
}

// The booking page link carries a view-only key, never the manage key (booking.secret) that can cancel or move.
export function viewKeyOf(booking) {
  if (!booking.viewKey) store.updateBooking(booking.id, { viewKey: crypto.randomBytes(8).toString('hex') });
  return store.getBooking(booking.id)?.viewKey || booking.viewKey;
}
export function bookingPageUrl(booking) {
  return `${config.publicUrl}/b/${booking.id}?k=${viewKeyOf(booking)}`;
}
export function payPageUrl(payment) {
  return `${config.publicUrl}/p/${payment.id}`;
}

// ---------------- deposit holds (authorize now, capture or void later) ----------------
// 'authorize' when this deposit can be a hold: the job ends early enough that the final bill lands inside PayPal's
// 3-day honor period. Every other payment (balances, later jobs) is captured right away.
export function intentFor(booking, payment, now = Date.now()) {
  if (payment?.kind !== 'deposit' || !booking?.slotStart) return 'capture';
  const minutes = businessOf(booking).slotMinutes || 120;
  const jobEnd = Date.parse(booking.slotStart) + minutes * 60000;
  return jobEnd + BILL_MARGIN_HOURS * HOUR <= now + HONOR_HOURS * HOUR ? 'authorize' : 'capture';
}

function holdRecord({ authorizationId, demo = false, expirationTime = null }) {
  const at = Date.now();
  return {
    authorizationId,
    status: 'authorized',
    authorizedAt: new Date(at).toISOString(),
    honorUntil: new Date(at + HONOR_HOURS * HOUR).toISOString(),
    expiresAt: expirationTime || new Date(at + 29 * 24 * HOUR).toISOString(),
    ...(demo ? { demo: true } : {}),
  };
}

// Takes the held deposit (no-show, late cancel, the final bill, or the honor period running out). Returns true when
// the money was captured; false when PayPal refused (the hold is then marked failed and the amount is owed again).
export async function captureHold(paymentId, why = 'Applied to the final bill') {
  const found = store.findPayment(paymentId);
  if (!found) return false;
  const { booking, payment } = found;
  const hold = payment.hold;
  if (!hold || hold.status !== 'authorized') return hold?.status === 'captured';
  const keep = round2(payment.amount - (payment.refund?.amount || 0));
  let cap = { captureId: `DEMO-CAPTURE-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, status: 'COMPLETED', fee: null, net: null };
  if (!hold.demo && paypalReady) {
    try {
      cap = await paypal.captureAuthorization(hold.authorizationId, { amount: keep, finalCapture: true, note: why });
    } catch (err) {
      cap = { status: 'FAILED', error: err.message };
    }
  }
  if (cap.status !== 'COMPLETED' && cap.status !== 'PENDING') {
    store.updatePayment(payment.id, { status: 'failed', hold: { ...hold, status: 'failed', failedAt: new Date().toISOString(), error: cap.error || cap.status } });
    store.addTimeline(booking.id, `Could not capture the ${usd(keep)} deposit hold (${cap.error || cap.status}). It is owed again on the bill.`);
    store.logActivity(`PayPal would not capture ${booking.customerName}'s ${usd(keep)} deposit hold. It was added back to what they owe.`, { bookingId: booking.id, kind: 'hold_failed' });
    return false;
  }
  store.updatePayment(payment.id, { captureId: cap.captureId, fee: cap.fee, net: cap.net, hold: { ...hold, status: 'captured', captureId: cap.captureId, capturedAt: new Date().toISOString(), amount: keep } });
  store.addTimeline(booking.id, `Captured the ${usd(keep)} deposit hold (${why}). PayPal capture ${cap.captureId}${hold.demo ? ' (demo)' : ''}.`);
  return true;
}

async function captureHolds(booking, why) {
  for (const p of booking.payments.filter((x) => x.status === 'completed' && x.hold?.status === 'authorized')) await captureHold(p.id, why);
  return store.getBooking(booking.id);
}

// Releases a held deposit without charging anything (free cancel, the business canceled, a full refund).
async function voidHold(payment) {
  const hold = payment.hold;
  if (!hold || hold.status !== 'authorized') return null;
  let refundId = `DEMO-VOID-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  if (!hold.demo && paypalReady) {
    await paypal.voidAuthorization(hold.authorizationId);
    refundId = `VOID-${hold.authorizationId}`;
  }
  store.updatePayment(payment.id, { hold: { ...hold, status: 'voided', voidedAt: new Date().toISOString() } });
  return refundId;
}

// A hold whose honor period ends soon, on a booking that is still on, is captured before PayPal stops honoring it.
export async function settleExpiringHolds(now = Date.now()) {
  let n = 0;
  for (const b of store.listBookings().filter((x) => ['confirmed', 'completed', 'needs_rebook'].includes(x.status))) {
    for (const p of b.payments.filter((x) => x.status === 'completed' && x.hold?.status === 'authorized')) {
      if (Date.parse(p.hold.honorUntil) - now <= BILL_MARGIN_HOURS * HOUR) {
        await captureHold(p.id, "PayPal's 3-day hold window was ending, so the deposit was captured as a regular deposit");
        n++;
      }
    }
  }
  return n;
}

// ---------------- PayPal links ----------------
async function attachOrder(booking, payment, { tip = 0, redirect = true, mandate = null } = {}) {
  const business = businessOf(booking);
  const intent = intentFor(booking, payment);
  if (!paypalReady) {
    store.updatePayment(payment.id, { mode: 'demo', orderId: null, paypalLink: null, intent });
    return null;
  }
  const what = payment.kind === 'deposit' ? 'Deposit' : payment.kind === 'balance' ? 'Balance' : 'Payment';
  const { orderId, payLink } = await paypal.createOrder({
    bookingId: booking.id,
    paymentId: payment.id,
    amount: payment.amount,
    tip,
    description: `${what}: ${booking.service}, ${booking.slotLabel}`,
    brandName: business.name,
    softDescriptor: business.descriptor || business.name,
    returnUrl: `${config.publicUrl}/pay/return?payment=${payment.id}`,
    cancelUrl: `${config.publicUrl}/pay/cancel?payment=${payment.id}`,
    redirect,
    intent: intent === 'authorize' ? 'AUTHORIZE' : 'CAPTURE',
    vault: Boolean(mandate),
  });
  // Keep every order made for this payment (with its tip, intent and any mandate offered) so a capture can be
  // checked against them and the right next step (capture or authorize) is taken.
  const orders = [...(store.findPayment(payment.id).payment.orders || []), { id: orderId, tip, intent, ...(mandate ? { mandate } : {}) }].slice(-20);
  store.updatePayment(payment.id, { mode: 'paypal', orderId, orders, paypalLink: payLink || null, orderMode: redirect ? 'redirect' : 'buttons', tip, intent, mandateOffer: mandate || null, orderCreatedAt: new Date().toISOString() });
  return payLink;
}

// True when a PayPal order ID was made by this app for this payment (the current one or an earlier one).
export function orderBelongs(payment, orderId) {
  if (!payment || !orderId) return false;
  return payment.orderId === orderId || (payment.orders || []).some((o) => o.id === orderId);
}

// Finds the payment an invoice was sent for, including invoices that a newer one replaced (kept in p.invoices),
// so a late payment on a replaced invoice is never silently dropped.
export function findPaymentByInvoice(invoiceId) {
  if (!invoiceId) return null;
  for (const b of store.listBookings()) {
    const p = b.payments.find((x) => x.invoice?.id === invoiceId || (x.invoices || []).some((i) => i.id === invoiceId));
    if (p) return { booking: b, payment: p, invoice: p.invoice?.id === invoiceId ? p.invoice : p.invoices.find((i) => i.id === invoiceId) };
  }
  return null;
}

export function findPaymentByOrder(orderId) {
  if (!orderId) return null;
  for (const b of store.listBookings()) {
    const p = b.payments.find((x) => orderBelongs(x, orderId));
    if (p) return { booking: b, payment: p };
  }
  return null;
}

// Tips are 0 to $500, rounded to cents. Anything else (negative, text) counts as no tip.
export function clampTip(v) {
  return Math.max(0, Math.min(500, Math.round(Number(v || 0) * 100) / 100)) || 0;
}
// A tip goes on the final bill only. A deposit link never takes one, whatever the page sends.
export function tipFor(payment, v) {
  return payment?.kind === 'balance' ? clampTip(v) : 0;
}

// Why a payment link can't take money right now, in plain words, or null when it can.
// A canceled or refunded booking is closed: its links are dead even if one is somehow still marked pending.
export function notPayable(booking, payment) {
  if (CLOSED.includes(booking?.status)) return `This booking was ${(STATUS_WORDS[booking.status] || booking.status).toLowerCase()}, so there's nothing to pay. Text us anytime to book a new time.`;
  // The business canceled this time: no deposit is taken until the customer picks a new one.
  if (booking?.status === 'needs_rebook' && payment?.kind === 'deposit' && payment.status !== 'completed') return "The business canceled this time, so there's no deposit to pay. Pick a new time in your texts and we'll send a fresh link.";
  if (payment?.status === 'void') return 'This link was replaced or turned off, so nothing is owed on it. Check your texts for the latest link.';
  if (payment && payment.status !== 'pending' && payment.status !== 'completed') return 'This link can no longer take a payment.';
  return null;
}

// Where the short link sends people. Makes a fresh PayPal order if the old one went stale, so links never "expire".
export async function checkoutFor(paymentId, { tip = 0, redirect = false, mandate = null } = {}) {
  const found = store.findPayment(paymentId);
  if (!found) return { error: 'not_found' };
  const { booking, payment } = found;
  if (payment.status === 'completed') return { paid: true, booking, payment };
  const why = notPayable(booking, payment);
  if (why) return { error: why, booking, payment };
  tip = tipFor(payment, tip);
  mandate = mandateOfferFor(booking, payment, mandate);
  if (!paypalReady) return { demo: true, booking, payment };
  const stale = Date.now() - Date.parse(payment.orderCreatedAt || 0) > 2 * 3600 * 1000;
  const wantMode = redirect ? 'redirect' : 'buttons';
  const sameMandate = (payment.mandateOffer?.limit || 0) === (mandate?.limit || 0);
  if (!payment.orderId || stale || payment.orderMode !== wantMode || Number(payment.tip || 0) !== Number(tip || 0) || payment.intent !== intentFor(booking, payment) || !sameMandate) {
    await attachOrder(booking, payment, { tip, redirect, mandate });
  }
  const p = store.findPayment(paymentId).payment;
  return { orderId: p.orderId, url: p.paypalLink, booking, payment: p };
}

// Payment rows are created right away; the PayPal order is made when the customer opens the payment page,
// so links never go stale and no unused orders pile up.
async function newPayment(booking, data) {
  return store.addPayment(booking.id, { mode: paypalReady ? 'paypal' : 'demo', ...data });
}

// A link that can no longer take money: turned off, and any PayPal invoice for it is canceled too.
function voidPayment(p) {
  store.updatePayment(p.id, { status: 'void' });
  return retireInvoice(p, 'This deposit request was replaced or the booking changed, so nothing is owed on this invoice.');
}
// Cancels the payment's open PayPal invoice. It is marked canceled here right away (so the app never treats it as
// payable), and PayPal's cancel is retried; one that still fails stays cancelConfirmed:false and reconcileInvoices()
// retries it later. If the customer pays it anyway in between, the INVOICING.INVOICE.PAID webhook refunds it.
function retireInvoice(p, note) {
  const inv = store.findPayment(p.id)?.payment?.invoice || p?.invoice;
  if (!inv || inv.status !== 'sent') return Promise.resolve(false);
  const local = Boolean(inv.demo || !paypalReady);
  store.updatePayment(p.id, { invoice: { ...inv, status: 'canceled', canceledAt: new Date().toISOString(), cancelNote: note, cancelConfirmed: local } });
  if (local) return Promise.resolve(true);
  return cancelInvoiceWithRetry(p.id, inv.id, note);
}
async function cancelInvoiceWithRetry(paymentId, invoiceId, note, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await paypal.cancelInvoice(invoiceId, { note });
      markInvoice(paymentId, invoiceId, { cancelConfirmed: true, cancelError: null });
      return true;
    } catch (err) {
      markInvoice(paymentId, invoiceId, { cancelError: err.message, cancelTries: i + 1 });
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
  console.error('cancel invoice', invoiceId, 'still failing; will retry');
  return false;
}
function markInvoice(paymentId, invoiceId, patch) {
  const found = store.findPayment(paymentId);
  if (!found) return;
  const p = found.payment;
  if (p.invoice?.id === invoiceId) store.updatePayment(paymentId, { invoice: { ...p.invoice, ...patch } });
  else if ((p.invoices || []).some((i) => i.id === invoiceId)) store.updatePayment(paymentId, { invoices: p.invoices.map((i) => (i.id === invoiceId ? { ...i, ...patch } : i)) });
}
// Background job: invoices this app canceled whose PayPal cancel has not been confirmed yet.
export async function reconcileInvoices() {
  let n = 0;
  if (!paypalReady) return n;
  for (const b of store.listBookings()) {
    for (const p of b.payments) {
      for (const inv of [p.invoice, ...(p.invoices || [])].filter(Boolean)) {
        if (inv.status === 'canceled' && inv.cancelConfirmed === false && !inv.demo) {
          if (await cancelInvoiceWithRetry(p.id, inv.id, inv.cancelNote || 'This invoice is no longer needed.', 1)) n++;
        }
      }
    }
  }
  return n;
}

// "Email me an invoice": the deposit goes out as a PayPal invoice (Invoicing v2) to the customer's email, as
// another way to pay the same deposit. Whichever is paid first counts; the other is turned off.
export async function emailDepositInvoice(bookingId, { email = '' } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const pending = b.payments.find((p) => p.status === 'pending' && p.kind === 'deposit');
  if (b.status !== 'held' || !pending) throw new Error("There's no deposit waiting on this booking, so there's nothing to invoice.");
  const to = String(email || b.customerEmail || '').trim().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(to)) throw new Error('Sure! What email should I send the invoice to?');
  if (pending.invoice?.status === 'sent' && pending.invoice.to === to) return { message: `The invoice is already in ${to}'s inbox. You can also pay right here: ${payPageUrl(pending)}`, invoiceId: pending.invoice.id };
  const business = businessOf(b);
  let invoice;
  if (paypalReady) {
    const r = await paypal.createAndSendDepositInvoice({
      bookingId: b.id,
      requestKey: pending.id,
      amount: pending.amount,
      itemName: `Deposit: ${b.service}${b.size === 'standard' ? '' : ` (${b.size})`}, ${b.slotLabel}`,
      customerName: b.customerName,
      customerEmail: to,
      businessName: business.name,
      note: `${termsLine(b)} Booking ${b.id}.`,
    });
    invoice = { id: r.invoiceId, link: r.payLink, to, status: 'sent', sentAt: new Date().toISOString() };
  } else {
    invoice = { id: `DEMO-INV-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, link: null, to, status: 'sent', demo: true, sentAt: new Date().toISOString() };
  }
  if (pending.invoice) {
    await retireInvoice(pending, 'A new invoice was sent.');
    // Keep the replaced invoice on record, so a late payment on it is still found (and refunded).
    const old = store.findPayment(pending.id).payment;
    store.updatePayment(pending.id, { invoices: [...(old.invoices || []), old.invoice].slice(-10) });
  }
  store.updatePayment(pending.id, { invoice: { ...invoice, amount: pending.amount } });
  store.updateBooking(b.id, { customerEmail: to });
  store.addTimeline(b.id, `Deposit invoice ${invoice.id} for ${usd(pending.amount)} ${invoice.demo ? 'recorded (demo mode: no email sent)' : `sent to ${to} through PayPal Invoicing`}.`);
  store.logActivity(`${invoice.demo ? 'Recorded a demo' : 'Sent a PayPal'} invoice for ${b.customerName}'s ${usd(pending.amount)} deposit${invoice.demo ? '' : ` to ${to}`}.`, { bookingId: b.id, kind: 'invoice' });
  const message = invoice.demo
    ? `Done: invoice ${invoice.id} for the ${usd(pending.amount)} deposit is recorded for ${to}. (This demo server has no PayPal keys, so no email actually goes out; with keys, PayPal emails it.) You can also pay right here: ${payPageUrl(pending)}`
    : `Sent! PayPal just emailed a ${usd(pending.amount)} deposit invoice to ${to}. Pay it there or right here, whichever is easier: ${payPageUrl(pending)}`;
  return { message, invoiceId: invoice.id };
}

// ---------------- booking ----------------
export async function bookAndRequestDeposit({ leadId, serviceId, size, slotStart, customerName, customerEmail }) {
  const lead = store.getLead(leadId);
  if (!lead) throw new Error('Lead not found.');
  const business = businessOf(lead);
  const q = quote(business, serviceId, size);
  if (!q) throw new Error(`Unknown service or size: ${serviceId} / ${size}.`);
  if (!slotOpen(business, store.listBookings(), slotStart)) throw new Error('That time is no longer open. Offer other times.');
  if (activeBookingForLead(leadId)) throw new Error('This customer already has an active booking. Offer to reschedule it instead.');

  store.updateLead(lead.id, { name: customerName || lead.name, email: customerEmail || lead.email, status: 'booked' });
  const booking = store.createBooking({
    leadId: lead.id,
    presetId: business.id,
    customerName: customerName || lead.name || 'Customer',
    customerEmail: customerEmail || lead.email || '',
    customerPhone: lead.phone || '',
    serviceId: q.serviceId,
    service: q.service,
    size: q.size,
    price: q.price,
    deposit: q.deposit,
    slotStart,
    slotLabel: formatSlot(slotStart, business.timezone),
    freeCancelUntil: freeCancelDeadline(slotStart),
    status: q.deposit > 0 ? 'held' : 'confirmed',
  });
  store.addTimeline(booking.id, `Quoted ${q.service}${q.size === 'standard' ? '' : ` (${q.size})`} at ${usd(q.price)} and held ${booking.slotLabel}.`);
  store.addTimeline(booking.id, `Terms shown to customer: ${termsLine(booking)}`);

  if (q.deposit <= 0) {
    store.logActivity(`Booked ${booking.customerName}: ${booking.service} on ${booking.slotLabel} (no deposit needed).`, { bookingId: booking.id });
    return { booking: store.getBooking(booking.id), payLink: null, terms: termsLine(booking) };
  }
  const payment = await newPayment(booking, { kind: 'deposit', amount: q.deposit, label: 'Deposit' });
  store.logActivity(`Booked ${booking.customerName}: ${booking.service}${booking.size === 'standard' ? '' : `, ${booking.size}`} on ${booking.slotLabel}. Sent a ${usd(q.deposit)} PayPal deposit link.`, {
    bookingId: booking.id,
    kind: 'deposit_requested',
  });
  return { booking: store.getBooking(booking.id), payLink: payPageUrl(payment), terms: termsLine(booking) };
}

// ---------------- payment completed (from return page, polling or webhook) ----------------
// hold: set when the deposit was authorized (held on the customer's PayPal) instead of captured.
// mandate: set when the customer also let their assistant pay this booking's final bill up to a limit.
export function completePayment(paymentId, { captureId = null, fee = null, net = null, payerEmail = null, payerName = null, via = 'paypal', tip = null, hold = null, mandate = null } = {}) {
  const found = store.findPayment(paymentId);
  if (!found) return null;
  const { booking, payment } = found;
  if (payment.status === 'completed') return booking; // the redirect and the webhook can both arrive; only count once
  store.updatePayment(paymentId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    captureId,
    fee,
    net,
    payerEmail,
    payerName,
    via,
    ...(hold ? { hold } : {}),
    ...(tip !== null ? { tip } : {}),
  });
  if (hold) store.addTimeline(booking.id, `Deposit held on the customer's PayPal, not charged yet: authorization ${hold.authorizationId}${hold.demo ? ' (demo)' : ''}. It is captured on the final bill or a no-show and released on a free cancel. PayPal honors it until ${formatSlot(hold.honorUntil, businessOf(booking).timezone)}.`);
  if (mandate) grantMandate(booking.id, mandate);
  if (payment.invoice && via !== 'PayPal invoice') retireInvoice(payment, 'This deposit was paid another way, so the invoice is no longer needed.');
  const b = store.getBooking(booking.id);
  const t = totals(b);
  const p = store.findPayment(paymentId).payment;
  const who = payerName && payerName !== b.customerName ? ` (paid by ${payerName})` : '';
  store.addTimeline(b.id, hold ? `${p.label || p.kind} approved: ${usd(p.amount)} via ${via}${who} (held, not charged yet).` : `${p.label || p.kind} paid: ${usd(p.amount)}${p.tip ? ` + ${usd(p.tip)} tip` : ''} via ${via}${who}. PayPal capture ${captureId || 'n/a'}.`);

  if (p.kind === 'deposit') {
    if (b.status === 'held' && t.depositPaid + 0.001 >= b.deposit) {
      store.updateBooking(b.id, { status: 'confirmed', confirmedAt: new Date().toISOString() });
      // The deposit is covered: any other deposit link (a split share, another invoice) can no longer take money.
      b.payments.filter((x) => x.id !== paymentId && x.status === 'pending' && x.kind === 'deposit').forEach(voidPayment);
      const held = hold ? ` It's a hold on your PayPal: you're not charged until the job is done, and a free cancel releases it.` : '';
      store.addMessage(b.leadId, 'assistant', `Got your ${usd(b.deposit)} deposit${who}, thank you! You're confirmed for ${b.service} on ${b.slotLabel}.${held} ${termsLine(store.getBooking(b.id))} Your booking: ${bookingPageUrl(b)}`, { kind: 'confirmation' });
      store.logActivity(`Deposit ${hold ? 'held' : 'paid'}: ${usd(b.deposit)} from ${b.customerName}${who}${hold ? ' (authorized in PayPal, captured on the final bill)' : ''}. ${b.slotLabel} is confirmed.`, { bookingId: b.id, kind: 'deposit_paid' });
    } else if (b.status === 'held') {
      store.addMessage(b.leadId, 'assistant', `Got ${usd(p.amount)}${who} toward the deposit. ${usd(round2(b.deposit - t.depositPaid))} to go and you're confirmed.`, { kind: 'partial' });
      store.logActivity(`Split deposit: ${usd(p.amount)} in for ${b.customerName}${who}.`, { bookingId: b.id });
    }
  } else {
    const after = totals(store.getBooking(b.id));
    if (after.due <= 0.001) {
      store.updateBooking(b.id, { status: 'paid_in_full', paidInFullAt: new Date().toISOString() });
      endMandate(b.id, 'used', 'The booking is paid in full.');
      store.addMessage(
        b.leadId,
        'assistant',
        `Payment received: ${usd(p.amount)}${p.tip ? ` plus a ${usd(p.tip)} tip for the crew (thank you!)` : ''}. You're all paid up. Receipt: ${bookingPageUrl(b)}. If you have a minute, a quick review means the world to a small business.`,
        { kind: 'receipt' },
      );
      store.logActivity(`Paid in full: ${b.customerName}, ${usd(after.total)}${p.tip ? ` + ${usd(p.tip)} tip` : ''}.`, { bookingId: b.id, kind: 'paid_in_full' });
      payoutForBooking(b.id).catch((e) => console.error('payout', e.message));
    } else {
      store.addMessage(b.leadId, 'assistant', `Got ${usd(p.amount)}${who}, thank you. ${usd(after.due)} is still open on this job.`, { kind: 'partial' });
      store.logActivity(`Partial payment: ${usd(p.amount)} from ${b.customerName}${who}. ${usd(after.due)} still due.`, { bookingId: b.id });
    }
  }
  return store.getBooking(b.id);
}

// orderId: the order the buyer just approved (from the PayPal buttons). It must be one this payment made;
// without it, the payment's latest order is checked.
export async function syncPayment(paymentId, opts = {}) {
  const found = store.findPayment(paymentId);
  if (!found) return null;
  return withBookingLock(found.booking.id, () => syncPaymentNow(paymentId, opts));
}
async function syncPaymentNow(paymentId, { orderId = null } = {}) {
  const found = store.findPayment(paymentId);
  if (!found) return null;
  const { payment } = found;
  if (orderId && !orderBelongs(payment, orderId)) throw new Error('That PayPal order is not for this payment.');
  const useOrder = orderId || payment.orderId;
  if (payment.status !== 'pending' || payment.mode !== 'paypal' || !useOrder) return found.booking;
  // Never capture money for a booking that was canceled or refunded while the order sat approved.
  if (notPayable(found.booking, payment)) return found.booking;
  const orderTip = (payment.orders || []).find((o) => o.id === useOrder)?.tip;
  const tip = orderTip === undefined ? null : orderTip;
  const saved = (payment.orders || []).find((o) => o.id === useOrder) || {};
  const order = await paypal.getOrder(useOrder);
  const isAuth = String(order.intent || '').toUpperCase() === 'AUTHORIZE' || saved.intent === 'authorize';
  if (isAuth && (order.status === 'APPROVED' || order.status === 'COMPLETED')) {
    // A deposit hold: authorize the approved order (or read the authorization if it already happened).
    const a = order.status === 'APPROVED' ? await paypal.authorizeOrder(useOrder) : paypal.authorizationFrom(order);
    if (a.authorizationId && ['CREATED', 'PENDING', 'CAPTURED'].includes(a.authStatus || 'CREATED')) {
      return completePayment(paymentId, { payerEmail: a.payerEmail, payerName: a.payerName, hold: holdRecord({ authorizationId: a.authorizationId, expirationTime: a.expirationTime }), mandate: mandateFromVault(saved.mandate, a.vault) });
    }
    if (a.authStatus === 'DENIED') {
      store.updatePayment(paymentId, { lastError: 'declined' });
      store.addMessage(found.booking.leadId, 'assistant', `That payment didn't go through (it was declined). Nothing was held or charged. Here's a fresh link to try again: ${payPageUrl(payment)}`, { kind: 'payment_failed' });
    }
    return store.getBooking(found.booking.id);
  }
  if (order.status === 'APPROVED') {
    const cap = await paypal.captureOrder(useOrder);
    if (cap.captureStatus === 'COMPLETED' || cap.status === 'COMPLETED') {
      return completePayment(paymentId, { captureId: cap.captureId, fee: cap.fee, net: cap.net, payerEmail: cap.payerEmail, payerName: cap.payerName, tip, mandate: mandateFromVault(saved.mandate, cap.vault) });
    }
    if (cap.captureStatus === 'DECLINED') {
      store.updatePayment(paymentId, { lastError: 'declined' });
      store.addMessage(found.booking.leadId, 'assistant', `That payment didn't go through (the bank declined it). Nothing was charged. Here's a fresh link to try another card, Venmo or PayPal: ${payPageUrl(payment)}`, { kind: 'payment_failed' });
    }
  } else if (order.status === 'COMPLETED') {
    const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
    return completePayment(paymentId, { captureId: cap?.id || null, tip });
  }
  return store.getBooking(found.booking.id);
}

// Demo money: the demo checkout (no PayPal keys) and "Load a sample day" (which runs even when keys are set).
// It is saved as demo money, so refunds settle it here without calling PayPal and payouts never send it.
// A deposit that qualifies is held (a simulated authorization) the same way PayPal would hold it.
export function completeDemoPayment(paymentId, { tip = 0, mandate = null } = {}) {
  const found = store.findPayment(paymentId);
  if (!found) return null;
  if (found.payment.status !== 'pending') return found.booking;
  const intent = intentFor(found.booking, found.payment);
  store.updatePayment(paymentId, { mode: 'demo', demo: true, intent });
  const offer = mandateOfferFor(found.booking, found.payment, mandate);
  const demoMandate = offer ? { ...offer, vaultId: `DEMO-VAULT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, status: 'active', demo: true } : null;
  if (intent === 'authorize') {
    return completePayment(paymentId, { via: 'demo checkout', captureId: null, hold: holdRecord({ authorizationId: `DEMO-AUTH-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, demo: true }), mandate: demoMandate });
  }
  return completePayment(paymentId, { via: 'demo checkout', captureId: 'DEMO-' + paymentId, tip: clampTip(tip) || null, mandate: demoMandate });
}
// True for money that never went through PayPal's servers (demo checkout or a sample day).
export const isDemoMoney = (p) => Boolean(p?.demo || p?.mode === 'demo' || p?.hold?.demo || String(p?.captureId || '').startsWith('DEMO-'));

// ---------------- the assistant's spending limit (a mandate the human grants once) ----------------
// At the deposit, a customer whose AI assistant booked can also say "my assistant may pay the rest of this booking,
// up to $X". PayPal saves their wallet with their consent (vault, store_in_vault ON_SUCCESS) and the business's MCP
// pay_balance tool then charges it only while the amount fits inside that limit. Over the limit, the human approves.
export const MANDATE_MAX = 2000;
export function mandateOfferFor(booking, payment, mandate) {
  const limit = round2(Number(mandate?.limit));
  if (!mandate || !Number.isFinite(limit) || limit <= 0) return null;
  if (payment?.kind !== 'deposit' || booking?.source !== 'agent') return null;
  return { limit: Math.min(limit, MANDATE_MAX) };
}
function mandateFromVault(offer, vault) {
  if (!offer) return null;
  if (vault?.id && (vault.status === 'VAULTED' || !vault.status)) return { ...offer, vaultId: vault.id, customerId: vault.customerId || null, status: 'active' };
  // PayPal approved the payment but did not save the wallet yet (or at all): no limit is active, and the assistant
  // will ask the human for the final bill the normal way.
  return { ...offer, vaultId: null, status: 'not_saved', vaultStatus: vault?.status || 'missing' };
}
export function grantMandate(bookingId, m) {
  const b = store.getBooking(bookingId);
  if (!b) return null;
  const mandate = { limit: m.limit, spent: 0, vaultId: m.vaultId || null, customerId: m.customerId || null, status: m.status || 'active', scope: 'This booking only: the final balance and tip.', grantedAt: new Date().toISOString(), ...(m.demo ? { demo: true } : {}) };
  store.updateBooking(b.id, { mandate });
  if (mandate.status === 'active') {
    store.addTimeline(b.id, `${b.customerName} let ${b.bookedBy || 'their AI assistant'} pay this booking's final bill and tip without asking again, up to ${usd(mandate.limit)}. PayPal saved their wallet with consent (vault ${mandate.vaultId}${mandate.demo ? ', demo' : ''}).`);
    store.logActivity(`${b.customerName} pre-approved ${b.bookedBy || 'their assistant'} to pay up to ${usd(mandate.limit)} on this booking.`, { bookingId: b.id, kind: 'mandate' });
  } else {
    store.addTimeline(b.id, `${b.customerName} asked to let their assistant pay up to ${usd(mandate.limit)}, but PayPal did not save the wallet (${m.vaultStatus || 'no vault id'}), so the final bill will need their approval.`);
  }
  return mandate;
}
function endMandate(bookingId, status, why) {
  const b = store.getBooking(bookingId);
  if (!b?.mandate || b.mandate.status !== 'active') return;
  store.updateBooking(b.id, { mandate: { ...b.mandate, status, endedAt: new Date().toISOString(), endedWhy: why } });
}

// The check the MCP pay_balance tool shows in the trace: limit, spent so far, this payment, and the decision.
export function mandateCheck(booking, amount) {
  const m = booking.mandate;
  const active = m && m.status === 'active' && m.vaultId;
  const limit = active ? m.limit : 0;
  const spent = active ? m.spent || 0 : 0;
  const remaining = round2(limit - spent);
  const decision = !active ? 'no_limit_ask_human' : amount <= remaining + 0.001 ? 'within_limit_pay' : 'over_limit_ask_human';
  return { limit, already_spent: spent, this_payment: round2(amount), remaining_before: Math.max(0, remaining), decision, scope: m?.scope || null, simulated: Boolean(m?.demo) };
}

// The assistant pays the final balance (plus an optional tip) from the saved wallet, only inside the limit.
// Serialized per booking: the check and the charge happen together, so racing calls can never spend past the limit.
export async function payWithMandate(bookingId, opts = {}) {
  return withBookingLock(bookingId, () => payWithMandateNow(bookingId, opts));
}
async function payWithMandateNow(bookingId, { tip = 0, agent = 'the assistant' } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const pending = b.payments.find((p) => p.status === 'pending' && p.kind === 'balance');
  if (b.status !== 'completed' || !pending) {
    return { paid: false, reason: b.status === 'confirmed' || b.status === 'held' ? 'job_not_done' : 'nothing_due', check: null };
  }
  tip = clampTip(tip);
  const amount = round2(pending.amount + tip);
  const check = mandateCheck(b, amount);
  if (check.decision !== 'within_limit_pay') {
    store.addTimeline(b.id, `${agent} tried to pay ${usd(amount)} but it is ${check.decision === 'no_limit_ask_human' ? 'not pre-approved' : `over the ${usd(check.limit)} limit (${usd(check.already_spent)} already spent)`}, so the customer was asked to approve it.`);
    return { paid: false, reason: check.decision === 'no_limit_ask_human' ? 'no_mandate' : 'over_limit', check, approvalUrl: payPageUrl(pending), amount };
  }
  const m = b.mandate;
  let result = { captureId: `DEMO-MANDATE-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, captureStatus: 'COMPLETED', fee: null, net: null };
  if (!m.demo && paypalReady && !isDemoMoney(pending)) {
    const business = businessOf(b);
    result = await paypal.chargeVault({ bookingId: b.id, paymentId: pending.id, amount: pending.amount, tip, vaultId: m.vaultId, description: `Balance: ${b.service}, ${b.slotLabel}`, softDescriptor: business.descriptor || business.name });
    if (result.captureStatus !== 'COMPLETED') {
      store.addTimeline(b.id, `${agent} tried to pay ${usd(amount)} from the saved wallet but PayPal returned ${result.captureStatus || result.status}. The customer was asked to pay instead.`);
      return { paid: false, reason: 'paypal_declined', check, approvalUrl: payPageUrl(pending), amount };
    }
  } else {
    store.updatePayment(pending.id, { mode: 'demo', demo: true });
  }
  store.updateBooking(b.id, { mandate: { ...m, spent: round2((m.spent || 0) + amount) } });
  completePayment(pending.id, { captureId: result.captureId, fee: result.fee, net: result.net, tip: tip || null, via: `${agent} (pre-approved limit)` });
  store.addTimeline(b.id, `${agent} paid ${usd(amount)} (${usd(pending.amount)} balance${tip ? ` + ${usd(tip)} tip` : ''}) inside the ${usd(m.limit)} limit ${b.customerName} pre-approved. No new approval needed.${m.demo ? ' (Demo: simulated, no PayPal call.)' : ''}`);
  store.logActivity(`${agent} paid ${b.customerName}'s ${usd(amount)} final bill inside their ${usd(m.limit)} pre-approved limit.`, { bookingId: b.id, kind: 'mandate_paid' });
  return { paid: true, reason: 'within_limit', check, amount, captureId: result.captureId, booking: store.getBooking(b.id) };
}

// ---------------- reminders ----------------
export async function remind(bookingId) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const pending = b.payments.find((p) => p.status === 'pending');
  if (!pending || !['held', 'completed'].includes(b.status)) throw new Error(`${b.customerName} doesn't owe anything right now (${STATUS_WORDS[b.status] || b.status}), so no reminder was sent.`);
  const text =
    b.status === 'held'
      ? `Quick reminder: ${b.slotLabel} is held for you. Tap to pay the ${usd(pending.amount)} deposit and lock it in (card, Venmo, Pay Later or PayPal): ${payPageUrl(pending)}`
      : `Friendly reminder: ${usd(pending.amount)} is still open for your ${b.service} on ${b.slotLabel}. Pay here: ${payPageUrl(pending)}`;
  store.addMessage(b.leadId, 'assistant', text, { kind: 'reminder' });
  // A deposit that also went out as a PayPal invoice gets PayPal's own reminder email too.
  if (pending.invoice?.status === 'sent' && !pending.invoice.demo && paypalReady) await paypal.remindInvoice(pending.invoice.id, { note: text }).catch((e) => console.error('invoice reminder', e.message));
  store.updateBooking(bookingId, { reminders: (b.reminders || 0) + 1, lastReminderAt: new Date().toISOString() });
  store.addTimeline(b.id, `Reminder sent for ${usd(pending.amount)}.`);
  store.logActivity(`Reminder sent to ${b.customerName} for ${usd(pending.amount)}.`, { bookingId, kind: 'reminder' });
  return store.getBooking(bookingId);
}

export function owing({ presetId = null } = {}) {
  return store.listBookings().filter(ofBusiness(presetId)).filter((b) => ['held', 'completed'].includes(b.status) && b.payments.some((p) => p.status === 'pending'));
}

// ---------------- refunds and cancellations ----------------
// A full refund (no amount) sends back everything: what was paid toward the job plus any tip. A partial refund
// (an amount) comes out of the job money only; tips stay with the crew, and the messages say so.
export async function refund(bookingId, { amount = null, reason = '', newStatus = 'refunded', notify = true } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const t = totals(b);
  const full = amount === null || amount === undefined || amount === '';
  if (t.paid <= 0 && !(full && t.tips > 0)) throw new Error(`${b.customerName} hasn't paid anything, so there is nothing to refund.`);
  // Any amount given must be a real number above zero and no more than was paid toward the job.
  const asked = full ? t.paid : Number(amount);
  if (!full && (!Number.isFinite(asked) || asked <= 0)) throw new Error('Enter a refund amount above $0, or leave it empty for a full refund.');
  if (asked > t.paid + 0.001) throw new Error(`${b.customerName} paid ${usd(t.paid)} toward the job, so the most you can refund is ${usd(t.paid)}${t.tips > 0 ? ` (a full refund also returns the ${usd(t.tips)} tip)` : ''}.`);
  let toRefund = round2(asked);
  const refunds = [];
  // Demo money gets one reference for the whole refund, like a single PayPal refund would.
  const demoRef = `DEMO-REFUND-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  // Refund newest captures first.
  for (const p of [...b.payments].reverse()) {
    if (p.status !== 'completed' || p.kind === 'tip') continue;
    const already = p.refund?.amount || 0;
    const tipAlready = p.refund?.tip || 0;
    const room = round2(p.amount - already);
    const part = Math.max(0, Math.min(room, toRefund));
    const tipPart = full ? round2((p.tip || 0) - tipAlready) : 0;
    if (part <= 0 && tipPart <= 0) continue;
    const back = round2(part + tipPart);
    let refundId = demoRef;
    let refundStatus = 'COMPLETED';
    if (p.hold?.status === 'authorized') {
      // Never charged: a full refund of a held deposit voids the authorization; a partial one captures only what
      // the business keeps and releases the rest.
      if (part + 0.001 >= room) {
        refundId = await voidHold(p);
        refundStatus = 'VOIDED';
      } else {
        const fresh = store.findPayment(p.id).payment;
        store.updatePayment(p.id, { refund: { amount: round2(already + part), tip: 0, refundId: 'RELEASED', status: 'RELEASED', at: new Date().toISOString() } });
        const ok = await captureHold(p.id, `Kept ${usd(room - part)} of the hold; released ${usd(part)}`);
        if (!ok) store.updatePayment(p.id, { refund: fresh.refund || null });
        refundId = ok ? 'RELEASED' : 'FAILED';
        refundStatus = ok ? 'RELEASED' : 'FAILED';
        if (ok) {
          refunds.push({ amount: part, tip: 0, refundId, status: refundStatus, method: 'PayPal hold', released: true });
          toRefund = round2(toRefund - part);
          continue;
        }
      }
    } else if (isDemoMoney(p)) {
      refundId = demoRef;
    } else if (p.mode === 'paypal' && p.captureId && paypalReady) {
      // The capture holds the amount plus the tip. Refund the whole capture only when all of it goes back.
      const whole = already === 0 && tipAlready === 0 && back + 0.001 >= round2(p.amount + (p.tip || 0));
      const r = await paypal.refundCapture(p.captureId, { amount: whole ? null : back, note: reason || 'Your payment has been refunded.' });
      refundId = r.refundId;
      refundStatus = r.status;
    } else if (p.mode === 'outside' || p.mode === 'cash' || p.method === 'cash' || p.method === 'check') {
      refundId = 'OUTSIDE-PAYPAL';
    }
    store.updatePayment(p.id, { refund: { amount: round2(already + part), tip: round2(tipAlready + tipPart), refundId, status: refundStatus, at: new Date().toISOString() } });
    if (refundStatus === 'FAILED') continue;
    refunds.push({ amount: part, tip: tipPart, refundId, status: refundStatus, method: p.via === 'paypal' || p.mode === 'paypal' ? 'PayPal' : p.method || 'original payment', released: refundStatus === 'VOIDED' });
    toRefund = round2(toRefund - part);
  }
  const jobBack = sum(refunds.map((r) => r.amount));
  const tipBack = sum(refunds.map((r) => r.tip));
  const total = round2(jobBack + tipBack);
  const after = totals(store.getBooking(b.id));
  const fullyRefunded = after.paid <= 0.001;
  store.updateBooking(b.id, { status: fullyRefunded ? newStatus : b.status, refundedAt: new Date().toISOString(), refundReason: reason });
  // One line per distinct reference: two demo payments refunded together never print "X, X".
  const ref = [...new Set(refunds.map((r) => r.refundId))].join(', ');
  // What went back, in plain words: "$114 plus the $500 tip ($614 in all)" or "$50 of the $114 paid; the $20 tip was not refunded".
  const what = tipBack > 0 ? `${usd(jobBack)} plus the ${usd(tipBack)} tip (${usd(total)} in all)` : !full && t.paid - jobBack > 0.001 ? `${usd(jobBack)} of the ${usd(t.paid)} paid` : usd(total);
  const tipNote = !full && t.tips > 0 ? ` The ${usd(t.tips)} tip was not refunded.` : '';
  store.addTimeline(b.id, allReleasedLine(refunds, what, reason, tipNote, ref));
  const allReleased = refunds.length > 0 && refunds.every((r) => r.released);
  if (notify) {
    store.addMessage(
      b.leadId,
      'assistant',
      allReleased
        ? `Done: the ${usd(total)} hold on your PayPal is released. You were never charged for it.${tipNote} Reference: ${ref}.`
        : `Your refund of ${what} is on its way back to the account you paid with.${tipNote} Reference: ${ref}. It shows in PayPal right away; if you paid by card, your bank can take a few business days to post it.`,
      { kind: 'refund' },
    );
  }
  if (fullyRefunded) endMandate(b.id, 'revoked', 'The booking was refunded.');
  store.logActivity(`Refunded ${what} to ${b.customerName}${reason ? ` (${reason})` : ''}.${tipNote}`, { bookingId: b.id, kind: 'refund' });
  return { booking: store.getBooking(b.id), refunded: total, jobRefunded: jobBack, tipRefunded: tipBack, reference: ref, released: allReleased };
}

function allReleasedLine(refunds, what, reason, tipNote, ref) {
  if (refunds.length && refunds.every((r) => r.released)) return `Released the deposit hold (${what}) without charging anything${reason ? ` (${reason})` : ''}. PayPal ${ref}.`;
  return `Refunded ${what}${reason ? ` (${reason})` : ''}.${tipNote} PayPal refund ${ref}.`;
}

// Customer cancels. The policy they saw at booking is applied automatically.
export async function customerCancel(bookingId, { notify = true } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  // Only an upcoming booking can be canceled by the customer. A finished, paid or already-closed job never is.
  if (b.status === 'needs_rebook') throw new Error(`We already canceled ${b.slotLabel} on our side, so nothing is lost: reply REFUND for all your money back, or pick a new time.`);
  if (!['held', 'confirmed'].includes(b.status)) throw new Error(`This booking can't be canceled now (${(STATUS_WORDS[b.status] || b.status).toLowerCase()}). If something's wrong, reply here and the owner will sort it out.`);
  const t = totals(b);
  const insideWindow = Date.now() <= Date.parse(b.freeCancelUntil);
  if (t.paid <= 0) {
    store.updateBooking(b.id, { status: 'canceled', canceledAt: new Date().toISOString() });
    // Turn off the deposit link too, so a canceled booking can't be paid for later.
    await Promise.all(b.payments.filter((p) => p.status === 'pending').map(voidPayment));
    store.addTimeline(b.id, 'Customer canceled before paying. Hold released and the payment link turned off.');
    store.logActivity(`${b.customerName} canceled ${b.slotLabel} (nothing was paid).`, { bookingId: b.id, kind: 'cancel' });
    await offerToWaitlist(b.presetId, b.slotStart, b.slotLabel);
    return { outcome: 'released', booking: store.getBooking(b.id) };
  }
  if (insideWindow) {
    const r = await refund(b.id, { reason: 'Canceled inside the free-cancel window', notify });
    await offerToWaitlist(b.presetId, b.slotStart, b.slotLabel);
    return { outcome: 'refunded', ...r };
  }
  await captureHolds(b, 'Late cancel: the deposit is kept per the terms');
  store.updateBooking(b.id, { status: 'canceled', canceledAt: new Date().toISOString(), depositKept: totals(store.getBooking(b.id)).depositPaid });
  endMandate(b.id, 'revoked', 'The booking was canceled.');
  store.addTimeline(b.id, `Customer canceled after the free-cancel deadline (${freeCancelLabel(b)}). Deposit of ${usd(t.depositPaid)} kept per the terms shown at booking.`);
  store.logActivity(`${b.customerName} canceled late. ${usd(t.depositPaid)} deposit kept per policy.`, { bookingId: b.id, kind: 'late_cancel' });
  await offerToWaitlist(b.presetId, b.slotStart, b.slotLabel);
  return { outcome: 'kept_deposit', deadline: freeCancelLabel(b), kept: t.depositPaid, booking: store.getBooking(b.id) };
}

// Owner has to cancel. The customer is never penalized: new time or a full refund, their choice.
export async function businessCancel(bookingId, reason = '') {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  // Only an upcoming booking can be canceled this way. A finished, paid-up or already-closed job never reopens.
  if (!['held', 'confirmed'].includes(b.status)) throw new Error(`${b.customerName}'s booking is ${(STATUS_WORDS[b.status] || b.status).toLowerCase()}, so there's no upcoming appointment to cancel.`);
  const business = businessOf(b);
  const options = availableSlots(business, { limit: 3 }).filter((s) => s.start !== b.slotStart);
  store.updateBooking(b.id, { status: 'needs_rebook', businessCanceledAt: new Date().toISOString(), businessCancelReason: reason });
  const paid = totals(b).paid;
  // Nothing paid yet: turn the deposit link off, so nobody pays for a time we canceled. Picking a new time sends a fresh one.
  if (paid <= 0) await Promise.all(b.payments.filter((p) => p.status === 'pending').map(voidPayment));
  const list = options.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
  store.addMessage(
    b.leadId,
    'assistant',
    paid > 0
      ? `We're so sorry, we have to cancel ${b.slotLabel}${reason ? ` (${reason})` : ''}. Pick a new time and your ${usd(paid)} carries over: ${list}. Or reply REFUND and we'll send it all back right now.`
      : `We're so sorry, we have to cancel ${b.slotLabel}${reason ? ` (${reason})` : ''}. Nothing was charged, and the deposit link is turned off. Pick a new time and we'll send a fresh one: ${list}. Or reply CANCEL and we'll close it out.`,
    { kind: 'business_cancel', options },
  );
  store.addTimeline(b.id, `Business canceled ${b.slotLabel}${reason ? ` (${reason})` : ''}. ${paid > 0 ? 'Offered new times or a full refund.' : 'Nothing was paid; deposit link turned off. Offered new times.'}`);
  store.logActivity(`You canceled ${b.customerName}'s ${b.slotLabel}. They're choosing a new time or a refund.`, { bookingId: b.id, kind: 'business_cancel' });
  return { booking: store.getBooking(b.id), options };
}

// The customer takes the out after the business canceled: everything they paid comes back (tips too), and if
// nothing was paid the booking is simply closed. Never a cancel fee.
export async function acceptBusinessCancel(bookingId, { notify = true } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  if (b.status !== 'needs_rebook') throw new Error(`${b.customerName}'s booking is ${(STATUS_WORDS[b.status] || b.status).toLowerCase()}, not one the business canceled.`);
  const t = totals(b);
  if (t.paid > 0 || t.tips > 0) {
    const r = await refund(b.id, { reason: 'Business canceled; customer chose a refund', notify });
    return { outcome: 'refunded_in_full', ...r };
  }
  store.updateBooking(b.id, { status: 'canceled', canceledAt: new Date().toISOString(), cancelReason: 'Business canceled; customer chose not to rebook' });
  await Promise.all(b.payments.filter((p) => p.status === 'pending').map(voidPayment));
  store.addTimeline(b.id, 'Customer chose not to rebook after the business canceled. Nothing was paid, so nothing to refund. Booking closed.');
  store.logActivity(`${b.customerName} closed out the time you canceled (nothing was paid).`, { bookingId: b.id, kind: 'cancel' });
  return { outcome: 'released', refunded: 0, reference: null, booking: store.getBooking(b.id) };
}

export async function releaseHold(bookingId, reason = 'Deposit not paid in time') {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  if (b.status !== 'held') throw new Error(`${b.customerName}'s booking is ${STATUS_WORDS[b.status] || b.status}, not an unpaid hold.`);
  store.updateBooking(b.id, { status: 'canceled', canceledAt: new Date().toISOString(), cancelReason: reason });
  await Promise.all(b.payments.filter((p) => p.status === 'pending').map(voidPayment));
  store.addMessage(b.leadId, 'assistant', `We released the hold on ${b.slotLabel} since the deposit didn't come through. Text us anytime and we'll find you a new time.`, { kind: 'released' });
  store.addTimeline(b.id, `Hold released: ${reason}.`);
  store.logActivity(`Released ${b.customerName}'s unpaid hold on ${b.slotLabel}.`, { bookingId: b.id, kind: 'release' });
  await offerToWaitlist(b.presetId, b.slotStart, b.slotLabel);
  return store.getBooking(b.id);
}

// Unpaid holds expire on their own so slots aren't lost to tire-kickers.
export async function releaseStaleHolds(maxMinutes = Number(process.env.HOLD_MINUTES || 120)) {
  const cutoff = Date.now() - maxMinutes * 60000;
  const stale = store.listBookings().filter((b) => b.status === 'held' && Date.parse(b.createdAt) < cutoff);
  for (const b of stale) await releaseHold(b.id, `Deposit not paid within ${maxMinutes} minutes`);
  return stale.length;
}

export async function markNoShow(bookingId) {
  let b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  if (!['confirmed', 'held'].includes(b.status)) throw new Error(`${b.customerName}'s booking is ${(STATUS_WORDS[b.status] || b.status).toLowerCase()}, so it can't be marked a no-show.`);
  // A held deposit is captured now: a no-show is exactly what the hold was for.
  b = await captureHolds(b, 'No-show: the deposit is kept per the terms');
  endMandate(b.id, 'revoked', 'No-show.');
  const kept = totals(b).depositPaid;
  store.updateBooking(b.id, { status: 'no_show', noShowAt: new Date().toISOString(), depositKept: kept });
  store.addTimeline(b.id, `Marked no-show. Deposit of ${usd(kept)} kept per the terms shown at booking.`);
  store.logActivity(`${b.customerName} was a no-show. ${usd(kept)} deposit kept.`, { bookingId: b.id, kind: 'no_show' });
  return store.getBooking(b.id);
}

// ---------------- changes ----------------
export async function reschedule(bookingId, newSlotStart, { notify = true } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const business = businessOf(b);
  if (!slotOpen(business, store.listBookings().filter((x) => x.id !== b.id), newSlotStart)) throw new Error('That time is not open. Offer other times.');
  const old = { start: b.slotStart, label: b.slotLabel };
  const label = formatSlot(newSlotStart, business.timezone);
  const nextStatus = b.status === 'needs_rebook' ? (totals(b).depositPaid >= b.deposit ? 'confirmed' : 'held') : b.status;
  store.updateBooking(b.id, {
    slotStart: newSlotStart,
    slotLabel: label,
    freeCancelUntil: freeCancelDeadline(newSlotStart),
    status: nextStatus,
    rescheduledFrom: old.label,
  });
  let nb = store.getBooking(b.id);
  // A deposit hold only lasts PayPal's 3-day honor period. If the new time is past it, the hold is captured now and
  // becomes a regular deposit (still free to cancel per the terms; a free cancel then refunds it).
  for (const p of nb.payments.filter((x) => x.status === 'completed' && x.hold?.status === 'authorized')) {
    const jobEnd = Date.parse(newSlotStart) + (business.slotMinutes || 120) * 60000;
    if (jobEnd + BILL_MARGIN_HOURS * HOUR > Date.parse(p.hold.honorUntil)) await captureHold(p.id, "Moved past PayPal's 3-day hold window, so the deposit was captured as a regular deposit");
  }
  nb = store.getBooking(b.id);
  // An emailed deposit invoice names the old time: it is canceled, and the pay link (same deposit) stays.
  let invoiceCanceled = false;
  for (const p of nb.payments.filter((x) => x.status === 'pending' && x.invoice?.status === 'sent')) {
    await retireInvoice(p, `The appointment moved to ${label}, so this invoice was canceled. Use the payment link in your texts instead.`);
    invoiceCanceled = true;
  }
  nb = store.getBooking(b.id);
  // Back to a held booking whose deposit link was turned off (the business canceled before it was paid): send a fresh one.
  let freshLink = null;
  if (nextStatus === 'held' && !nb.payments.some((p) => p.kind === 'deposit' && p.status === 'pending')) {
    const owed = round2(nb.deposit - totals(nb).depositPaid);
    if (owed > 0) freshLink = payPageUrl(await newPayment(nb, { kind: 'deposit', amount: owed, label: 'Deposit' }));
    nb = store.getBooking(b.id);
  }
  const paid = totals(nb).paid;
  store.addTimeline(b.id, `Moved from ${old.label} to ${label}. ${usd(paid)} already paid carried over; no new charge.${freshLink ? ' Sent a fresh deposit link.' : ''}${invoiceCanceled ? ' The emailed deposit invoice (old time) was canceled.' : ''}`);
  const stillPending = nb.payments.find((p) => p.status === 'pending' && p.kind === 'deposit');
  const invoiceNote = invoiceCanceled && stillPending && !freshLink ? ` The emailed invoice had the old time, so it's canceled; pay the deposit here instead: ${payPageUrl(stillPending)}` : '';
  if (notify) store.addMessage(nb.leadId, 'assistant', `Done! You're moved to ${label}.${paid > 0 ? ` Your ${usd(paid)} moved with you, nothing new to pay.` : ''}${freshLink ? ` Tap to pay the deposit and lock it in: ${freshLink}` : ''}${invoiceNote} Free to cancel or move until ${freeCancelLabel(nb)}.`, { kind: 'rescheduled' });
  store.logActivity(`${nb.customerName} moved from ${old.label} to ${label}${paid > 0 ? `; ${usd(paid)} carried over` : ''}.`, { bookingId: b.id, kind: 'reschedule' });
  await offerToWaitlist(b.presetId, old.start, old.label);
  return nb;
}

export function proposeChange(bookingId, { description, amount }) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const change = { id: store.newId('chg'), description, amount: round2(amount), status: 'proposed', proposedAt: new Date().toISOString() };
  b.changes.push(change);
  store.updateBooking(b.id, { changes: b.changes });
  const t = totals(b);
  const newTotal = round2(t.total + change.amount);
  store.addMessage(
    b.leadId,
    'assistant',
    `Quick check before we do it: ${description} ${change.amount >= 0 ? 'adds' : 'takes off'} ${usd(Math.abs(change.amount))}. New total ${usd(newTotal)}, balance ${usd(Math.max(0, newTotal - t.paid))}. Reply YES to approve or NO to skip it.`,
    { kind: 'change_request', changeId: change.id },
  );
  store.addTimeline(b.id, `Change proposed: ${description} (${usd(change.amount)}). Waiting on customer approval.`);
  store.logActivity(`Asked ${b.customerName} to approve: ${description} (${usd(change.amount)}).`, { bookingId: b.id, kind: 'change' });
  return change;
}

export function decideChange(bookingId, changeId, approve, { notify = true } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const change = changeId ? b.changes.find((c) => c.id === changeId) : [...b.changes].reverse().find((c) => c.status === 'proposed');
  if (!change || change.status !== 'proposed') throw new Error('There is no change waiting for approval.');
  change.status = approve ? 'approved' : 'declined';
  change.decidedAt = new Date().toISOString();
  store.updateBooking(b.id, { changes: b.changes });
  const t = totals(store.getBooking(b.id));
  // If a balance payment is already out, re-price it.
  const pendingBalance = b.payments.find((p) => p.status === 'pending' && p.kind === 'balance');
  if (pendingBalance && approve) store.updatePayment(pendingBalance.id, { amount: t.due, paypalLink: null });
  store.addTimeline(b.id, `Customer ${approve ? 'approved' : 'declined'} the change: ${change.description} (${usd(change.amount)}) at ${change.decidedAt}.`);
  if (notify) store.addMessage(b.leadId, 'assistant', approve ? `Approved, thank you! New total ${usd(t.total)}. We've got it on your booking.` : `No problem, we'll leave it as is. Total stays ${usd(t.total)}.`, { kind: 'change_decided' });
  store.logActivity(`${b.customerName} ${approve ? 'approved' : 'declined'}: ${change.description} (${usd(change.amount)}).`, { bookingId: b.id, kind: 'change' });
  return { change, totals: t };
}

// ---------------- final balance, tips, cash, splitting, someone else paying ----------------
export async function markCompleted(bookingId) {
  let b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  if (!['confirmed', 'held'].includes(b.status)) throw new Error(`${b.customerName}'s booking is ${STATUS_WORDS[b.status] || b.status}.`);
  // The held deposit is applied to the final bill: captured now, so the balance link is the rest.
  b = await captureHolds(b, 'Applied to the final bill');
  const t = totals(b);
  store.updateBooking(b.id, { status: t.due > 0 ? 'completed' : 'paid_in_full', completedAt: new Date().toISOString() });
  store.addTimeline(b.id, `Job marked done. Balance ${usd(t.due)}.`);
  if (t.due <= 0) {
    store.addMessage(b.leadId, 'assistant', `All done, and you're paid up. Thank you! Receipt: ${bookingPageUrl(b)}`, { kind: 'receipt' });
    await payoutForBooking(b.id).catch((e) => console.error('payout', e.message));
    return { booking: store.getBooking(b.id), payLink: null };
  }
  const payment = await newPayment(store.getBooking(b.id), { kind: 'balance', amount: t.due, label: 'Balance' });
  store.addMessage(
    b.leadId,
    'assistant',
    `Thanks for having us today! Your balance is ${usd(t.due)} (total ${usd(t.total)} minus the ${usd(t.paid)} you already paid). Pay with card, Venmo, Pay Later or PayPal, and add a tip for the crew if you'd like: ${payPageUrl(payment)}`,
    { kind: 'balance_request' },
  );
  store.logActivity(`Job done for ${b.customerName}. Sent the ${usd(t.due)} balance link.`, { bookingId: b.id, kind: 'balance_requested' });
  return { booking: store.getBooking(b.id), payLink: payPageUrl(payment), due: t.due };
}

const OUTSIDE_METHODS = ['cash', 'check', 'other'];

export function recordOutsidePayment(bookingId, { amount, method = 'cash', note = '' }) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter the amount they paid, like 210.');
  const due = totals(b).due;
  if (due <= 0) throw new Error(`${b.customerName} doesn't owe anything right now, so there is nothing to record.`);
  method = OUTSIDE_METHODS.includes(String(method).toLowerCase()) ? String(method).toLowerCase() : 'other';
  const kind = b.status === 'held' ? 'deposit' : 'balance';
  // Void open links for the same amount so nobody gets chased for money already paid.
  b.payments.filter((p) => p.status === 'pending').forEach(voidPayment);
  // Never more than what is still owed. mode 'outside' keeps it out of PayPal refunds and payouts.
  const payment = store.addPayment(b.id, { kind, amount: round2(Math.min(n, due)), method, mode: 'outside', label: `${method[0].toUpperCase()}${method.slice(1)} payment`, note });
  completePayment(payment.id, { via: method });
  return store.getBooking(b.id);
}

// "Split it with my roommate": one link per person for whatever is due right now.
export async function splitDue(bookingId, ways = 2) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  ways = Math.max(2, Math.min(6, Math.round(ways)));
  const open = b.payments.filter((p) => p.status === 'pending');
  const t = totals(b);
  const kind = b.status === 'held' ? 'deposit' : 'balance';
  const amountDue = kind === 'deposit' ? round2(b.deposit - t.depositPaid) : t.due;
  if (amountDue <= 0) throw new Error('Nothing is due right now.');
  await Promise.all(open.map(voidPayment));
  const share = Math.floor((amountDue / ways) * 100) / 100;
  const links = [];
  for (let i = 0; i < ways; i++) {
    const amt = i === ways - 1 ? round2(amountDue - share * (ways - 1)) : share;
    const p = await newPayment(store.getBooking(b.id), { kind, amount: amt, label: `${kind === 'deposit' ? 'Deposit' : 'Balance'} share ${i + 1} of ${ways}` });
    links.push({ amount: amt, link: payPageUrl(p) });
  }
  store.addTimeline(b.id, `Split ${usd(amountDue)} ${ways} ways.`);
  store.logActivity(`${b.customerName} split ${usd(amountDue)} ${ways} ways.`, { bookingId: b.id });
  return { links, amountDue };
}

// "Send the bill to my husband": a link for a different payer. The customer stays the contact.
export async function linkForSomeoneElse(bookingId, payerName = '') {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const pending = b.payments.find((p) => p.status === 'pending');
  if (!pending) throw new Error('Nothing is due right now.');
  store.updatePayment(pending.id, { expectedPayer: payerName || 'someone else' });
  store.addTimeline(b.id, `Customer asked to have ${payerName || 'someone else'} pay ${usd(pending.amount)}.`);
  return { link: payPageUrl(pending), amount: pending.amount };
}

// ---------------- waitlist ----------------
export function joinWaitlist(leadId, note = '') {
  const lead = store.getLead(leadId);
  if (!lead) throw new Error('Lead not found.');
  const existing = store.listWaitlist().find((w) => w.leadId === leadId && w.status === 'waiting');
  if (existing) return existing;
  const item = store.addToWaitlist({ leadId, presetId: lead.presetId, name: lead.name || 'Customer', note });
  store.logActivity(`${lead.name || 'A customer'} joined the waitlist${note ? ` (${note})` : ''}.`, { kind: 'waitlist', leadId, presetId: lead.presetId });
  return item;
}

export async function offerToWaitlist(presetId, slotStart, slotLabel) {
  if (Date.parse(slotStart) < Date.now() + 2 * 3600 * 1000) return [];
  const waiting = store.listWaitlist().filter((w) => w.presetId === presetId && w.status === 'waiting');
  const offered = [];
  for (const w of waiting.slice(0, 3)) {
    store.updateWaitlist(w.id, { status: 'offered', offeredSlot: slotStart, offeredAt: new Date().toISOString() });
    store.addMessage(w.leadId, 'assistant', `Good news: ${slotLabel} just opened up. Want it? Reply YES and I'll hold it for you.`, { kind: 'waitlist_offer', slotStart });
    offered.push(w);
  }
  if (offered.length) store.logActivity(`Offered the open ${slotLabel} to ${offered.length} on the waitlist.`, { kind: 'waitlist_offer' });
  return offered;
}

// ---------------- repeat business ----------------
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

// After a paid-in-full job, text the customer when it's time to book again.
export async function sendRebookNudges({ force = false, presetId = null } = {}) {
  const nudged = [];
  for (const b of store.listBookings().filter(ofBusiness(presetId)).filter((x) => x.status === 'paid_in_full' && !x.rebookNudgedAt)) {
    const business = businessOf(b);
    const dueAt = Date.parse(b.slotStart) + (business.rebookDays || 30) * 86400000;
    if (!force && Date.now() < dueAt) continue;
    if (activeBookingForLead(b.leadId)) continue;
    const next = availableSlots(business, { limit: 1, days: 21 })[0];
    store.updateBooking(b.id, { rebookNudgedAt: new Date().toISOString() });
    const plan = business.plan ? ` Or join our ${business.plan.name} (${business.plan.priceLabel}) and it books itself.` : '';
    store.addMessage(
      b.leadId,
      'assistant',
      `Hi ${firstName(b.customerName)}! It's about time for your next ${b.service.toLowerCase()}. Want the same again${next ? ` on ${next.label}` : ''}? Reply YES and I'll set it up.${plan}`,
      { kind: 'rebook_nudge', slotStart: next?.start || null, serviceId: b.serviceId, size: b.size, name: b.customerName },
    );
    nudged.push(b.customerName);
  }
  if (nudged.length) store.logActivity(`Sent rebooking texts to ${nudged.join(', ')}.`, { kind: 'rebook' });
  return { nudged };
}

// ---------------- payout to the business when the job is done ----------------
// Customers pay the platform's PayPal account. Once a job is paid in full, the net (gross minus refunds and
// PayPal's fees) goes to the owner's PayPal email through Payouts. In demo mode it is recorded without moving money.
// Only money that actually came in through PayPal is paid out: cash or check recorded by the owner never is.
// Demo money counts only on a server with no PayPal keys (where the payout is recorded, not sent).
// A deposit still on hold (authorized, not captured) is never paid out.
const viaPayPal = (p) => (p.hold && p.hold.status !== 'captured' ? false : isDemoMoney(p) ? !paypalReady : p.mode === 'paypal');
export async function payoutForBooking(bookingId) {
  const b = store.getBooking(bookingId);
  if (!b || b.payout || b.status !== 'paid_in_full') return null;
  const business = businessOf(b);
  const captured = b.payments.filter((p) => (p.status === 'completed' || p.status === 'refunded') && viaPayPal(p));
  const gross = sum(captured.map((p) => Number(p.amount || 0) + Number(p.tip || 0)));
  const refunds = sum(captured.map((p) => (p.refund?.amount || 0) + (p.refund?.tip || 0)));
  const fees = sum(captured.map((p) => p.fee || 0));
  const amount = round2(gross - refunds - fees);
  if (amount <= 0) return null;
  const email = business.payoutEmail || null;
  let result = { batchId: 'DEMO-PAYOUT', status: 'demo' };
  if (paypalReady && email) {
    result = await paypal.sendPayout({ bookingId: b.id, amount, email, note: `${b.service} for ${b.customerName}, ${b.slotLabel}` });
  }
  store.updateBooking(b.id, { payout: { amount, email, batchId: result.batchId, status: result.status, at: new Date().toISOString() } });
  store.addTimeline(b.id, `Paid out ${usd(amount)} to the business${email ? ` (${email})` : ''}. PayPal payout ${result.batchId}.`);
  store.logActivity(`${usd(amount)} from ${b.customerName}'s job is on its way to your PayPal${email ? ` (${email})` : ''}.`, { bookingId: b.id, kind: 'payout' });
  return store.getBooking(b.id);
}

// ---------------- owner money view ----------------
export function moneySummary({ days = 7, presetId = null } = {}) {
  const since = Date.now() - days * 86400000;
  const all = store.listBookings().filter(ofBusiness(presetId));
  const payments = all.flatMap((b) => b.payments.map((p) => ({ ...p, booking: b })));
  const isHeld = (p) => p.hold && p.hold.status !== 'captured';
  const onHold = sum(payments.filter((p) => p.status === 'completed' && p.hold?.status === 'authorized').map((p) => p.amount - (p.refund?.amount || 0)));
  // Money in counts what was captured; a deposit on hold is shown on its own (it isn't in the account yet).
  const done = payments.filter((p) => (p.status === 'completed' || p.refund) && !isHeld(p) && Date.parse(p.completedAt || p.createdAt) >= since);
  const gross = sum(done.map((p) => p.amount + (p.tip || 0)));
  const fees = sum(done.map((p) => p.fee || 0));
  const refunds = sum(done.map((p) => (p.refund?.amount || 0) + (p.refund?.tip || 0)));
  const tips = sum(done.map((p) => (p.tip || 0) - (p.refund?.tip || 0)));
  const pending = sum(payments.filter((p) => p.status === 'pending').map((p) => p.amount));
  const kept = sum(all.filter((b) => b.depositKept && Date.parse(b.createdAt) >= since).map((b) => b.depositKept));
  const paidOut = sum(all.filter((b) => b.payout && Date.parse(b.payout.at) >= since).map((b) => b.payout.amount));
  return { days, gross, fees, refunds, tips, net: round2(gross - fees - refunds), stillOwed: pending, onHold, depositsKeptFromLateCancels: kept, paidOut };
}

// ---------------- dispute evidence ----------------
export function evidence(bookingId) {
  const b = store.getBooking(bookingId);
  if (!b) return null;
  const lead = store.getLead(b.leadId);
  return {
    booking: { id: b.id, customer: b.customerName, service: `${b.service} (${b.size})`, appointment: b.slotLabel, status: STATUS_WORDS[b.status] || b.status },
    agreedTerms: b.timeline.find((x) => x.text.startsWith('Terms shown'))?.text,
    totals: totals(b),
    payments: b.payments.map((p) => ({ label: p.label, amount: p.amount, tip: p.tip || 0, status: p.status, via: p.via || p.mode, paypalOrderId: p.orderId || null, paypalCaptureId: p.captureId || null, paypalAuthorizationId: p.hold?.authorizationId || null, hold: p.hold?.status || null, invoice: p.invoice?.id || null, refund: p.refund || null, at: p.completedAt || p.createdAt })),
    assistantLimit: b.mandate ? { limit: b.mandate.limit, spent: b.mandate.spent, status: b.mandate.status, grantedAt: b.mandate.grantedAt, scope: b.mandate.scope } : null,
    disputes: b.disputes || [],
    changes: b.changes,
    timeline: b.timeline,
    conversation: (lead?.messages || []).map((m) => ({ at: m.at, from: m.role === 'customer' ? b.customerName : 'Business (AI)', text: m.text })),
  };
}

// The evidence file as a PDF, the format PayPal's dispute evidence upload accepts.
export function evidencePdf(bookingId) {
  const e = evidence(bookingId);
  if (!e) return null;
  const b = store.getBooking(bookingId);
  const business = businessOf(b);
  const lines = [
    `# ${business.name}: booking record ${e.booking.id}`,
    `Customer: ${e.booking.customer}. Service: ${e.booking.service}. Appointment: ${e.booking.appointment}. Status: ${e.booking.status}.`,
    '',
    '# Terms the customer saw before paying',
    e.agreedTerms || '(not recorded)',
    '',
    '# Payments (PayPal IDs)',
    ...e.payments.map((p) => `${p.label}: ${usd(p.amount)}${p.tip ? ` + ${usd(p.tip)} tip` : ''}, ${p.status}, via ${p.via || 'n/a'}. Order ${p.paypalOrderId || '-'}, capture ${p.paypalCaptureId || '-'}${p.paypalAuthorizationId ? `, authorization ${p.paypalAuthorizationId}` : ''}${p.refund ? `, refunded ${usd(p.refund.amount)} (${p.refund.refundId})` : ''}. ${p.at}`),
    '',
    '# Changes the customer approved or declined',
    ...(e.changes.length ? e.changes.map((c) => `${c.description}: ${usd(c.amount)}, ${c.status}${c.decidedAt ? ` at ${c.decidedAt}` : ''}`) : ['None.']),
    '',
    '# Timeline',
    ...e.timeline.map((t) => `${t.at}  ${t.text}`),
    '',
    '# Full conversation',
    ...e.conversation.map((m) => `${m.at}  ${m.from}: ${m.text}`),
  ];
  return textPdf(lines, { title: `Booking record ${e.booking.id}` });
}

// A chargeback or dispute opened on a payment: the AI sends PayPal the evidence file right away (Disputes API
// provide-evidence) and tells the owner. PayPal only takes evidence while the dispute shows a provide-evidence link;
// if it doesn't yet, the file is kept ready and the owner is told so. demo: no PayPal call, labeled as simulated.
const EVIDENCE_TYPE = { MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'PROOF_OF_FULFILLMENT', MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'OTHER', UNAUTHORISED: 'OTHER' };
export async function defendDispute(bookingId, { disputeId, reason = '', amount = null, demo = !paypalReady } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  if ((b.disputes || []).some((d) => d.id === disputeId && ['evidence_sent', 'simulated'].includes(d.status))) return b;
  const t = totals(b);
  const terms = b.timeline.find((x) => x.text.startsWith('Terms shown'))?.text || '';
  const notes = [
    `${b.customerName} booked ${b.service} for ${b.slotLabel}${b.bookedBy ? ` (booked by their AI assistant ${b.bookedBy}; the customer approved the payment in PayPal themselves)` : ''}.`,
    terms,
    `Paid ${usd(t.paid)}${t.tips ? ` plus ${usd(t.tips)} tip` : ''}; status: ${STATUS_WORDS[b.status] || b.status}.`,
    'The attached booking record has every PayPal ID, each approval, the timeline and the full conversation.',
  ].join(' ');
  const pdf = evidencePdf(b.id);
  const evidenceType = EVIDENCE_TYPE[reason] || 'OTHER';
  let status = 'simulated';
  let detail = 'Demo mode: simulated, no PayPal call.';
  if (!demo) {
    try {
      const d = await paypal.getDispute(disputeId);
      const canSend = (d.links || []).some((l) => l.rel === 'provide_evidence' || /provide-evidence$/.test(l.href || ''));
      if (canSend) {
        await paypal.provideEvidence(disputeId, { evidenceType, notes, file: { name: `booking-${b.id}.pdf`, type: 'application/pdf', data: pdf } });
        status = 'evidence_sent';
        detail = `Sent to PayPal as ${evidenceType} evidence with the booking record PDF.`;
      } else {
        status = 'waiting_for_paypal';
        detail = `PayPal isn't taking evidence on this dispute yet (status ${d.status || 'unknown'}). The file is ready on the booking record.`;
      }
    } catch (err) {
      status = 'error';
      detail = `PayPal refused the evidence (${err.message}). The file is ready on the booking record to send by hand.`;
    }
  }
  const entry = { id: disputeId, reason, amount, status, evidenceType, at: new Date().toISOString(), detail };
  store.updateBooking(b.id, { disputes: [...(b.disputes || []).filter((d) => d.id !== disputeId), entry] });
  store.addTimeline(b.id, `PayPal dispute ${disputeId} opened (${reason || 'reason not given'}). ${detail}`);
  const line =
    status === 'evidence_sent'
      ? `The AI defended your chargeback: ${b.customerName} opened a PayPal dispute, and the evidence file (terms, approvals, PayPal IDs, the full conversation) was sent to PayPal.`
      : status === 'simulated'
        ? `The AI defended your chargeback (demo: simulated, no PayPal call): ${b.customerName}'s dispute would get the evidence file (terms, approvals, PayPal IDs, the full conversation) sent to PayPal.`
        : `Dispute opened on ${b.customerName}'s payment. ${detail}`;
  store.logActivity(line, { bookingId: b.id, kind: 'dispute' });
  return store.getBooking(b.id);
}

// ---------------- dashboard summary ----------------
// presetId: count only that business (the owner page passes the one it is showing).
export function summary({ presetId = null } = {}) {
  const bookings = store.listBookings().filter(ofBusiness(presetId));
  const leads = store.listLeads().filter((l) => !presetId || businessOf(l).id === presetId);
  const replies = leads.map((l) => l.firstReplyMs).filter((x) => typeof x === 'number');
  return {
    leads: leads.length,
    avgFirstReplySec: replies.length ? Math.round(sum(replies) / replies.length / 100) / 10 : null,
    held: bookings.filter((b) => b.status === 'held').length,
    confirmed: bookings.filter((b) => b.status === 'confirmed').length,
    owing: owing({ presetId }).length,
    money: moneySummary({ days: 30, presetId }),
  };
}

// ---------------- a PayPal invoice was paid ----------------
// Counts toward the deposit only when that deposit is still waiting on this very invoice. Paid on a closed booking,
// a deposit already paid another way, a request that was split or replaced, or an invoice a newer one replaced:
// the money is refunded automatically, logged on the booking, and the owner and the customer are told.
export async function invoicePaid(inv, txn) {
  const found = findPaymentByInvoice(inv?.id);
  if (!found) return null;
  return withBookingLock(found.booking.id, async () => {
    const { booking, payment, invoice } = findPaymentByInvoice(inv.id);
    const txnId = txn?.payment_id || txn?.id || null;
    const amount = round2(Number(inv?.amount?.value ?? inv?.payments?.paid_amount?.value ?? invoice?.amount ?? payment.amount));
    // The same webhook twice: already counted, or already refunded.
    if (payment.invoicePaidId === inv.id) return booking;
    if ((booking.invoiceRefunds || []).some((x) => x.invoiceId === inv.id)) return booking;
    const isCurrent = payment.invoice?.id === inv.id;
    const why =
      payment.status === 'completed' ? 'the deposit had already been paid another way'
        : payment.status !== 'pending' ? 'that deposit request had been replaced or turned off'
          : !isCurrent ? 'a newer invoice had replaced it'
            : CLOSED.includes(booking.status) ? `the booking was ${(STATUS_WORDS[booking.status] || booking.status).toLowerCase()}`
              : booking.status === 'needs_rebook' ? 'the business had canceled that time'
                : booking.status !== 'held' ? 'nothing was owed on it anymore'
                  : null;
    if (!why) {
      store.updatePayment(payment.id, { invoicePaidId: inv.id, invoice: { ...payment.invoice, status: 'paid', paidAt: new Date().toISOString() } });
      return completePayment(payment.id, { captureId: txnId, via: 'PayPal invoice' });
    }
    return refundInvoicePayment(booking, inv.id, invoice, txnId, amount, why);
  });
}

async function refundInvoicePayment(booking, invoiceId, invoice, txnId, amount, why) {
  const demo = Boolean(invoice?.demo || !paypalReady);
  let refundId = `DEMO-REFUND-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  let status = 'COMPLETED';
  let error = null;
  if (!demo) {
    try {
      if (!txnId) throw new Error('PayPal did not say which payment paid the invoice');
      const r = await paypal.refundCapture(txnId, { note: `Refunded automatically: ${why}.` });
      refundId = r.refundId;
      status = r.status || 'COMPLETED';
    } catch (err) {
      status = 'FAILED';
      error = err.message;
    }
  }
  const entry = { invoiceId, txnId, amount, refundId: status === 'FAILED' ? null : refundId, status, why, error, at: new Date().toISOString(), ...(demo ? { demo: true } : {}) };
  store.updateBooking(booking.id, { invoiceRefunds: [...(store.getBooking(booking.id).invoiceRefunds || []), entry] });
  const sim = demo ? ' (demo: simulated, no PayPal call)' : '';
  if (status === 'FAILED') {
    store.addTimeline(booking.id, `Invoice ${invoiceId} was paid (${usd(amount)}) after ${why}. The automatic refund failed (${error}); refund it by hand in PayPal.`);
    const line = `Action needed: ${booking.customerName} paid invoice ${invoiceId} (${usd(amount)}) after ${why}, and the automatic refund failed (${error}). Please refund it in PayPal.`;
    store.logActivity(line, { bookingId: booking.id, kind: 'invoice_refund_failed' });
    store.addOwnerMessage('assistant', line, { presetId: booking.presetId, alert: true });
    return store.getBooking(booking.id);
  }
  store.addTimeline(booking.id, `Invoice ${invoiceId} was paid (${usd(amount)}) after ${why}, so it was refunded automatically. PayPal refund ${refundId}${sim}.`);
  const line = `Heads up: ${booking.customerName} paid invoice ${invoiceId} (${usd(amount)}) after ${why}, so the AI refunded it automatically (reference ${refundId})${sim}. Nothing for you to do.`;
  store.logActivity(line, { bookingId: booking.id, kind: 'invoice_refund' });
  store.addOwnerMessage('assistant', line, { presetId: booking.presetId, alert: true });
  store.addMessage(booking.leadId, 'assistant', `Your ${usd(amount)} invoice payment came in after ${why}, so we refunded it right away. Reference: ${refundId}. Nothing else is owed on it.`, { kind: 'refund' });
  return store.getBooking(booking.id);
}

// ---------------- PayPal webhooks ----------------
// The tip on a captured order, so the payout is right even when the webhook arrives before the return page.
// First the tip saved with the order that was captured; else what was captured above the amount owed.
export function capturedTip(payment, resource = {}) {
  const orderId = resource?.supplementary_data?.related_ids?.order_id;
  const saved = (payment.orders || []).find((o) => o.id === orderId);
  if (saved && saved.tip !== undefined) return clampTip(saved.tip) || null;
  const captured = Number(resource?.amount?.value);
  if (!Number.isFinite(captured)) return null;
  return clampTip(captured - Number(payment.amount || 0)) || null;
}

export async function handlePayPalEvent(event) {
  const type = event?.event_type || '';
  const r = event?.resource || {};
  if (type === 'CHECKOUT.ORDER.APPROVED') {
    const found = findPaymentByOrder(r.id);
    if (found) return syncPayment(found.payment.id, { orderId: r.id });
  }
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    const [, paymentId] = String(r.custom_id || '').split(':');
    const found = store.findPayment(paymentId) || findPaymentByOrder(r?.supplementary_data?.related_ids?.order_id);
    // The capture of a deposit hold (no-show or final bill) was recorded when this app captured it: only fill in fees.
    if (found?.payment?.hold) {
      const br = r.seller_receivable_breakdown || {};
      if (found.payment.hold.captureId === r.id && br.paypal_fee && found.payment.fee == null) store.updatePayment(found.payment.id, { fee: Number(br.paypal_fee.value), net: br.net_amount ? Number(br.net_amount.value) : null });
      return store.getBooking(found.booking.id);
    }
    if (found) {
      const br = r.seller_receivable_breakdown || {};
      return completePayment(found.payment.id, { captureId: r.id, fee: br.paypal_fee ? Number(br.paypal_fee.value) : null, net: br.net_amount ? Number(br.net_amount.value) : null, tip: capturedTip(found.payment, r) });
    }
  }
  if (type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED') {
    const [, paymentId] = String(r.custom_id || '').split(':');
    const found = store.findPayment(paymentId);
    if (found) store.addMessage(found.booking.leadId, 'assistant', `That payment didn't go through, and nothing was charged. Here's a fresh link: ${payPageUrl(found.payment)}`, { kind: 'payment_failed' });
  }
  if (type === 'INVOICING.INVOICE.PAID') {
    // Payload shapes differ between docs versions: the invoice at resource or at resource.invoice.
    const inv = r.invoice || r;
    const txn = inv?.payments?.transactions?.[0] || inv?.payments?.[0] || null;
    return invoicePaid(inv, txn);
  }
  if (type === 'CUSTOMER.DISPUTE.CREATED') {
    const txn = r?.disputed_transactions?.[0];
    const found = store.findPaymentBy('captureId', txn?.seller_transaction_id);
    if (found) return defendDispute(found.booking.id, { disputeId: r.dispute_id || r.id, reason: r.reason || '', amount: Number(r?.dispute_amount?.value) || null });
  }
  return null;
}
