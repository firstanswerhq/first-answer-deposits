// Setup by text: an owner's answers become a working business that customers can book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-setup-${process.pid}.json`);
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const S = await import('../src/setup.js');
const { replyToCustomer } = await import('../src/agent/customer.js');

test('eight answers make a bookable, branded business with a deposit and a payout email', async () => {
  store.resetAll();
  let profile = {};
  const answers = { name: 'Franklin Lawn Care', trade: 'lawn care', city: 'Franklin, TN', hours: 'Mon-Fri, 8am, 11am and 2pm', services: 'Mowing: small yard $45, large yard $65\nAeration: $120', deposit: '$25', brand: 'green, logo https://franklinlawn.example/logo.png', payout: 'pay@franklinlawn.example' };
  for (const step of S.STEPS) {
    const r = S.applyAnswer(step.id, answers[step.id], profile);
    assert.ok(r.ok, `${step.id}: ${r.say}`);
    profile = { ...profile, ...r.patch };
  }
  const biz = S.createBusiness(profile);
  assert.equal(biz.id, 'franklin-lawn-care');
  assert.deepEqual(biz.openDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(biz.slotTimes, ['08:00', '11:00', '14:00']);
  assert.equal(biz.deposit.amount, 25);
  assert.equal(biz.payoutEmail, 'pay@franklinlawn.example');
  assert.deepEqual(biz.brand, { color: '#1f9d55', logoUrl: 'https://franklinlawn.example/logo.png' });
  assert.deepEqual(S.parseBrand('skip'), { color: '', logoUrl: '' });
  assert.ok(B.businessById('franklin-lawn-care'));

  // A customer books the new business by text (scripted mode).
  const lead = store.createLead({ presetId: biz.id });
  const say = async (t) => {
    store.addMessage(lead.id, 'customer', t);
    const r = await replyToCustomer(lead.id);
    store.addMessage(lead.id, 'assistant', r);
    return r;
  };
  let r = await say('Hi, I need aeration');
  assert.match(r, /\$120/); // one size, so no size question
  r = await say('1');
  r = await say('Pat');
  assert.match(r, /\$25 deposit/);
  const b = B.activeBookingForLead(lead.id);
  assert.equal(b.presetId, biz.id);
  assert.equal(b.deposit, 25);

  // Paid in full -> payout recorded to the owner's PayPal email (demo mode records without moving money).
  B.completeDemoPayment(b.payments[0].id);
  const done = await B.markCompleted(b.id);
  const bal = store.getBooking(b.id).payments.find((p) => p.kind === 'balance');
  B.completeDemoPayment(bal.id);
  await new Promise((r) => setTimeout(r, 20));
  const paid = store.getBooking(b.id);
  assert.equal(paid.status, 'paid_in_full');
  assert.equal(paid.payout.amount, 120);
  assert.equal(paid.payout.email, 'pay@franklinlawn.example');
  assert.ok(done.payLink);

  // Setups survive a demo reset.
  store.resetAll();
  assert.ok(store.getBusiness(biz.id));
});
