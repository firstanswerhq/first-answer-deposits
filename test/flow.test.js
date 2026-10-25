// End-to-end booking flow in demo mode (no PayPal keys, no AI key): scripted AI + demo checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-test-${process.pid}.json`);
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { replyToCustomer } = await import('../src/agent/customer.js');
const { ownerCommand } = await import('../src/agent/owner.js');

async function say(leadId, text) {
  store.addMessage(leadId, 'customer', text);
  const reply = await replyToCustomer(leadId);
  if (reply) store.addMessage(leadId, 'assistant', reply);
  return reply;
}

test('lead to paid deposit to balance with tip to repeat business', async () => {
  store.resetAll();
  store.setPreset('cleaning');
  const lead = store.createLead({ presetId: 'cleaning' });
  let r = await say(lead.id, 'Hi, I need a deep clean');
  assert.match(r, /bedrooms/i);
  r = await say(lead.id, '3 bedrooms');
  assert.match(r, /\$260/);
  r = await say(lead.id, '2');
  assert.match(r, /first name/i);
  r = await say(lead.id, 'Sarah');
  assert.match(r, /Total \$260/);
  assert.match(r, /Due now: a \$50 deposit/);
  assert.match(r, /Free to cancel or move until/);

  const b = B.activeBookingForLead(lead.id);
  assert.equal(b.status, 'held');
  assert.equal(b.payments.length, 1);
  const dep = b.payments[0];

  // Owner sees who owes
  const owes = await ownerCommand('who still owes a deposit?');
  assert.match(owes, /Sarah/);

  // Customer pays the deposit (demo checkout)
  B.completeDemoPayment(dep.id);
  let nb = store.getBooking(b.id);
  assert.equal(nb.status, 'confirmed');
  assert.equal(B.totals(nb).paid, 50);
  assert.match(store.getLead(lead.id).messages.at(-1).text, /confirmed/i);

  // Owner adds work; customer approves by text
  B.proposeChange(b.id, { description: 'Inside of the fridge', amount: 40 });
  r = await say(lead.id, 'yes');
  assert.equal(B.totals(store.getBooking(b.id)).total, 300);

  // Job done -> balance link -> paid with a tip
  const done = await ownerCommand('done at Sarah');
  assert.match(done, /250/);
  nb = store.getBooking(b.id);
  const bal = nb.payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  assert.equal(bal.amount, 250);
  B.completeDemoPayment(bal.id, { tip: 30 });
  nb = store.getBooking(b.id);
  assert.equal(nb.status, 'paid_in_full');
  assert.equal(B.totals(nb).tips, 30);

  // Repeat business
  const nudge = await B.sendRebookNudges({ force: true });
  assert.deepEqual(nudge.nudged, ['Sarah']);
  assert.match(store.getLead(lead.id).messages.at(-1).text, /Reply YES/);

  // Money summary
  const m = B.moneySummary({ days: 7 });
  assert.equal(m.gross, 330);
  assert.equal(m.tips, 30);
});

test('reschedule carries the deposit; cancel inside window refunds; cash stops reminders', async () => {
  store.resetAll();
  const lead = store.createLead({ presetId: 'cleaning' });
  const slots = B.availableSlots(B.currentBusiness(), { limit: 5 });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'standard', size: '3 bedrooms', slotStart: slots[4].start, customerName: 'Mike' });
  B.completeDemoPayment(booking.payments[0].id);
  const moved = await B.reschedule(booking.id, slots[3].start);
  assert.equal(moved.slotStart, slots[3].start);
  assert.equal(B.totals(moved).paid, 50);
  // slot 4 is open again
  assert.ok(B.availableSlots(B.currentBusiness(), { limit: 50 }).some((s) => s.start === slots[4].start));

  const c = await B.customerCancel(booking.id);
  if (Date.now() <= Date.parse(moved.freeCancelUntil)) {
    assert.equal(c.outcome, 'refunded');
    assert.equal(store.getBooking(booking.id).status, 'refunded');
  } else {
    assert.equal(c.outcome, 'kept_deposit');
  }

  // Cash payment voids open links
  const lead2 = store.createLead({ presetId: 'cleaning' });
  const s2 = B.availableSlots(B.currentBusiness(), { limit: 1 })[0];
  const r2 = await B.bookAndRequestDeposit({ leadId: lead2.id, serviceId: 'standard', size: '1-2 bedrooms', slotStart: s2.start, customerName: 'Ana' });
  B.recordOutsidePayment(r2.booking.id, { amount: 50, method: 'cash' });
  const after = store.getBooking(r2.booking.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(B.owing().filter((b) => b.id === after.id).length, 0);
});

