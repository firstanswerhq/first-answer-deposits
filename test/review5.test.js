// Fifth review (demo mode): the owner's YES gates (stale questions and the AI asking and confirming in one turn),
// split deposits released with a share paid, refunds after the job, the agent demo under load, Reset demo scoped
// to the visitor, test disputes on holds, payouts, the vault id on public pages, invoice limits, no-shows early.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-review5-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'META_API_KEY', 'OWNER_PASSCODE']) process.env[k] = '';
delete process.env.ALLOW_RESET;

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { _setModelForTests } = await import('../src/agent/model.js');
const { ownerCommand } = await import('../src/agent/owner.js');
const { seedSampleDay } = await import('../src/seed.js');
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

let ipn = 0;
async function call(method, url, { body, biz, cookie, ip } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-forwarded-for': ip || `10.77.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}` };
  if (biz) headers['x-biz'] = biz;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})), setCookie: res.headers.get('set-cookie') };
}
const say = async (biz, text) => (await call('POST', '/api/owner/text', { body: { text }, biz, ip: '10.50.0.9' })).data.reply || '';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 }, raw: {} };
const text = (t) => ({ content: [{ type: 'text', text: t }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] });
let k = 0;
const toolCall = (name, input) => ({ content: [{ type: 'tool-call', toolCallId: `c${k++}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] });

// ---------- 2. a YES to an old question never moves a different amount ----------
test('YES to "Refund $X" re-asks when the booking changed since (the customer paid the balance meanwhile)', async () => {
  store.resetAll();
  await call('POST', '/api/owner/reset-business', { biz: 'detailing', ip: '10.50.0.9' });
  const st = await call('GET', '/api/owner/state', { biz: 'detailing', ip: '10.50.0.9' });
  const marcus = st.data.bookings.find((b) => b.customerName === 'Marcus Lee');
  const q = await say('detailing', 'refund marcus');
  const askedAmount = Number(q.match(/Refund \$(\d+(?:\.\d+)?)/)[1]);
  // Meanwhile: the job is done and the customer pays the balance plus a $40 tip.
  const d = await call('POST', `/api/owner/bookings/${marcus.id}/done`, { biz: 'detailing', ip: '10.50.0.9' });
  const bal = d.data.result.booking.payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  await call('POST', `/api/pay/${bal.id}/capture`, { body: { tip: 40 } });
  const paidNow = B.totals(store.getBooking(marcus.id));
  const r = await say('detailing', 'yes');
  assert.match(r, /changed since I asked/);
  assert.match(r, new RegExp(`Refund \\$${paidNow.paid + paidNow.tips}`));
  assert.equal(B.totals(store.getBooking(marcus.id)).refunded, 0, `nothing refunded on the stale YES (asked ${askedAmount})`);
  // A YES to the new question does it.
  const r2 = await say('detailing', 'YES');
  assert.match(r2, /Refunded/);
  assert.equal(store.getBooking(marcus.id).status, 'refunded');
});

// ---------- 3. the AI office manager cannot ask and confirm in the same turn ----------
test('AI owner gate: a model that asks then calls confirmed:true in the same turn is refused; the owner sees the question; a later YES works', async () => {
  store.resetAll();
  const biz = B.businessById('cleaning');
  await B.withBusiness(biz, () => seedSampleDay(biz));
  const sarah = store.listBookings().find((b) => b.customerName === 'Sarah Kim');
  let step = 0;
  _setModelForTests({
    model: new MockLanguageModelV4({
      doGenerate: async () => {
        step++;
        if (step === 1) return toolCall('refund', { bookingId: sarah.id });
        if (step === 2) return toolCall('refund', { bookingId: sarah.id, confirmed: true });
        return text('Done, refunded.');
      },
    }),
    name: 'mock',
    provider: 'anthropic',
  });
  try {
    const reply = await B.withBusiness(biz, () => ownerCommand('ok refund Sarah Kim'));
    assert.equal(store.getBooking(sarah.id).status, 'paid_in_full', 'not refunded in the same turn');
    assert.match(reply, /Refund \$\d+.*to Sarah Kim\? Reply YES/, 'the owner is shown the exact question');
    // "ok sure" is not an exact YES.
    step = 1;
    await B.withBusiness(biz, () => ownerCommand('ok sure whatever'));
    assert.equal(store.getBooking(sarah.id).status, 'paid_in_full');
    // A plain YES, its own message after the question: the model's confirmed call goes through.
    step = 1;
    await B.withBusiness(biz, () => ownerCommand('YES'));
    assert.equal(store.getBooking(sarah.id).status, 'refunded');
  } finally {
    _setModelForTests(null);
  }
});

// A booking an AI assistant made, deposit paid with a spending limit (demo money).
async function agentPaid(name, limit, { slot = 0 } = {}) {
  const biz = B.businessById('cleaning');
  const s = B.availableSlots(biz, { limit: slot + 1 })[slot];
  const lead = store.createLead({ presetId: 'cleaning' });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: s.start, customerName: name });
  store.updateBooking(booking.id, { source: 'agent', bookedBy: 'Claude' });
  B.completeDemoPayment(booking.payments[0].id, limit ? { mandate: { limit } } : {});
  return store.getBooking(booking.id);
}

// ---------- 6. a partial refund after the job is never billed back ----------
test('partial refund after the job: the balance link is re-priced, pay_balance settles it, the booking is paid in full', async () => {
  store.resetAll();
  const b = await agentPaid('Refy After', 300);
  await B.markCompleted(b.id);
  const before = B.totals(store.getBooking(b.id));
  const link = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  await B.refund(b.id, { amount: 20 });
  let nb = store.getBooking(b.id);
  const t = B.totals(nb);
  assert.equal(t.due, before.due, 'the refund does not add to what is owed');
  assert.equal(nb.payments.find((p) => p.id === link.id).amount, t.due, 'the link asks for exactly what is due');
  const r = await B.payWithMandate(b.id, { agent: 'Claude' });
  assert.equal(r.paid, true);
  nb = store.getBooking(b.id);
  assert.equal(nb.status, 'paid_in_full');
  assert.equal(B.totals(nb).due, 0);
  assert.equal((await B.payWithMandate(b.id, {})).reason, 'nothing_due');
  assert.ok(nb.payout, 'paid out once paid in full');
});

test('a done job owing money with no open link gets one (remind and pay_balance never dead-end)', async () => {
  store.resetAll();
  const b = await agentPaid('Stuck', 300, { slot: 1 });
  await B.markCompleted(b.id);
  const link = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  store.updatePayment(link.id, { status: 'void' }); // the old stuck state
  const nb = await B.remind(b.id);
  const fresh = nb.payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  assert.ok(fresh, 'a fresh final-bill link');
  assert.equal(fresh.amount, B.totals(nb).due);
  assert.equal((await B.payWithMandate(b.id, { agent: 'Claude' })).paid, true);
});
