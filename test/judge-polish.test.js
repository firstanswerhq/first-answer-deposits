// Fixes from the mock judge's report: the one-tap demo on a shared server, the scripted bots, owner money
// confirmations, the sample day, and honest labels. Demo mode (no PayPal or AI keys).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-judge-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.META_API_KEY = '';
process.env.OWNER_PASSCODE = '';
delete process.env.ALLOW_RESET;

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { scriptedCustomerReply, scriptedOwnerReply } = await import('../src/agent/scripted.js');
const { default: app } = await import('../src/server.js');

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, { body, biz, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (biz) h['x-biz'] = biz;
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const assistant = (body) => call('POST', '/api/assistant', { body }).then((r) => r.data);
const HEADLINE = "Book a deep clean for my 3-bedroom this Friday morning, keep it under $300. I'm Sarah.";

// ---------- 1. the headline one-tap demo works for every visitor ----------
test('the headline chip still gets an approval card after other visitors took Friday morning', async () => {
  store.resetAll();
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(await assistant({ sessionId: `visitor-${i}`, bizId: 'cleaning', text: HEADLINE }));
  for (const [i, r] of runs.entries()) {
    assert.ok(r.approval, `run ${i + 1} shows the approval card (${r.reply})`);
    assert.equal(r.approval.amount, 50);
    assert.doesNotMatch(r.reply, /Which one\?/);
  }
  assert.match(runs[0].reply, /^Done\. I held/);
  assert.match(runs[1].reply, /^(Friday morning was taken|This Friday is fully booked), so I held the closest open time instead/);
  const starts = runs.map((r) => store.getBooking(r.approval.bookingId).slotStart);
  assert.equal(new Set(starts).size, 4, 'four different times');
  // The second run stays on Friday (the nearest open time that day).
  assert.match(store.getBooking(runs[1].approval.bookingId).slotLabel, /^Fri/);
  // Once that Friday is full, the reply says so instead of quietly jumping a week.
  const firstDay = store.getBooking(runs[0].approval.bookingId).slotLabel.split(',').slice(0, 2).join(',');
  const fourth = store.getBooking(runs[3].approval.bookingId).slotLabel;
  if (!fourth.startsWith(firstDay)) assert.match(runs[3].reply, /^This Friday is fully booked, so I held the closest open time instead/);
});

// ---------- 3. the scripted front desk (no AI key) ----------
async function textThread(lines, presetId = 'cleaning') {
  const lead = store.createLead({ presetId });
  const replies = [];
  for (const t of lines) {
    store.addMessage(lead.id, 'customer', t);
    const r = await scriptedCustomerReply(store.getLead(lead.id));
    const said = r ?? store.getLead(lead.id).messages.at(-1).text;
    if (r) store.addMessage(lead.id, 'assistant', r);
    replies.push(said);
  }
  return { lead: store.getLead(lead.id), replies };
}

test('scripted desk: "2 bedroom" is a size, a new day gets new times, and "My name is Dana Cole" is a name', async () => {
  store.resetAll();
  const { lead, replies } = await textThread(['Hi, I need a deep clean', '2 bedroom', 'Friday', 'do you have Saturday?', '1', 'My name is Dana Cole']);
  assert.match(replies[0], /How many bedrooms/);
  assert.match(replies[1], /Deep clean for 1-2 bedrooms is \$220\. Open times/, '"2 bedroom" is not asked again');
  assert.match(replies[2], /1\) Fri/);
  assert.match(replies[3], /1\) Sat/);
  assert.doesNotMatch(replies[3], /Fri/, 'asking for Saturday never re-offers Friday');
  assert.match(replies[4], /first name/);
  assert.match(replies[5], /Got it, Dana! I'm holding Sat/);
  const b = B.activeBookingForLead(lead.id);
  assert.equal(b.customerName, 'Dana Cole');
});

test('README step 2 from a fresh visit: book, then "Can we do Saturday instead?" moves it, and "Can" is never a name', async () => {
  store.resetAll();
  const { lead, replies } = await textThread(['I need a deep clean for a 2 bedroom', '1', 'Can we do Saturday instead?', 'Dana', '1']);
  assert.match(replies[1], /first name/);
  assert.match(replies[2], /1\) Sat/, 'a day change before booking offers that day');
  assert.notEqual(store.getLead(lead.id).name, 'Can');
  assert.match(replies[3], /Thanks, Dana! Which time works/);
  assert.match(replies[4], /Got it, Dana! I'm holding Sat/);
  const b = B.activeBookingForLead(lead.id);
  const before = b.slotStart;
  const { replies: more } = await (async () => {
    const out = [];
    for (const t of ['Can we do Monday instead?', 'what about another day?', '2']) {
      store.addMessage(lead.id, 'customer', t);
      const r = await scriptedCustomerReply(store.getLead(lead.id));
      if (r) store.addMessage(lead.id, 'assistant', r);
      out.push(r ?? store.getLead(lead.id).messages.at(-1).text);
    }
    return { replies: out };
  })();
  assert.match(more[0], /Reply 1, 2 or 3: 1\) Mon/);
  const mondays = more[0].match(/\d\) ([A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, [\d:]+ [AP]M)/g);
  for (const m of mondays) assert.ok(!more[1].includes(m.slice(3)), `"another day" never repeats ${m}`);
  assert.doesNotMatch(more[1], /Mon,/);
  assert.match(more[2], /You're moved to/);
  assert.notEqual(store.getBooking(b.id).slotStart, before);
  assert.equal(store.listBookings().filter((x) => x.customerName === 'Can').length, 0);
});

