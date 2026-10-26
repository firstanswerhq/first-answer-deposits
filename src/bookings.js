// The shared booking record and every money move around it.
// Customer AI, owner AI, dashboard buttons and PayPal webhooks all go through here,
// so the calendar and the money can never disagree.
import { presets, depositFor, priceFor } from './business.js';
import * as store from './store.js';
import * as paypal from './paypal.js';
import { config, paypalReady } from './config.js';
import { openSlots, isSlotOpen, formatSlot } from './slots.js';
import { cachedBusy } from './busy.js';

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sum = (arr) => round2(arr.reduce((a, b) => a + Number(b || 0), 0));
export const usd = (n) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`;

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

// ---------------- lookups ----------------
// A business is either a built-in demo preset or one an owner set up (stored in the data file).
export function businessById(id) {
  return presets[id] || store.getBusiness(id) || null;
}
export function listAllBusinesses() {
  return [...Object.values(presets), ...store.listBusinesses()];
}
export function currentBusiness() {
  return businessById(store.getSettings().presetId) || presets.cleaning;
}
export function businessOf(x) {
  return (x && businessById(x.presetId)) || currentBusiness();
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
  const refunded = sum(booking.payments.map((p) => p.refund?.amount || 0));
  const paid = round2(paidGross - refunded);
  const due = Math.max(0, round2(total - paid));
  const depositPaid = sum(done.filter((p) => p.kind === 'deposit').map((p) => p.amount)) - sum(booking.payments.filter((p) => p.kind === 'deposit').map((p) => p.refund?.amount || 0));
  return { total, paid, due, tips: tipsGross, refunded, depositPaid: round2(depositPaid) };
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

export function bookingPageUrl(booking) {
  return `${config.publicUrl}/b/${booking.id}?k=${booking.secret}`;
}
export function payPageUrl(payment) {
  return `${config.publicUrl}/p/${payment.id}`;
}

// ---------------- PayPal links ----------------
async function attachOrder(booking, payment, { tip = 0, redirect = true } = {}) {
  const business = businessOf(booking);
  if (!paypalReady) {
    store.updatePayment(payment.id, { mode: 'demo', orderId: null, paypalLink: null });
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
  });
  store.updatePayment(payment.id, { mode: 'paypal', orderId, paypalLink: payLink || null, orderMode: redirect ? 'redirect' : 'buttons', tip, orderCreatedAt: new Date().toISOString() });
  return payLink;
}

// Where the short link sends people. Makes a fresh PayPal order if the old one went stale, so links never "expire".
export async function checkoutFor(paymentId, { tip = 0, redirect = false } = {}) {
  const found = store.findPayment(paymentId);
  if (!found) return { error: 'not_found' };
  const { booking, payment } = found;
  if (payment.status === 'completed') return { paid: true, booking, payment };
  if (payment.status !== 'pending') return { error: payment.status, booking, payment };
  if (!paypalReady) return { demo: true, booking, payment };
  const stale = Date.now() - Date.parse(payment.orderCreatedAt || 0) > 2 * 3600 * 1000;
  const wantMode = redirect ? 'redirect' : 'buttons';
  if (!payment.orderId || stale || payment.orderMode !== wantMode || Number(payment.tip || 0) !== Number(tip || 0)) {
    await attachOrder(booking, payment, { tip, redirect });
  }
  const p = store.findPayment(paymentId).payment;
  return { orderId: p.orderId, url: p.paypalLink, booking, payment: p };
}

// Payment rows are created right away; the PayPal order is made when the customer opens the payment page,
// so links never go stale and no unused orders pile up.
async function newPayment(booking, data) {
  return store.addPayment(booking.id, { mode: paypalReady ? 'paypal' : 'demo', ...data });
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
export function completePayment(paymentId, { captureId = null, fee = null, net = null, payerEmail = null, payerName = null, via = 'paypal', tip = null } = {}) {
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
    ...(tip !== null ? { tip } : {}),
  });
  const b = store.getBooking(booking.id);
  const t = totals(b);
  const p = store.findPayment(paymentId).payment;
  const who = payerName && payerName !== b.customerName ? ` (paid by ${payerName})` : '';
  store.addTimeline(b.id, `${p.label || p.kind} paid: ${usd(p.amount)}${p.tip ? ` + ${usd(p.tip)} tip` : ''} via ${via}${who}. PayPal capture ${captureId || 'n/a'}.`);

  if (p.kind === 'deposit') {
    if (b.status === 'held' && t.depositPaid + 0.001 >= b.deposit) {
      store.updateBooking(b.id, { status: 'confirmed', confirmedAt: new Date().toISOString() });
      store.addMessage(b.leadId, 'assistant', `Got your ${usd(b.deposit)} deposit${who}, thank you! You're confirmed for ${b.service} on ${b.slotLabel}. ${termsLine(store.getBooking(b.id))} Your booking: ${bookingPageUrl(b)}`, { kind: 'confirmation' });
      store.logActivity(`Deposit paid: ${usd(b.deposit)} from ${b.customerName}${who}. ${b.slotLabel} is confirmed.`, { bookingId: b.id, kind: 'deposit_paid' });
    } else if (b.status === 'held') {
      store.addMessage(b.leadId, 'assistant', `Got ${usd(p.amount)}${who} toward the deposit. ${usd(round2(b.deposit - t.depositPaid))} to go and you're confirmed.`, { kind: 'partial' });
      store.logActivity(`Split deposit: ${usd(p.amount)} in for ${b.customerName}${who}.`, { bookingId: b.id });
    }
  } else {
    const after = totals(store.getBooking(b.id));
    if (after.due <= 0.001) {
      store.updateBooking(b.id, { status: 'paid_in_full', paidInFullAt: new Date().toISOString() });
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

export async function syncPayment(paymentId) {
  const found = store.findPayment(paymentId);
  if (!found) return null;
  const { payment } = found;
  if (payment.status !== 'pending' || payment.mode !== 'paypal' || !payment.orderId) return found.booking;
  const order = await paypal.getOrder(payment.orderId);
  if (order.status === 'APPROVED') {
    const cap = await paypal.captureOrder(payment.orderId);
    if (cap.captureStatus === 'COMPLETED' || cap.status === 'COMPLETED') {
      return completePayment(paymentId, { captureId: cap.captureId, fee: cap.fee, net: cap.net, payerEmail: cap.payerEmail, payerName: cap.payerName });
    }
    if (cap.captureStatus === 'DECLINED') {
      store.updatePayment(paymentId, { lastError: 'declined' });
      store.addMessage(found.booking.leadId, 'assistant', `That payment didn't go through (the bank declined it). Nothing was charged. Here's a fresh link to try another card, Venmo or PayPal: ${payPageUrl(payment)}`, { kind: 'payment_failed' });
    }
  } else if (order.status === 'COMPLETED') {
    const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
    return completePayment(paymentId, { captureId: cap?.id || null });
  }
  return store.getBooking(found.booking.id);
}

// Demo mode only (no PayPal keys): lets the flow be tried end to end.
export function completeDemoPayment(paymentId, { tip = 0 } = {}) {
  return completePayment(paymentId, { via: 'demo checkout', captureId: 'DEMO-' + paymentId, tip: tip || null });
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
  store.updateBooking(bookingId, { reminders: (b.reminders || 0) + 1, lastReminderAt: new Date().toISOString() });
  store.addTimeline(b.id, `Reminder sent for ${usd(pending.amount)}.`);
  store.logActivity(`Reminder sent to ${b.customerName} for ${usd(pending.amount)}.`, { bookingId, kind: 'reminder' });
  return store.getBooking(bookingId);
}

export function owing() {
  return store.listBookings().filter((b) => ['held', 'completed'].includes(b.status) && b.payments.some((p) => p.status === 'pending'));
}

// ---------------- refunds and cancellations ----------------
export async function refund(bookingId, { amount = null, reason = '', newStatus = 'refunded', notify = true } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const t = totals(b);
  if (t.paid <= 0) throw new Error(`${b.customerName} hasn't paid anything, so there is nothing to refund.`);
  let toRefund = round2(amount ? Math.min(amount, t.paid) : t.paid);
  const refunds = [];
  // Refund newest captures first.
  for (const p of [...b.payments].reverse()) {
    if (toRefund <= 0) break;
    if (p.status !== 'completed' || p.kind === 'tip') continue;
    const already = p.refund?.amount || 0;
    const room = round2(p.amount - already);
    if (room <= 0) continue;
    const part = Math.min(room, toRefund);
    let refundId = 'DEMO-REFUND';
    let refundStatus = 'COMPLETED';
    if (p.mode === 'paypal' && p.captureId && paypalReady) {
      const r = await paypal.refundCapture(p.captureId, { amount: part < p.amount ? part : null, note: reason || 'Your payment has been refunded.' });
      refundId = r.refundId;
      refundStatus = r.status;
    } else if (p.mode === 'cash' || p.method === 'cash' || p.method === 'check') {
      refundId = 'OUTSIDE-PAYPAL';
    }
    store.updatePayment(p.id, { refund: { amount: round2(already + part), refundId, status: refundStatus, at: new Date().toISOString() } });
    refunds.push({ amount: part, refundId, status: refundStatus, method: p.via === 'paypal' || p.mode === 'paypal' ? 'PayPal' : p.method || 'original payment' });
    toRefund = round2(toRefund - part);
  }
  const total = sum(refunds.map((r) => r.amount));
  const fullyRefunded = totals(store.getBooking(b.id)).paid <= 0.001;
  store.updateBooking(b.id, { status: fullyRefunded ? newStatus : b.status, refundedAt: new Date().toISOString(), refundReason: reason });
  const ref = refunds.map((r) => r.refundId).join(', ');
  store.addTimeline(b.id, `Refunded ${usd(total)}${reason ? ` (${reason})` : ''}. PayPal refund ${ref}.`);
  if (notify) {
    store.addMessage(
      b.leadId,
      'assistant',
      `Your refund of ${usd(total)} is on its way back to the account you paid with. Reference: ${ref}. It shows in PayPal right away; if you paid by card, your bank can take a few business days to post it.`,
      { kind: 'refund' },
    );
  }
  store.logActivity(`Refunded ${usd(total)} to ${b.customerName}${reason ? ` (${reason})` : ''}.`, { bookingId: b.id, kind: 'refund' });
  return { booking: store.getBooking(b.id), refunded: total, reference: ref };
}

// Customer cancels. The policy they saw at booking is applied automatically.
export async function customerCancel(bookingId, { notify = true } = {}) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const t = totals(b);
  const insideWindow = Date.now() <= Date.parse(b.freeCancelUntil);
  if (t.paid <= 0) {
    store.updateBooking(b.id, { status: 'canceled', canceledAt: new Date().toISOString() });
    store.addTimeline(b.id, 'Customer canceled before paying. Hold released.');
    store.logActivity(`${b.customerName} canceled ${b.slotLabel} (nothing was paid).`, { bookingId: b.id, kind: 'cancel' });
    await offerToWaitlist(b.presetId, b.slotStart, b.slotLabel);
    return { outcome: 'released', booking: store.getBooking(b.id) };
  }
  if (insideWindow) {
    const r = await refund(b.id, { reason: 'Canceled inside the free-cancel window', notify });
    await offerToWaitlist(b.presetId, b.slotStart, b.slotLabel);
    return { outcome: 'refunded', ...r };
  }
  store.updateBooking(b.id, { status: 'canceled', canceledAt: new Date().toISOString(), depositKept: t.depositPaid });
  store.addTimeline(b.id, `Customer canceled after the free-cancel deadline (${freeCancelLabel(b)}). Deposit of ${usd(t.depositPaid)} kept per the terms shown at booking.`);
  store.logActivity(`${b.customerName} canceled late. ${usd(t.depositPaid)} deposit kept per policy.`, { bookingId: b.id, kind: 'late_cancel' });
  await offerToWaitlist(b.presetId, b.slotStart, b.slotLabel);
  return { outcome: 'kept_deposit', deadline: freeCancelLabel(b), kept: t.depositPaid, booking: store.getBooking(b.id) };
}

// Owner has to cancel. The customer is never penalized: new time or a full refund, their choice.
export async function businessCancel(bookingId, reason = '') {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const business = businessOf(b);
  const options = availableSlots(business, { limit: 3 }).filter((s) => s.start !== b.slotStart);
  store.updateBooking(b.id, { status: 'needs_rebook', businessCanceledAt: new Date().toISOString(), businessCancelReason: reason });
  const paid = totals(b).paid;
  const list = options.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
  store.addMessage(
    b.leadId,
    'assistant',
    `We're so sorry, we have to cancel ${b.slotLabel}${reason ? ` (${reason})` : ''}. Pick a new time and your ${usd(paid)} carries over: ${list}. Or reply REFUND and we'll send it all back right now.`,
    { kind: 'business_cancel', options },
  );
  store.addTimeline(b.id, `Business canceled ${b.slotLabel}${reason ? ` (${reason})` : ''}. Offered new times or a full refund.`);
  store.logActivity(`You canceled ${b.customerName}'s ${b.slotLabel}. They're choosing a new time or a refund.`, { bookingId: b.id, kind: 'business_cancel' });
  return { booking: store.getBooking(b.id), options };
}

export async function releaseHold(bookingId, reason = 'Deposit not paid in time') {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  if (b.status !== 'held') throw new Error(`${b.customerName}'s booking is ${STATUS_WORDS[b.status] || b.status}, not an unpaid hold.`);
  store.updateBooking(b.id, { status: 'canceled', canceledAt: new Date().toISOString(), cancelReason: reason });
  b.payments.filter((p) => p.status === 'pending').forEach((p) => store.updatePayment(p.id, { status: 'void' }));
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

export function markNoShow(bookingId) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
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
  const nb = store.getBooking(b.id);
  const paid = totals(nb).paid;
  store.addTimeline(b.id, `Moved from ${old.label} to ${label}. ${usd(paid)} already paid carried over; no new charge.`);
  if (notify) store.addMessage(nb.leadId, 'assistant', `Done! You're moved to ${label}.${paid > 0 ? ` Your ${usd(paid)} moved with you, nothing new to pay.` : ''} Free to cancel or move until ${freeCancelLabel(nb)}.`, { kind: 'rescheduled' });
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
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  if (!['confirmed', 'held'].includes(b.status)) throw new Error(`${b.customerName}'s booking is ${STATUS_WORDS[b.status] || b.status}.`);
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

export function recordOutsidePayment(bookingId, { amount, method = 'cash', note = '' }) {
  const b = store.getBooking(bookingId);
  if (!b) throw new Error('Booking not found.');
  const kind = b.status === 'held' ? 'deposit' : 'balance';
  // Void open links for the same amount so nobody gets chased for money already paid.
  b.payments.filter((p) => p.status === 'pending').forEach((p) => store.updatePayment(p.id, { status: 'void' }));
  const payment = store.addPayment(b.id, { kind, amount: round2(amount), method, mode: method, label: `${method[0].toUpperCase()}${method.slice(1)} payment`, note });
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
  open.forEach((p) => store.updatePayment(p.id, { status: 'void' }));
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
  store.logActivity(`${lead.name || 'A customer'} joined the waitlist${note ? ` (${note})` : ''}.`, { kind: 'waitlist' });
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
export async function sendRebookNudges({ force = false } = {}) {
  const nudged = [];
  for (const b of store.listBookings().filter((x) => x.status === 'paid_in_full' && !x.rebookNudgedAt)) {
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
export async function payoutForBooking(bookingId) {
  const b = store.getBooking(bookingId);
  if (!b || b.payout || b.status !== 'paid_in_full') return null;
  const business = businessOf(b);
  const t = totals(b);
  const fees = sum(b.payments.filter((p) => p.status === 'completed').map((p) => p.fee || 0));
  const amount = round2(t.paid + t.tips - fees);
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
export function moneySummary({ days = 7 } = {}) {
  const since = Date.now() - days * 86400000;
  const payments = store.listBookings().flatMap((b) => b.payments.map((p) => ({ ...p, booking: b })));
  const done = payments.filter((p) => (p.status === 'completed' || p.refund) && Date.parse(p.completedAt || p.createdAt) >= since);
  const gross = sum(done.map((p) => p.amount + (p.tip || 0)));
  const fees = sum(done.map((p) => p.fee || 0));
  const refunds = sum(done.map((p) => p.refund?.amount || 0));
  const tips = sum(done.map((p) => p.tip || 0));
  const pending = sum(payments.filter((p) => p.status === 'pending').map((p) => p.amount));
  const kept = sum(store.listBookings().filter((b) => b.depositKept && Date.parse(b.createdAt) >= since).map((b) => b.depositKept));
  const paidOut = sum(store.listBookings().filter((b) => b.payout && Date.parse(b.payout.at) >= since).map((b) => b.payout.amount));
  return { days, gross, fees, refunds, tips, net: round2(gross - fees - refunds), stillOwed: pending, depositsKeptFromLateCancels: kept, paidOut };
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
    payments: b.payments.map((p) => ({ label: p.label, amount: p.amount, tip: p.tip || 0, status: p.status, via: p.via || p.mode, paypalOrderId: p.orderId || null, paypalCaptureId: p.captureId || null, refund: p.refund || null, at: p.completedAt || p.createdAt })),
    changes: b.changes,
    timeline: b.timeline,
    conversation: (lead?.messages || []).map((m) => ({ at: m.at, from: m.role === 'customer' ? b.customerName : 'Business (AI)', text: m.text })),
  };
}

// ---------------- dashboard summary ----------------
export function summary() {
  const bookings = store.listBookings();
  const leads = store.listLeads();
  const replies = leads.map((l) => l.firstReplyMs).filter((x) => typeof x === 'number');
  return {
    leads: leads.length,
    avgFirstReplySec: replies.length ? Math.round(sum(replies) / replies.length / 100) / 10 : null,
    held: bookings.filter((b) => b.status === 'held').length,
    confirmed: bookings.filter((b) => b.status === 'confirmed').length,
    owing: owing().length,
    money: moneySummary({ days: 30 }),
  };
}

// ---------------- PayPal webhooks ----------------
export async function handlePayPalEvent(event) {
  const type = event?.event_type || '';
  const r = event?.resource || {};
  if (type === 'CHECKOUT.ORDER.APPROVED') {
    const found = store.findPaymentBy('orderId', r.id);
    if (found) return syncPayment(found.payment.id);
  }
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    const [, paymentId] = String(r.custom_id || '').split(':');
    const found = store.findPayment(paymentId) || store.findPaymentBy('orderId', r?.supplementary_data?.related_ids?.order_id);
    if (found) {
      const br = r.seller_receivable_breakdown || {};
      return completePayment(found.payment.id, { captureId: r.id, fee: br.paypal_fee ? Number(br.paypal_fee.value) : null, net: br.net_amount ? Number(br.net_amount.value) : null });
    }
  }
  if (type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED') {
    const [, paymentId] = String(r.custom_id || '').split(':');
    const found = store.findPayment(paymentId);
    if (found) store.addMessage(found.booking.leadId, 'assistant', `That payment didn't go through, and nothing was charged. Here's a fresh link: ${payPageUrl(found.payment)}`, { kind: 'payment_failed' });
  }
  if (type === 'CUSTOMER.DISPUTE.CREATED') {
    const txn = r?.disputed_transactions?.[0];
    const found = store.findPaymentBy('captureId', txn?.seller_transaction_id);
    if (found) {
      store.addTimeline(found.booking.id, `PayPal dispute opened (${r.reason || 'reason not given'}). Evidence file is ready.`);
      store.logActivity(`Dispute opened on ${found.booking.customerName}'s payment. The evidence file is ready to send.`, { bookingId: found.booking.id, kind: 'dispute' });
    }
  }
  return null;
}
