import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-names-${process.pid}.json`);
process.env.FAD_NO_LISTEN = '1';
for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'META_API_KEY', 'OWNER_PASSCODE']) process.env[k] = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { seedIfEmpty } = await import('../src/seed.js');
const { presets, defaultPresetId } = await import('../src/business.js');
const { openSlots } = await import('../src/slots.js');

// "refund Sarah Kim" must find Sarah Kim even when another Sarah booked later; a first name alone still finds both.
test('a full-name search returns only the exact match; a partial name widens', async () => {
  store.resetAll();
  const biz = presets[defaultPresetId];
  await seedIfEmpty(biz);
  const lead = store.createLead({ name: 'Sarah', presetId: biz.id });
  const slot = openSlots(biz, store.listBookings())[0];
  await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'deep', size: '3 bedrooms', slotStart: slot.start, customerName: 'Sarah' });
  const kim = B.findBookingsByName('Sarah Kim');
  assert.equal(kim.length, 1);
  assert.equal(kim[0].customerName, 'Sarah Kim');
  const all = B.findBookingsByName('sarah');
  assert.ok(all.length >= 2, 'a first name alone still lists every Sarah');
});
