// Tiny JSON-file store. Good enough for a demo; swap for a real database in production.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { defaultPresetId } from './business.js';

export const events = new EventEmitter();
events.setMaxListeners(100);

const empty = () => ({
  settings: { presetId: defaultPresetId },
  businesses: {},
  leads: [],
  bookings: [],
  waitlist: [],
  ownerThread: [],
  ownerPending: {},
  activity: [],
});

let db = load();
let saveTimer = null;

function load() {
  try {
    const raw = fs.readFileSync(config.dataFile, 'utf8');
    return { ...empty(), ...JSON.parse(raw) };
  } catch {
    return empty();
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
      const tmp = config.dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, config.dataFile);
    } catch (err) {
      console.error('Could not save data file:', err.message);
    }
  }, 50);
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function changed(kind, payload) {
  persist();
  events.emit('change', { kind, payload, at: new Date().toISOString() });
}

// ---------- settings ----------
export function getSettings() {
  return db.settings;
}
export function setPreset(presetId) {
  db.settings.presetId = presetId;
  changed('settings', db.settings);
}

// ---------- businesses set up by owners (presets live in business.js) ----------
export function getBusiness(id) {
  return db.businesses[id] || null;
}
export function listBusinesses() {
  return Object.values(db.businesses).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
export function saveBusiness(business) {
  db.businesses[business.id] = { ...(db.businesses[business.id] || {}), ...business, updatedAt: new Date().toISOString() };
  changed('business', { id: business.id });
  return db.businesses[business.id];
}

// ---------- leads + conversation ----------
export function createLead({ name = '', phone = '', email = '', channel = 'web chat', presetId }) {
  const lead = {
    id: newId('lead'),
    name,
    phone,
    email,
    channel,
    presetId: presetId || db.settings.presetId,
    status: 'new',
    createdAt: new Date().toISOString(),
    firstReplyMs: null,
    messages: [],
  };
  db.leads.unshift(lead);
  changed('lead', lead);
  return lead;
}

export function getLead(id) {
  return db.leads.find((l) => l.id === id) || null;
}

export function listLeads() {
  return db.leads;
}

export function updateLead(id, patch) {
  const lead = getLead(id);
  if (!lead) return null;
  Object.assign(lead, patch);
  changed('lead', lead);
  return lead;
}

export function addMessage(leadId, role, text, extra = {}) {
  const lead = getLead(leadId);
  if (!lead) return null;
  const msg = { role, text, at: new Date().toISOString(), ...extra };
  lead.messages.push(msg);
  if (role === 'assistant' && lead.firstReplyMs === null) {
    const firstCustomer = lead.messages.find((m) => m.role === 'customer');
    if (firstCustomer) lead.firstReplyMs = Date.parse(msg.at) - Date.parse(firstCustomer.at);
  }
  changed('message', { leadId, msg });
  return msg;
}

// ---------- bookings ----------
// A booking is the one shared record: what is booked, what is paid, what is owed, what happens if plans change.
export function createBooking(data) {
  const booking = {
    id: newId('bk'),
    secret: crypto.randomBytes(8).toString('hex'), // manage key: the MCP booking_key that can move or cancel
    viewKey: crypto.randomBytes(8).toString('hex'), // view-only key for the booking page link (safe to forward)
    status: 'held', // held | confirmed | completed | paid_in_full | canceled | refunded | no_show
    createdAt: new Date().toISOString(),
    reminders: 0,
    changes: [],
    payments: [],
    timeline: [],
    ...data,
  };
  db.bookings.unshift(booking);
  changed('booking', booking);
  return booking;
}

export function getBooking(id) {
  return db.bookings.find((b) => b.id === id) || null;
}

export function listBookings() {
  return db.bookings;
}

export function updateBooking(id, patch) {
  const booking = getBooking(id);
  if (!booking) return null;
  Object.assign(booking, patch);
  changed('booking', booking);
  return booking;
}

export function addTimeline(bookingId, text) {
  const booking = getBooking(bookingId);
  if (!booking) return;
  booking.timeline.push({ at: new Date().toISOString(), text });
  changed('booking', booking);
}

export function addPayment(bookingId, data) {
  const booking = getBooking(bookingId);
  if (!booking) return null;
  const payment = { id: newId('pay'), status: 'pending', createdAt: new Date().toISOString(), ...data };
  booking.payments.push(payment);
  changed('booking', booking);
  return payment;
}

export function updatePayment(paymentId, patch) {
  for (const b of db.bookings) {
    const p = b.payments.find((x) => x.id === paymentId);
    if (p) {
      Object.assign(p, patch);
      changed('booking', b);
      return { booking: b, payment: p };
    }
  }
  return null;
}

export function findPayment(paymentId) {
  for (const b of db.bookings) {
    const p = b.payments.find((x) => x.id === paymentId);
    if (p) return { booking: b, payment: p };
  }
  return null;
}

export function findPaymentBy(field, value) {
  if (!value) return null;
  for (const b of db.bookings) {
    const p = b.payments.find((x) => x[field] === value);
    if (p) return { booking: b, payment: p };
  }
  return null;
}

// ---------- waitlist ----------
export function addToWaitlist(entry) {
  const item = { id: newId('wl'), createdAt: new Date().toISOString(), status: 'waiting', ...entry };
  db.waitlist.push(item);
  changed('waitlist', item);
  return item;
}

export function listWaitlist() {
  return db.waitlist;
}

export function updateWaitlist(id, patch) {
  const item = db.waitlist.find((w) => w.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  changed('waitlist', item);
  return item;
}

// ---------- owner's text thread with the AI ----------
// seq: a counter that only goes up, so "a message that arrived after the question" never depends on clock ticks.
export function addOwnerMessage(role, text, extra = {}) {
  db.ownerSeq = (db.ownerSeq || 0) + 1;
  const msg = { role, text, at: new Date().toISOString(), seq: db.ownerSeq, ...extra };
  db.ownerThread.push(msg);
  db.ownerThread = db.ownerThread.slice(-200);
  changed('owner_message', msg);
  return msg;
}

export function listOwnerMessages(presetId = null) {
  return presetId ? db.ownerThread.filter((m) => m.presetId === presetId) : db.ownerThread;
}

// A money action the owner's AI asked about ("Refund $260 to Sarah Kim? Reply YES"), per business, until answered.
export function getOwnerPending(presetId) {
  const p = (db.ownerPending || {})[presetId];
  // Questions go stale after 15 minutes so an old YES never refunds anyone.
  if (p && Date.now() - Date.parse(p.at) > 15 * 60 * 1000) return null;
  return p || null;
}
export function setOwnerPending(presetId, pending) {
  db.ownerPending = db.ownerPending || {};
  if (pending) db.ownerPending[presetId] = { ...pending, at: new Date().toISOString(), afterSeq: db.ownerSeq || 0 };
  else delete db.ownerPending[presetId];
  persist();
}

// ---------- activity log (shown on the owner screen) ----------
export function logActivity(text, extra = {}) {
  const item = { id: newId('act'), text, at: new Date().toISOString(), ...extra };
  db.activity.unshift(item);
  db.activity = db.activity.slice(0, 200);
  changed('activity', item);
  return item;
}

export function listActivity() {
  return db.activity;
}

// ---------- one business's demo data ----------
// Clears the records of one business that removeBooking() picks (and their leads, waitlist entries and activity),
// plus leads, owner chat and waitlist entries that removeLead()/removeOwnerMessage() pick. Other businesses, and
// everything not picked, are never touched.
export function clearBusinessData(presetId, { removeBooking = () => true, removeLead = () => true, removeOwnerMessage = () => true } = {}) {
  const mine = db.bookings.filter((b) => b.presetId === presetId);
  const gone = new Set(mine.filter((b) => removeBooking(b)).map((b) => b.id));
  const keptLeads = new Set(db.bookings.filter((b) => !gone.has(b.id)).map((b) => b.leadId));
  const goneLeads = new Set(
    db.leads
      .filter((l) => l.presetId === presetId && !keptLeads.has(l.id))
      .filter((l) => mine.some((b) => gone.has(b.id) && b.leadId === l.id) || removeLead(l))
      .map((l) => l.id),
  );
  db.bookings = db.bookings.filter((b) => !gone.has(b.id));
  db.leads = db.leads.filter((l) => !goneLeads.has(l.id));
  db.waitlist = db.waitlist.filter((w) => !(w.presetId === presetId && goneLeads.has(w.leadId)));
  db.activity = db.activity.filter((a) => !(gone.has(a.bookingId) || goneLeads.has(a.leadId) || (a.presetId === presetId && a.kind === 'seed')));
  db.ownerThread = db.ownerThread.filter((m) => !(m.presetId === presetId && removeOwnerMessage(m)));
  if (db.ownerPending) delete db.ownerPending[presetId];
  changed('reset', { presetId });
  return { bookings: gone.size, kept: mine.length - gone.size };
}

// ---------- demo reset ----------
export function resetAll() {
  const { presetId } = db.settings;
  const businesses = db.businesses;
  db = empty();
  db.settings.presetId = presetId;
  db.businesses = businesses; // owners' setups survive a demo reset
  changed('reset', {});
}

export function _replaceForTests(next) {
  db = { ...empty(), ...next };
}