test('scripted owner: the calendar question, and a future job needs a YES before it is marked done', async () => {
  store.resetAll();
  const lead = store.createLead({ presetId: 'cleaning' });
  const biz = B.businessById('cleaning');
  const slot = B.availableSlots(biz, { limit: 1 })[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: 'Marcus Lee' });
  B.completeDemoPayment(booking.payments[0].id);
  const day = slot.label.split(',')[0];
  const cal = await B.withBusiness(biz, () => scriptedOwnerReply(`what is on ${day}?`));
  assert.match(cal, /Marcus Lee/);
  assert.doesNotMatch(cal, /owes/);
  const ask = await B.withBusiness(biz, () => scriptedOwnerReply('done at Marcus'));
  assert.match(ask, /hasn't happened yet.*Reply YES or NO/);
  assert.equal(store.getBooking(booking.id).status, 'confirmed', 'nothing marked yet');
  assert.match(await B.withBusiness(biz, () => scriptedOwnerReply('no')), /nothing was changed/);
  assert.equal(store.getBooking(booking.id).status, 'confirmed');
  // Another business's office manager never sees Marcus.
  assert.match(await B.withBusiness(B.businessById('hvac'), () => scriptedOwnerReply('done at Marcus')), /couldn't find/);
});

// ---------- 8. owner money actions need a YES, and a which-one question for two Sarahs ----------
async function paidInFull(name, presetId = 'cleaning', slotIndex = 0) {
  const lead = store.createLead({ presetId });
  const biz = B.businessById(presetId);
  const slot = B.availableSlots(biz, { limit: slotIndex + 1 })[slotIndex];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: name });
  B.completeDemoPayment(booking.payments[0].id);
  await B.markCompleted(booking.id);
  const bal = store.getBooking(booking.id).payments.find((p) => p.kind === 'balance');
  B.completeDemoPayment(bal.id);
  return store.getBooking(booking.id);
}

test('"refund Sarah" asks which Sarah, then "Refund $260 to Sarah Kim? Reply YES", then one clean reference', async () => {
  store.resetAll();
  const biz = B.businessById('cleaning');
  const kim = await paidInFull('Sarah Kim', 'cleaning', 0);
  const lee = await paidInFull('Sarah Lee', 'cleaning', 1);
  const owner = (t) => B.withBusiness(biz, () => scriptedOwnerReply(t));
  const which = await owner('refund Sarah');
  assert.match(which, /Which Sarah\? 1\) Sarah (Kim|Lee).*2\) Sarah (Kim|Lee)/);
  assert.equal(B.totals(store.getBooking(kim.id)).refunded, 0, 'no money moved on the first message');
  const pickKim = which.indexOf('1) Sarah Kim') >= 0 ? '1' : '2';
  const confirm = await owner(pickKim);
  assert.equal(confirm, 'Refund $260 to Sarah Kim? Reply YES to send it back the way they paid, or NO.');
  assert.equal(B.totals(store.getBooking(kim.id)).refunded, 0, 'still nothing until YES');
  const done = await owner('YES');
  assert.match(done, /^Refunded \$260 to Sarah Kim\. Reference DEMO-REFUND-[0-9A-F]{6} \(demo money/);
  assert.doesNotMatch(done, /DEMO-REFUND-\w+, DEMO-REFUND/, 'the reference is not doubled');
  assert.equal(store.getBooking(kim.id).status, 'refunded');
  assert.equal(store.getBooking(lee.id).status, 'paid_in_full', 'the other Sarah is untouched');
  // A stray YES later does nothing.
  assert.doesNotMatch(await owner('yes'), /Refunded/);
  assert.equal(store.getBooking(lee.id).status, 'paid_in_full');
});

