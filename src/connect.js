// Connections: the deposit system plugs into whatever a business already uses.
//  - Leads in:  any app (a lead app, GoHighLevel, Zapier, a web form) POSTs a lead; the AI answers it in seconds.
//  - Calendar:  one subscribe link puts every booking in Google, Apple or Outlook; a private iCal link marks busy times.
//  - Updates out: deposit paid, moved, refunded, paid in full go back to the business's CRM as signed webhooks.
import crypto from 'node:crypto';
import * as store from './store.js';
import * as B from './bookings.js';
import { config } from './config.js';
import { replyToCustomer } from './agent/customer.js';

// ---------- leads in ----------
export function leadInUrl(business) {
  return `${config.publicUrl}/api/leads/in/${business.id}`;
}

// Accepts the field names the common tools send (GoHighLevel, Zapier, Base44, plain forms).
function pick(body, names) {
  for (const n of names) {
    const v = body?.[n];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return '';
}

export async function leadIn(business, body = {}, { source = '' } = {}) {
  const first = pick(body, ['first_name', 'firstName', 'first']);
  const last = pick(body, ['last_name', 'lastName', 'last']);
  const name = pick(body, ['name', 'full_name', 'fullName', 'contact_name']) || [first, last].filter(Boolean).join(' ');
  const phone = pick(body, ['phone', 'phone_number', 'mobile', 'tel']);
  const email = pick(body, ['email', 'email_address']);
  const message = pick(body, ['message', 'text', 'notes', 'inquiry', 'description', 'body', 'service']) || 'Hi, I would like to book.';
  const src = source || pick(body, ['source', 'lead_source', 'platform', 'channel']) || 'web form';
  const lead = store.createLead({ name, phone, email, channel: `lead from ${src}`, presetId: business.id });
  store.updateLead(lead.id, { source: src });
  const started = Date.now();
  store.addMessage(lead.id, 'customer', message, { channel: 'text', source: src });
  const reply = await replyToCustomer(lead.id, { channel: 'text' });
  if (reply) store.addMessage(lead.id, 'assistant', reply, { channel: 'text' });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const howFast = seconds < 0.5 ? 'in under a second' : `in ${seconds}s`;
  store.logActivity(`New lead from ${src}: ${name || phone || 'someone'} asked "${message.slice(0, 60)}". The AI replied ${howFast}.`, { leadId: lead.id, kind: 'lead_in', source: src, presetId: business.id });
  return { leadId: lead.id, reply, seconds, threadUrl: `${config.publicUrl}/text?biz=${business.id}&lead=${lead.id}` };
}

// ---------- calendar out (.ics subscribe link) ----------
export function calendarUrl(business) {
  return `${config.publicUrl}/calendar/${business.id}.ics`;
}

const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);

export function calendarFor(business) {
  const keep = new Set(['held', 'confirmed', 'completed', 'paid_in_full']);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//First Answer//Deposits//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(business.name)} bookings`, 'X-PUBLISHED-TTL:PT15M'];
  for (const b of store.listBookings().filter((x) => x.presetId === business.id && keep.has(x.status))) {
    const t = B.totals(b);
    const end = new Date(Date.parse(b.slotStart) + (business.slotMinutes || 120) * 60000).toISOString();
    lines.push(
      'BEGIN:VEVENT',
      `UID:${b.id}@firstanswer`,
      `DTSTAMP:${icsDate(b.createdAt)}`,
      `DTSTART:${icsDate(b.slotStart)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsText(`${b.customerName}: ${b.service}${b.size === 'standard' ? '' : ` (${b.size})`}`)}`,
      `DESCRIPTION:${icsText(`${B.STATUS_WORDS[b.status] || b.status}. Total ${B.usd(t.total)}, paid ${B.usd(t.paid)}, owed ${B.usd(t.due)}. ${b.customerPhone || ''}`)}`,
      `STATUS:${b.status === 'held' ? 'TENTATIVE' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export { busyTimes, cachedBusy, parseIcs, isBusy, _setFetch } from './busy.js';

// ---------- updates out (signed webhooks to the business's CRM) ----------
let fetchImpl = (...a) => fetch(...a);
export function _setOutFetch(fn) {
  fetchImpl = fn;
}
export function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

const OUT_KINDS = new Set(['lead_in', 'deposit_requested', 'deposit_paid', 'reschedule', 'change', 'balance_requested', 'paid_in_full', 'refund', 'cancel', 'late_cancel', 'business_cancel', 'no_show', 'payout', 'release', 'handoff']);

export async function pushUpdate(item) {
  if (!OUT_KINDS.has(item.kind)) return;
  const booking = item.bookingId ? store.getBooking(item.bookingId) : null;
  const lead = item.leadId ? store.getLead(item.leadId) : booking ? store.getLead(booking.leadId) : null;
  const business = B.businessOf(booking || lead);
  if (!business?.webhookUrl) return;
  const payload = {
    event: item.kind,
    text: item.text,
    at: item.at,
    business: { id: business.id, name: business.name },
    customer: lead ? { name: lead.name, phone: lead.phone, email: lead.email, source: lead.source || null } : null,
    booking: booking ? { id: booking.id, status: booking.status, service: booking.service, appointment: booking.slotLabel, slotStart: booking.slotStart, ...B.totals(booking), page: B.bookingPageUrl(booking) } : null,
  };
  const body = JSON.stringify(payload);
  try {
    await fetchImpl(business.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FirstAnswer-Signature': sign(business.webhookSecret || 'firstanswer', body), 'X-FirstAnswer-Event': item.kind },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error('webhook out', err.message);
  }
}

// Every activity line with a known kind becomes an outbound update.
export function startPushing() {
  store.events.on('change', (evt) => {
    if (evt.kind === 'activity') pushUpdate(evt.payload).catch(() => {});
  });
}
