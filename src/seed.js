// "Load a sample day": a few bookings in different states so the owner page tells the story at a glance.
import * as store from './store.js';
import * as B from './bookings.js';

export async function seedSampleDay(business) {
  const slots = B.availableSlots(business, { limit: 12, days: 10 });
  if (slots.length < 4) throw new Error('Not enough open times to build a sample day.');
  const [svc1, svc2, svc3] = [business.services[0], business.services[1] || business.services[0], business.services[2] || business.services[0]];
  const sizeOf = (s, i) => Object.keys(s.sizes)[Math.min(i, Object.keys(s.sizes).length - 1)];
  const made = [];
  const book = async (name, svc, size, slot, channel = 'text') => {
    const lead = store.createLead({ name, phone: `615-555-01${String(made.length + 10).slice(-2)}`, channel, presetId: business.id });
    store.addMessage(lead.id, 'customer', `Hi, I'd like to book a ${svc.name.toLowerCase()}.`, { channel: 'text' });
    const r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: svc.id, size, slotStart: slot.start, customerName: name });
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
  B.joinWaitlist(w.id, 'Saturday mornings');

  store.logActivity('Loaded a sample day: one paid job, one confirmed, one waiting on a deposit, one on the waitlist.', { kind: 'seed', presetId: business.id });
  return { bookings: made.length };
}