// ---------- 2. "email me an invoice" goes through the Invoicing path ----------
test('"Email me an invoice" asks for an email, records the deposit invoice (demo) and retires it when paid by link', async () => {
  store.resetAll();
  const { lead } = await textThread(['I need a deep clean for a 2 bedroom', '1', 'Dana']);
  const b = B.activeBookingForLead(lead.id);
  store.addMessage(lead.id, 'customer', 'Can you email me an invoice instead?');
  const ask = await scriptedCustomerReply(store.getLead(lead.id));
  assert.match(ask, /What email should I send the invoice to/);
  store.addMessage(lead.id, 'assistant', ask);
  store.addMessage(lead.id, 'customer', 'dana@example.com');
  const sent = await scriptedCustomerReply(store.getLead(lead.id));
  assert.match(sent, /invoice DEMO-INV-[0-9A-F]{6} for the \$50 deposit is recorded for dana@example\.com/);
  assert.match(sent, /no email actually goes out/);
  const dep = store.getBooking(b.id).payments[0];
  assert.equal(dep.invoice.status, 'sent');
  assert.equal(store.getBooking(b.id).customerEmail, 'dana@example.com');
  B.completeDemoPayment(dep.id);
  assert.equal(store.getBooking(b.id).payments[0].invoice.status, 'canceled', 'paid by link: the invoice is turned off');
  assert.equal(store.getBooking(b.id).status, 'confirmed');
});

// ---------- 9. sample day, reset, owed now, setup copy ----------
test('"Load a sample day" twice never duplicates, and "Reset demo" clears only this business', async () => {
  store.resetAll();
  const first = await call('POST', '/api/owner/seed', { biz: 'cleaning' });
  assert.equal(first.status, 200);
  assert.equal(first.data.bookings, 3);
  const before = await call('GET', '/api/owner/state', { biz: 'cleaning' });
  const second = await call('POST', '/api/owner/seed', { biz: 'cleaning' });
  assert.equal(second.data.already, true);
  const after = await call('GET', '/api/owner/state', { biz: 'cleaning' });
  assert.equal(after.data.bookings.length, before.data.bookings.length, 'no duplicate customers');
  assert.equal(after.data.summary.money.gross, before.data.summary.money.gross, 'the week summary does not jump');
  assert.equal(after.data.waitlist.length, 1);

  // A held booking owes its deposit now, not the full total.
  const held = after.data.bookings.find((b) => b.status === 'held');
  assert.equal(held.owedNow, held.deposit);
  assert.ok(held.totals.due > held.owedNow);

  // Another business's data and its owner chat survive a reset of this one.
  await call('POST', '/api/owner/seed', { biz: 'hvac' });
  await call('POST', '/api/owner/text', { biz: 'hvac', body: { text: 'who owes me?' } });
  // The same browser (visitor cookie) books with the assistant, then resets: its booking goes.
  const me = { cookie: 'fad_vid=0123456789abcdef01234567' };
  const extra = (await call('POST', '/api/assistant', { body: { sessionId: 'reset-visitor', bizId: 'cleaning', text: HEADLINE }, headers: me })).data;
  assert.ok(extra.approval);
  const hvacBefore = (await call('GET', '/api/owner/state', { biz: 'hvac' })).data;
  const reset = await call('POST', '/api/owner/reset-business', { biz: 'cleaning', headers: me });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.bookings, 3, 'a fresh sample day is loaded');
  const clean = (await call('GET', '/api/owner/state', { biz: 'cleaning' })).data;
  assert.equal(clean.bookings.length, 3);
  assert.ok(!store.getBooking(extra.approval.bookingId), 'demo bookings on this business are cleared');
  const hvacAfter = (await call('GET', '/api/owner/state', { biz: 'hvac' })).data;
  assert.equal(hvacAfter.bookings.length, hvacBefore.bookings.length);
  assert.equal(hvacAfter.ownerThread.length, hvacBefore.ownerThread.length);
  assert.ok(hvacAfter.ownerThread.length >= 2);
  // Wiping every business stays off unless the host allows it.
  assert.equal((await call('POST', '/api/owner/reset', { biz: 'cleaning' })).status, 403);
});

test('setup copy counts the real questions', async () => {
  const r = await call('GET', '/api/setup/steps');
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  assert.match(r.data.intro, new RegExp(`${words[r.data.steps.length]} quick questions`));
  assert.equal(r.data.steps.length, 8);
});

test('the owner thread on one business never shows another business\'s chat', async () => {
  store.resetAll();
  await call('POST', '/api/owner/text', { biz: 'hvac', body: { text: 'who owes me?' } });
  const cleaning = (await call('GET', '/api/owner/state', { biz: 'cleaning' })).data;
  assert.equal(cleaning.ownerThread.length, 0);
  const hvac = (await call('GET', '/api/owner/state', { biz: 'hvac' })).data;
  assert.equal(hvac.ownerThread.length, 2);
});
