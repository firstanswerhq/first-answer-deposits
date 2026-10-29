// Agentic commerce in demo mode: an outside AI assistant books over MCP, the human approves in PayPal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-agentic-${process.pid}.json`);
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { mountAgentic } = await import('../src/agentic/index.js');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  mountAgentic(app);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function connect(bizId) {
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${bizId}`)));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, data: r.isError ? null : r.structuredContent ?? JSON.parse(r.content[0].text) };
  };
  return { client, call };
}

test('an outside assistant lists tools, quotes, books under budget and reads status with its key', async () => {
  store.resetAll();
  const { client, call } = await connect('cleaning');
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ['get_business_info', 'check_availability', 'get_quote', 'book_appointment', 'get_booking_status', 'reschedule_booking', 'cancel_booking', 'pay_balance']);
    assert.equal(tools.find((t) => t.name === 'get_quote').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'book_appointment').annotations.readOnlyHint, false);
    assert.match(client.getInstructions(), /cannot pay/);

    const info = (await call('get_business_info')).data;
    assert.equal(info.name, 'Sparkle & Shine Home Cleaning');
    assert.ok(info.payment.methods.includes('Venmo'));
    assert.equal(info.payment.account_needed, false);
    assert.match(info.mcp_endpoint, /\/mcp\/cleaning$/);

    const q = (await call('get_quote', { service: 'Deep clean', size: '3 bedrooms' })).data;
    assert.equal(q.price, 260);
    assert.equal(q.deposit_due_now, 50);
    assert.equal(q.balance_after, 210);

    const av = (await call('check_availability', { day: 'friday', count: 3 })).data;
    assert.ok(av.slots.length >= 1);
    assert.match(av.slots[0].label, /^Fri/);

    // Over budget: nothing is booked, the quote comes back.
    const over = await call('book_appointment', { service: 'deep', size: '3 bedrooms', slot_start: av.slots[0].start, customer_name: 'Sarah', max_total: 200, agent_name: 'Claude' });
    assert.equal(over.isError, undefined);
    assert.equal(over.data.booked, false);
    assert.equal(over.data.reason, 'over_budget');
    assert.equal(over.data.quote.price, 260);
    assert.equal(store.listBookings().length, 0);

    // Under budget: held, approval link for the human, nothing paid.
    const bk = (await call('book_appointment', { service: 'deep', size: '3 bedrooms', slot_start: av.slots[0].start, customer_name: 'Sarah', customer_phone: '615-555-0100', max_total: 300, agent_name: 'Claude' })).data;
    assert.equal(bk.booked, true);
    assert.equal(bk.status, 'held');
    assert.equal(bk.human_approval_required, true);
    assert.match(bk.approval_url, /\/p\/pay_/);
    assert.equal(bk.total, 260);
    assert.equal(bk.deposit, 50);
    assert.equal(bk.hold_minutes, 120);
    assert.match(bk.terms, /Due now: a \$50 deposit/);
    assert.ok(bk.booking_key.length >= 8);

    const booking = store.getBooking(bk.booking_id);
    assert.equal(booking.status, 'held');
    assert.equal(booking.bookedBy, 'Claude');
    assert.equal(booking.source, 'agent');
    assert.equal(B.totals(booking).paid, 0);
    const lead = store.getLead(booking.leadId);
    assert.equal(lead.channel, 'AI assistant (MCP)');
    assert.equal(lead.bookedBy, 'Claude');
    assert.match(store.listActivity()[0].text, /^Claude \(AI assistant\) booked Sarah: Deep clean, 3 bedrooms/);

    // Status with the right key; a wrong key is refused.
    const st = (await call('get_booking_status', { booking_id: bk.booking_id, booking_key: bk.booking_key })).data;
    assert.equal(st.status, 'held');
    assert.equal(st.approval_url, bk.approval_url);
    const bad = await call('get_booking_status', { booking_id: bk.booking_id, booking_key: 'wrong' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /No booking matches/);
    const badCancel = await call('cancel_booking', { booking_id: bk.booking_id, booking_key: 'wrong' });
    assert.equal(badCancel.isError, true);
    assert.equal(store.getBooking(bk.booking_id).status, 'held');

    // The human approves in PayPal (demo checkout); the agent sees it confirmed. Money moved once, by the human.
    const pending = store.getBooking(bk.booking_id).payments.find((p) => p.status === 'pending');
    assert.equal(`${B.payPageUrl(pending)}`, bk.approval_url);
    B.completeDemoPayment(pending.id);
    const after = (await call('get_booking_status', { booking_id: bk.booking_id, booking_key: bk.booking_key })).data;
    assert.equal(after.status, 'confirmed');
    assert.equal(after.paid, 50);
    assert.equal(after.human_approval_required, false);

    // Reschedule keeps the money; cancel inside the window refunds it.
    const next = av.slots.find((s) => s.start !== av.slots[0].start) || (await call('check_availability', { count: 5 })).data.slots.at(-1);
    const moved = (await call('reschedule_booking', { booking_id: bk.booking_id, booking_key: bk.booking_key, slot_start: next.start })).data;
    assert.equal(moved.moved, true);
    assert.equal(moved.paid, 50);
    assert.equal(moved.slot_start, next.start);
    const canceled = (await call('cancel_booking', { booking_id: bk.booking_id, booking_key: bk.booking_key })).data;
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.outcome, 'refunded');
    assert.equal(canceled.refunded, 50);
  } finally {
    await client.close();
  }
});

test('the endpoint is stateless, CORS-open, and 405 on GET; unknown business is 404', async () => {
  const get = await fetch(`${base}/mcp/cleaning`);
  assert.equal(get.status, 405);
  const opt = await fetch(`${base}/mcp/cleaning`, { method: 'OPTIONS', headers: { Origin: 'https://claude.ai', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
  assert.match(opt.headers.get('access-control-expose-headers'), /Mcp-Session-Id/);
  const missing = await fetch(`${base}/mcp/nope`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(missing.status, 404);
  // Plain /mcp is the current business.
  const { client, call } = await connect('');
  try {
    const info = (await call('get_business_info')).data;
    assert.equal(info.id, B.currentBusiness().id);
  } finally {
    await client.close();
  }
});

test('discovery files describe the business, the MCP binding and the PayPal handler', async () => {
  const ucp = await (await fetch(`${base}/.well-known/ucp?biz=detailing`)).json();
  assert.equal(ucp.ucp.services['com.firstanswer.booking'].transport, 'mcp');
  assert.equal(ucp.ucp.services['com.firstanswer.booking'].endpoint, `${base}/mcp/detailing`);
  assert.equal(ucp.payment.handlers[0].name, 'com.paypal.checkout');
  assert.equal(ucp.payment.handlers[0].agent_can_pay, false);
  assert.ok(ucp.payment.handlers[0].supports.includes('pay_later'));
  assert.match(ucp.ucp.note, /Not a certified/);
  assert.equal(ucp.business.name, 'Gloss Boss Mobile Detailing');

  const card = await (await fetch(`${base}/.well-known/agent-card.json?biz=hvac`)).json();
  assert.equal(card.provider.organization, 'First Answer');
  assert.deepEqual(card.skills.map((s) => s.id), ['availability', 'quote', 'book', 'changes']);
  assert.equal(card.url, `${base}/mcp/hvac`);

  const llms = await fetch(`${base}/llms.txt?biz=cleaning`);
  assert.match(llms.headers.get('content-type'), /text\/plain/);
  const text = await llms.text();
  assert.match(text, /# Sparkle & Shine Home Cleaning/);
  assert.match(text, new RegExp(`POST ${base}/mcp/cleaning`));
  assert.match(text, /You cannot pay/);
});

test("the customer's scripted assistant books through MCP end to end and hands back one approval", async () => {
  store.resetAll();
  const post = async (body) => {
    const r = await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  const r = await post({ sessionId: 'test-sarah', bizId: 'cleaning', text: "Book a deep clean for my 3-bedroom this Friday morning, keep it under $300. I'm Sarah." });
  assert.deepEqual(
    r.trace.map((t) => t.tool),
    ['get_business_info', 'get_quote', 'check_availability', 'book_appointment'],
  );
  assert.equal(r.trace[1].args.size, '3 bedrooms');
  assert.equal(r.trace[2].args.day, 'friday');
  assert.equal(r.trace[3].args.max_total, 300);
  assert.equal(r.trace[3].args.customer_name, 'Sarah');
  assert.match(r.trace[3].result.appointment, /^Fri.*AM$/);
  assert.ok(r.approval, 'approval returned');
  assert.equal(r.approval.amount, 50);
  assert.match(r.approval.url, /\/p\/pay_/);
  assert.match(r.reply, /can't pay the deposit for you/);
  assert.match(r.reply, /\$50/);
  assert.equal(r.endpoint, `${base}/mcp/cleaning`);
  const booking = store.getBooking(r.approval.bookingId);
  assert.equal(booking.status, 'held');
  assert.equal(booking.customerName, 'Sarah');
  assert.equal(booking.source, 'agent');

  // Follow-ups use the key the assistant kept.
  const st = await post({ sessionId: 'test-sarah', text: 'Did I pay yet?' });
  assert.equal(st.trace[0].tool, 'get_booking_status');
  assert.match(st.reply, /approve the \$50/i);

  // Missing facts get one short question, and the session remembers.
  const q1 = await post({ sessionId: 'test-marcus', bizId: 'detailing', text: 'I want a full detail this week' });
  assert.equal(q1.approval, null);
  assert.match(q1.reply, /car, or an SUV or truck/);
  const q2 = await post({ sessionId: 'test-marcus', text: 'SUV' });
  assert.match(q2.reply, /What name/);
  const q3 = await post({ sessionId: 'test-marcus', text: 'Marcus' });
  assert.ok(q3.approval);
  assert.equal(q3.approval.amount, 57.25);
  assert.equal(q3.trace.map((t) => t.tool).at(-1), 'book_appointment');

  // Over budget: the assistant stops and asks instead of booking.
  const ob = await post({ sessionId: 'test-dana', bizId: 'cleaning', text: "Move-out clean for 4 bedrooms under $200, I'm Dana" });
  assert.equal(ob.approval, null);
  assert.match(ob.reply, /over your \$200 budget, so I did not book/);
  assert.equal(store.listBookings().filter((b) => b.customerName === 'Dana').length, 0);
});
