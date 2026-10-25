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
  leads: [],
  bookings: [],
  waitlist: [],
  ownerThread: [],
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
    secret: crypto.randomBytes(8).toString('hex'), // lets the customer open their booking page with no login
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
export function addOwnerMessage(role, text, extra = {}) {
  const msg = { role, text, at: new Date().toISOString(), ...extra };
  db.ownerThread.push(msg);
  db.ownerThread = db.ownerThread.slice(-200);
  changed('owner_message', msg);
  return msg;
}

export function listOwnerMessages() {
  return db.ownerThread;
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

// ---------- demo reset ----------
export function resetAll() {
  const presetId = db.settings.presetId;
  db = empty();
  db.settings.presetId = presetId;
  changed('reset', {});
}

export function _replaceForTests(next) {
  db = { ...empty(), ...next };
}
