// Connections: leads in from any app, the calendar feed, busy times from an iCal link, signed updates out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-connect-${process.pid}.json`);
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const S = await import('../src/setup.js');
const C = await import('../src/connect.js');
const busy = await import('../src/busy.js');

function makeBiz(extra = {}) {
  return S.createBusiness({ name: `Test Biz ${Math.random().toString(36).slice(2, 6)}`, trade: 'lawn care', city: 'Franklin, TN', services: [{ id: 'mowing', name: 'Mowing', sizes: { standard: 45 } }], deposit: { type: 'flat', amount: 20 }, ...extra });
}

test('a lead posted from another app gets an AI answer and shows up for the owner', async () => {
  store.resetAll();
  const biz = makeBiz();
  const r = await C.leadIn(biz, { first_name: 'Dana', last_name: 'Whitfield', phone: '615-555-0142', message: 'Hi, I need mowing' }, { source: 'Base44 lead app' });
  assert.match(r.reply, /\$45/);
  assert.ok(r.threadUrl.includes(`lead=${r.leadId}`));
  const lead = store.getLead(r.leadId);
  assert.equal(lead.name, 'Dana Whitfield');
  assert.equal(lead.presetId, biz.id);
  assert.match(store.listActivity()[0].text, /New lead from Base44 lead app: Dana Whitfield/);
});

test('calendar feed lists bookings; busy times from an iCal link block slots', async () => {
  store.resetAll();
  const biz = makeBiz();
  const slots = B.availableSlots(biz, { limit: 3 });
  const lead = store.createLead({ presetId: biz.id });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'mowing', size: 'standard', slotStart: slots[0].start, customerName: 'Pat' });
  const ics = C.calendarFor(biz);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:Pat: Mowing/);
  assert.match(ics, new RegExp(`UID:${booking.id}@firstanswer`));

  // Owner's own calendar says they're busy during the second slot.
  const b2 = slots[1].start;
  const fmt = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const busyIcs = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${fmt(b2)}\r\nDTEND:${fmt(new Date(Date.parse(b2) + 3600000).toISOString())}\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  busy._setFetch(async () => ({ text: async () => busyIcs }));
  store.saveBusiness({ ...biz, busyCalendarUrl: 'https://example.test/private.ics' });
  const withBusy = B.businessById(biz.id);
  await busy.busyTimes(withBusy);
  const open = B.availableSlots(withBusy, { limit: 10 }).map((s) => s.start);
  assert.ok(!open.includes(b2), 'busy slot is hidden');
  assert.ok(!open.includes(slots[0].start), 'booked slot is hidden');
  await assert.rejects(B.bookAndRequestDeposit({ leadId: store.createLead({ presetId: biz.id }).id, serviceId: 'mowing', size: 'standard', slotStart: b2, customerName: 'Lee' }), /no longer open/);
});

test('updates go out to the CRM webhook with a valid signature', async () => {
  store.resetAll();
  const calls = [];
  C._setOutFetch(async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body });
    return { ok: true };
  });
  const biz = makeBiz({ webhookUrl: 'https://crm.example/hook', webhookSecret: 's3cret' });
  store.saveBusiness({ ...biz, webhookUrl: 'https://crm.example/hook', webhookSecret: 's3cret' });
  C.startPushing();
  const slot = B.availableSlots(B.businessById(biz.id), { limit: 1 })[0];
  const lead = store.createLead({ presetId: biz.id, name: 'Sam' });
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'mowing', size: 'standard', slotStart: slot.start, customerName: 'Sam' });
  B.completeDemoPayment(booking.payments[0].id);
  await new Promise((r) => setTimeout(r, 30));
  const events = calls.map((c) => JSON.parse(c.body).event);
  assert.ok(events.includes('deposit_requested'));
  assert.ok(events.includes('deposit_paid'));
  const last = calls.at(-1);
  assert.equal(last.headers['X-FirstAnswer-Signature'], crypto.createHmac('sha256', 's3cret').update(last.body).digest('hex'));
  assert.equal(JSON.parse(last.body).booking.paid, 20);
});
