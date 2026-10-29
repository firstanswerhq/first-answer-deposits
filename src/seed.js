// "Load a sample day": a few bookings in different states so the owner page tells the story at a glance.
import * as store from './store.js';
import * as B from './bookings.js';

// True when this business already has its sample day (one press is enough; a second never duplicates it).
export function hasSampleDay(business) {
  return store.listBookings().some((b) => b.presetId === business.id && b.sample);
}

export async function seedSampleDay(business) {
  if (hasSampleDay(business)) return { bookings: 0, already: true };
  const slots = B.availableSlots(business, { limit: 12, days: 10 });
  if (slots.length < 4) throw new Error('Not enough open times to build a sample day.');
  const [svc1, svc2, svc3] = [business.services[0], business.services[1] || business.services[0], business.services[2] || business.services[0]];
  const sizeOf = (s, i) => Object.keys(s.sizes)[Math.min(i, Object.keys(s.sizes).length - 1)];
  const made = [];
  const book = async (name, svc, size, slot, channel = 'text') => {
    const lead = store.createLead({ name, phone: `615-555-01${String(made.length + 10).slice(-2)}`, channel, presetId: business.id });
    store.updateLead(lead.id, { sample: true });
    store.addMessage(lead.id, 'customer', `Hi, I'd like to book a ${svc.name.toLowerCase()}.`, { channel: 'text' });
    const r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: svc.id, size, slotStart: slot.start, customerName: name });
    store.updateBooking(r.booking.id, { sample: true });
    store.addMessage(lead.id, 'assistant', `Got it, ${name}! I'm holding ${r.booking.slotLabel} for you. ${r.terms}${r.payLink ? ` Tap to pay the deposit: ${r.payLink}` : ''}`, { channel: 'text' });
    made.push(r.booking);
    return r.booking;
  };

  // 1) Paid in full, job done, tip left: shows the receipt, the payout and the review ask.
  const a = await book('Sarah Kim', svc2, sizeOf(svc2, 1), slots[0]);
  if (a.payments[0]) B.completeDemoPayment(a.payments[0].id);
  const done = await B.markCompleted(a.id);
  if (done.payLink) {
    const bal = store.getBooking(a.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
    B.completeDemoPayment(bal.id, { tip: Math.round(bal.amount * 0.15) });
  }
  // 2) Confirmed for later this week, with an approved extra.
  const b = await book('Marcus Lee', svc1, sizeOf(svc1, 0), slots[2]);
  if (b.payments[0]) B.completeDemoPayment(b.payments[0].id);
  const chg = B.proposeChange(b.id, { description: 'Inside of the oven', amount: 25 });
  B.decideChange(b.id, chg.id, true, { notify: false });
  // 3) Held, deposit still unpaid (shows up under "Deposits waiting").
  await book('Priya Natarajan', svc3, sizeOf(svc3, 0), slots[3], 'AI assistant (MCP)');
  // 4) Someone on the waitlist.
  const w = store.createLead({ name: 'Dana Whitfield', presetId: business.id });
  store.updateLead(w.id, { sample: true });
  B.joinWaitlist(w.id, 'Saturday mornings');

  store.logActivity('Loaded a sample day: one paid job, one confirmed, one waiting on a deposit, one on the waitlist.', { kind: 'seed', presetId: business.id });
  return { bookings: made.length };
}

// True while PayPal holds something open for this booking: an order not yet paid, an invoice still payable (or one
// whose cancel PayPal has not confirmed), a hold, a saved wallet with an active limit, or captured money not fully
// refunded. Such a booking is never deleted by a reset, so a reset never strands money or a live PayPal object.
export function hasOpenPayPal(b) {
  const real = (p) => !B.isDemoMoney(p) && p.mode === 'paypal';
  const refundedAll = (p) => p.refund && p.refund.amount + 0.001 >= p.amount;
  return (
    b.payments.some(
      (p) =>
        (p.status === 'pending' && p.orderId && real(p)) ||
        [p.invoice, ...(p.invoices || [])].some((i) => i && !i.demo && (i.status === 'sent' || (i.status === 'canceled' && i.cancelConfirmed === false))) ||
        (p.hold?.status === 'authorized' && !p.hold.demo) ||
        (p.status === 'completed' && real(p) && !refundedAll(p)),
    ) ||
    Boolean(b.mandate && b.mandate.status === 'active' && b.mandate.vaultId && !b.mandate.demo)
  );
}

// "Reset demo" on the owner page: clears what this visitor made on this business (bookings, texts, owner chat) and
// the sample day, then loads a fresh sample day. Demo businesses are shared, so other visitors' bookings are never
// touched, and no booking with an open PayPal object is ever deleted.
export async function resetBusinessDemo(business, { visitorId = null } = {}) {
  const ours = (x) => Boolean(x.sample || (visitorId && x.visitorId === visitorId));
  const r = store.clearBusinessData(business.id, {
    removeBooking: (b) => ours(b) && !hasOpenPayPal(b),
    removeLead: (l) => ours(l),
    removeOwnerMessage: (m) => Boolean(visitorId && m.visitorId === visitorId),
  });
  const seeded = await seedSampleDay(business);
  return { cleared: r.bookings, kept: r.kept, bookings: seeded.bookings };
}