test('split the deposit two ways confirms only when both pay', async () => {
  store.resetAll();
  const lead = store.createLead({ presetId: 'detailing' });
  const biz = B.businessOf(lead);
  const s = B.availableSlots(biz, { limit: 1 })[0];
  const r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'full', size: 'SUV or truck', slotStart: s.start, customerName: 'Dee' });
  assert.equal(r.booking.deposit, 57.25); // 25% of 229
  const split = await B.splitDue(r.booking.id, 2);
  assert.equal(split.links.length, 2);
  const pending = store.getBooking(r.booking.id).payments.filter((p) => p.status === 'pending');
  B.completeDemoPayment(pending[0].id);
  assert.equal(store.getBooking(r.booking.id).status, 'held');
  B.completeDemoPayment(pending[1].id);
  assert.equal(store.getBooking(r.booking.id).status, 'confirmed');
});

test('next-day bookings never show a free-cancel deadline that already passed', () => {
  const now = Date.now();
  const soon = new Date(now + 20 * 3600 * 1000).toISOString(); // tomorrow, inside 24 hours
  const later = new Date(now + 72 * 3600 * 1000).toISOString();
  assert.ok(Date.parse(B.freeCancelDeadline(soon, now)) >= now + 59 * 60 * 1000);
  assert.equal(B.freeCancelDeadline(later, now), new Date(Date.parse(later) - 24 * 3600 * 1000).toISOString());
});

test('payment page questions get real answers, not actions', async () => {
  store.resetAll();
  const lead = store.createLead({ presetId: 'cleaning' });
  const s = B.availableSlots(B.currentBusiness(), { limit: 3 })[2];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: s.start, customerName: 'Sarah' });
  let r = await say(lead.id, 'Is this refundable?');
  assert.match(r, /Cancel by .* comes right back/);
  assert.equal(store.getBooking(booking.id).status, 'held'); // nothing canceled
  r = await say(lead.id, 'Can I pay over time?');
  assert.match(r, /Pay Later/);
  r = await say(lead.id, 'Someone else is paying for this');
  assert.match(r, /\/p\/pay_/);
  r = await say(lead.id, 'Can we change the time?');
  assert.match(r, /Reply 1, 2 or 3/);
  // Wording with a day in it offers that day and the pick reschedules.
  store.updateLead(lead.id, { flow: {} });
  r = await say(lead.id, 'Can we do Saturday instead?');
  assert.match(r, /Reply 1, 2 or 3/);
  assert.match(r, /Sat/);
  r = await say(lead.id, '1');
  const moved = store.getBooking(booking.id);
  assert.notEqual(moved.slotStart, s.start);
  assert.match(moved.slotLabel, /Sat/);
});

test('business cancel offers new times; customer refund on request', async () => {
  store.resetAll();
  const lead = store.createLead({ presetId: 'hvac' });
  const biz = B.businessOf(lead);
  const s = B.availableSlots(biz, { limit: 1 })[0];
  const r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'tuneup', size: 'one system', slotStart: s.start, customerName: 'Lou' });
  B.completeDemoPayment(r.booking.payments[0].id);
  const bc = await B.businessCancel(r.booking.id, 'tech is out sick');
  assert.ok(bc.options.length >= 1);
  assert.equal(store.getBooking(r.booking.id).status, 'needs_rebook');
  const ref = await B.refund(r.booking.id, { reason: 'Customer chose refund' });
  assert.equal(ref.refunded, 49);
  assert.equal(store.getBooking(r.booking.id).status, 'refunded');
  const ev = B.evidence(r.booking.id);
  assert.ok(ev.timeline.length >= 3);
});
