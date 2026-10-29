// One MCP server per business. Any AI assistant (Claude, ChatGPT, a custom agent) connects over HTTP,
// reads prices and open times, and books. It can never pay: the booking is held and the human approves
// the deposit on the PayPal page. Stateless Streamable HTTP: a fresh server and transport per request.
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as store from '../store.js';
import * as B from '../bookings.js';
import { localDate } from '../slots.js';
import { findService, defaultPresetId } from '../business.js';
import { config } from '../config.js';
import { makeRateLimiter } from '../client-ip.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const HOLD_MINUTES = () => Number(process.env.HOLD_MINUTES || 120);
export const PAYMENT_METHODS = ['PayPal', 'Venmo', 'PayPal Pay Later', 'debit or credit card'];

const clockLabel = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'the customer';

export function depositRule(business) {
  const d = business.deposit || {};
  if (d.type === 'percent') return `${d.percent}% of the price, at least ${B.usd(d.minimum || 0)}. It counts toward the bill.`;
  if (!(d.amount > 0)) return 'No deposit. The time is confirmed right away.';
  return `${B.usd(d.amount)} to hold the time. It counts toward the bill.`;
}

export function mcpUrl(business, base = config.publicUrl) {
  return `${base}/mcp/${business.id}`;
}

// What an assistant reads first. Plain fields, no surprises.
export function businessInfo(business, base = config.publicUrl) {
  return {
    id: business.id,
    name: business.name,
    trade: business.trade,
    city: business.city,
    timezone: business.timezone,
    open_days: (business.openDays || []).map((d) => DAY_NAMES[d]),
    start_times: (business.slotTimes || []).map(clockLabel),
    appointment_minutes: business.slotMinutes || 120,
    services: business.services.map((s) => ({
      id: s.id,
      name: s.name,
      options: Object.entries(s.sizes).map(([size, price]) => ({ size: size === 'standard' ? null : size, price })),
      size_question: Object.keys(s.sizes).length > 1 ? business.sizeQuestion || 'Which option?' : null,
    })),
    deposit_rule: depositRule(business),
    cancellation_policy: business.cancellation,
    hold_minutes: HOLD_MINUTES(),
    payment: {
      handler: 'PayPal',
      methods: PAYMENT_METHODS,
      account_needed: false,
      who_pays: 'The human. Agents can hold a time but cannot pay. The deposit is approved by the customer on a PayPal checkout page.',
    },
    mcp_endpoint: mcpUrl(business, base),
  };
}

function quoteFor(business, service, size) {
  const svc = findService(business, service) || null;
  const sizes = svc ? Object.keys(svc.sizes) : [];
  const useSize = size || (sizes.length === 1 ? sizes[0] : null);
  const q = svc ? B.quote(business, svc.id, useSize) : null;
  if (!q) {
    const options = business.services.map((s) => `${s.name} (id "${s.id}")${Object.keys(s.sizes).length > 1 ? `: ${Object.keys(s.sizes).join(' / ')}` : ''}`);
    const need = svc && sizes.length > 1 && !size ? `This service needs a size. ${business.sizeQuestion || ''} Options: ${sizes.join(', ')}.` : `Unknown service or size.`;
    throw new Error(`${need} Services: ${options.join('; ')}`);
  }
  return {
    service_id: q.serviceId,
    service: q.service,
    size: q.size === 'standard' ? null : q.size,
    price: q.price,
    deposit_due_now: q.deposit,
    balance_after: Math.max(0, Math.round((q.price - q.deposit) * 100) / 100),
    currency: 'USD',
    free_cancel_policy: business.cancellation,
    deposit_rule: depositRule(business),
  };
}

function slotsFor(business, { day, count } = {}) {
  let slots = B.availableSlots(business, { days: 21, limit: 200 });
  let note = null;
  if (day) {
    const d = String(day).toLowerCase().replace(/^(this|next|on)\s+/, '').trim();
    const today = localDate(new Date(), business.timezone);
    const plus = (n) => {
      const [y, m, dd] = today.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
    };
    const onDate = (iso) => slots.filter((s) => localDate(new Date(s.start), business.timezone) === iso);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) slots = onDate(d);
    else if (d === 'today') slots = onDate(today);
    else if (d === 'tomorrow') slots = onDate(plus(1));
    else if (/^weekend/.test(d)) slots = slots.filter((s) => /^(sat|sun)/i.test(s.label));
    else if (/^(sun|mon|tue|wed|thu|fri|sat)/.test(d)) slots = slots.filter((s) => s.label.toLowerCase().startsWith(d.slice(0, 3)));
    else note = `Did not understand the day "${day}". Showing the next open times instead.`;
  }
  return {
    timezone: business.timezone,
    now: new Date().toISOString(),
    slots: slots.slice(0, Math.min(Math.max(count || 6, 1), 20)),
    ...(note ? { note } : {}),
    ...(day && !slots.length && !note ? { note: `Nothing open on ${day}. Call again without a day to see the next open times.` } : {}),
  };
}

function bookingView(b) {
  const t = B.totals(b);
  const pending = b.payments.find((p) => p.status === 'pending');
  return {
    booking_id: b.id,
    status: b.status,
    status_words: B.STATUS_WORDS[b.status] || b.status,
    service: b.service,
    size: b.size === 'standard' ? null : b.size,
    appointment: b.slotLabel,
    slot_start: b.slotStart,
    customer_name: b.customerName,
    total: t.total,
    paid: t.paid,
    due: t.due,
    deposit: b.deposit,
    approval_url: pending ? B.payPageUrl(pending) : null,
    approval_amount: pending ? pending.amount : null,
    human_approval_required: Boolean(pending),
    free_cancel_until: B.freeCancelLabel(b),
    booking_page: B.bookingPageUrl(b),
  };
}

function requireBooking(business, id, key) {
  const b = store.getBooking(String(id || ''));
  if (!b || b.secret !== String(key || '') || b.presetId !== business.id) throw new Error('No booking matches that booking_id and booking_key. Both come from book_appointment.');
  return b;
}

// Tool results carry the same JSON twice: as text (every client) and as structuredContent (newer clients).
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });

export function buildServer(business, { base = config.publicUrl } = {}) {
  const server = new McpServer(
    { name: `${business.id}-booking`, title: business.name, version: '1.0.0', description: `Book ${business.name} (${business.trade}, ${business.city}). A human approves every payment in PayPal.` },
    {
      capabilities: { tools: {} },
      instructions: [
        `You are talking to the booking system of ${business.name}, a ${business.trade} business in ${business.city}.`,
        'Start with get_business_info. Quote only prices it returns. Use check_availability before naming a time, and pass the exact slot_start it returns to book_appointment.',
        `Booking holds the time for ${HOLD_MINUTES()} minutes. You cannot pay. Give the human the approval_url so they can approve the deposit in PayPal (PayPal, Venmo, Pay Later or card, no account needed).`,
        'Do not say the appointment is confirmed until get_booking_status returns status "confirmed". Keep booking_id and booking_key: they are needed to check, move or cancel.',
      ].join(' '),
    },
  );

  server.registerTool(
    'get_business_info',
    {
      title: 'Business info',
      description: `Who ${business.name} is: trade, city, open days and start times, every service with its price, the deposit rule, the cancellation policy and how payment works (PayPal checkout approved by the human; PayPal, Venmo, Pay Later or card; no PayPal account needed). Call this first.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ok(businessInfo(business, base)),
  );

  server.registerTool(
    'check_availability',
    {
      title: 'Check availability',
      description: 'Real open appointment times. Optional day: an ISO date (2026-10-30), a weekday name ("friday"), "today", "tomorrow" or "weekend". Returns slots with a machine start (ISO) and a human label in the business time zone. Pass slot.start to book_appointment exactly as returned.',
      inputSchema: {
        day: z.string().optional().describe('ISO date, weekday name, "today", "tomorrow" or "weekend". Leave out for the next open times.'),
        count: z.number().int().min(1).max(20).optional().describe('How many slots to return (default 6).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ day, count }) => ok(slotsFor(business, { day, count })),
  );

  server.registerTool(
    'get_quote',
    {
      title: 'Get a quote',
      description: 'Price for a service (id or name from get_business_info) and a size. Size can be left out when the service has one option. Returns the price, the deposit due now, the balance after the job and the free-cancel policy. Nothing is booked.',
      inputSchema: {
        service: z.string().describe('Service id or name, for example "deep" or "Deep clean".'),
        size: z.string().optional().describe('Size label exactly as listed, for example "3 bedrooms". Optional for single-option services.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ service, size }) => ok(quoteFor(business, service, size)),
  );

  server.registerTool(
    'book_appointment',
    {
      title: 'Book an appointment',
      description: `Hold a time for the customer and create the PayPal deposit request. Use slot_start from check_availability. If max_total is given and the price is above it, nothing is booked and the quote is returned instead. On success the time is held for ${HOLD_MINUTES()} minutes and you get approval_url: the human must open it and approve the deposit in PayPal. You cannot pay. Save booking_id and booking_key.`,
      inputSchema: {
        service: z.string().describe('Service id or name from get_business_info.'),
        size: z.string().optional().describe('Size label. Optional for single-option services.'),
        slot_start: z.string().describe('Exact slot.start (ISO) from check_availability.'),
        customer_name: z.string().min(1).describe("The customer's name."),
        customer_phone: z.string().optional(),
        customer_email: z.string().optional(),
        max_total: z.number().optional().describe('Budget the human gave. If the total is above it, do not book.'),
        agent_name: z.string().optional().describe('Your name, for example "Claude" or "ChatGPT". Shown to the business.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ service, size, slot_start, customer_name, customer_phone, customer_email, max_total, agent_name }) => {
      const q = quoteFor(business, service, size);
      const agent = String(agent_name || 'An AI assistant').trim().slice(0, 60);
      if (typeof max_total === 'number' && q.price > max_total) {
        return ok({
          booked: false,
          reason: 'over_budget',
          message: `${q.service}${q.size ? ` (${q.size})` : ''} is ${B.usd(q.price)}, above the ${B.usd(max_total)} budget. Nothing was booked. Ask the human before booking, or pick a smaller option.`,
          quote: q,
          other_options: business.services.flatMap((s) => Object.entries(s.sizes).filter(([, p]) => p <= max_total).map(([k, p]) => ({ service_id: s.id, service: s.name, size: k === 'standard' ? null : k, price: p }))),
        });
      }
      const lead = store.createLead({ name: customer_name, phone: customer_phone || '', email: customer_email || '', channel: 'AI assistant (MCP)', presetId: business.id });
      store.updateLead(lead.id, { bookedBy: agent, source: 'agent' });
      store.addMessage(lead.id, 'customer', `(${agent}, booking for ${customer_name} over MCP) ${q.service}${q.size ? `, ${q.size}` : ''} at ${slot_start}.`, { channel: 'mcp', agent });
      const r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: q.service_id, size: q.size || 'standard', slotStart: slot_start, customerName: customer_name, customerEmail: customer_email });
      store.updateBooking(r.booking.id, { bookedBy: agent, source: 'agent' });
      store.addTimeline(r.booking.id, `Booked by ${agent} (AI assistant) for ${customer_name} over MCP. The deposit still needs ${firstName(customer_name)}'s approval in PayPal.`);
      const what = `${r.booking.service}${r.booking.size === 'standard' ? '' : `, ${r.booking.size}`}`;
      if (r.payLink) {
        store.addMessage(lead.id, 'assistant', `Hi ${firstName(customer_name)}! ${agent} booked ${what} for ${r.booking.slotLabel}. ${r.terms} Approve the deposit here (PayPal, Venmo, Pay Later or card): ${r.payLink}`, { kind: 'agent_booking' });
        store.logActivity(`${agent} (AI assistant) booked ${customer_name}: ${what}, ${r.booking.slotLabel}. Waiting on ${firstName(customer_name)}'s PayPal approval.`, { bookingId: r.booking.id, leadId: lead.id, kind: 'agent_booking', agent });
      } else {
        store.logActivity(`${agent} (AI assistant) booked ${customer_name}: ${what}, ${r.booking.slotLabel} (no deposit needed).`, { bookingId: r.booking.id, leadId: lead.id, kind: 'agent_booking', agent });
      }
      const view = bookingView(r.booking);
      return ok({
        booked: true,
        ...view,
        booking_key: r.booking.secret,
        hold_minutes: r.payLink ? HOLD_MINUTES() : null,
        terms: r.terms,
        human_approval_required: Boolean(r.payLink),
        message: r.payLink
          ? `Held ${r.booking.slotLabel} for ${HOLD_MINUTES()} minutes. Give ${firstName(customer_name)} the approval_url so they can approve the ${B.usd(r.booking.deposit)} deposit in PayPal. You cannot pay for them. The time is confirmed once they approve.`
          : `Booked ${r.booking.slotLabel}. No deposit is needed for this visit, so it is confirmed.`,
      });
    },
  );

  const keyed = {
    booking_id: z.string().describe('From book_appointment.'),
    booking_key: z.string().describe('From book_appointment. Proves this assistant made the booking.'),
  };

  server.registerTool(
    'get_booking_status',
    {
      title: 'Booking status',
      description: 'Status of a booking made here: held (waiting on the human to approve the deposit), confirmed, done, canceled or refunded, plus what is paid and owed and the approval_url if money is still due. Needs booking_id and booking_key.',
      inputSchema: keyed,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ booking_id, booking_key }) => ok(bookingView(requireBooking(business, booking_id, booking_key))),
  );

  server.registerTool(
    'reschedule_booking',
    {
      title: 'Reschedule',
      description: 'Move a booking to another open time (slot_start from check_availability). Free. Any money already paid moves with it. Needs booking_id and booking_key.',
      inputSchema: { ...keyed, slot_start: z.string().describe('Exact slot.start (ISO) from check_availability.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ booking_id, booking_key, slot_start }) => {
      const b = requireBooking(business, booking_id, booking_key);
      const from = b.slotLabel;
      const nb = await B.reschedule(b.id, slot_start, { notify: true });
      const paid = B.totals(nb).paid;
      return ok({ moved: true, from, ...bookingView(nb), message: `Moved from ${from} to ${nb.slotLabel}. ${paid > 0 ? `${B.usd(paid)} already paid carried over; nothing new to pay.` : 'The deposit still needs the customer\'s approval in PayPal.'}` });
    },
  );

  server.registerTool(
    'cancel_booking',
    {
      title: 'Cancel',
      description: 'Cancel a booking. The policy the customer agreed to applies on its own: an unpaid hold is released; a paid deposit is refunded inside the free-cancel window and kept after it. Needs booking_id and booking_key.',
      inputSchema: keyed,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ booking_id, booking_key }) => {
      const b = requireBooking(business, booking_id, booking_key);
      // The business already canceled this time: canceling now means the customer takes the full refund.
      if (b.status === 'needs_rebook') {
        const rf = await B.refund(b.id, { reason: 'Business canceled; customer chose a refund', notify: true });
        return ok({ canceled: true, outcome: 'refunded_in_full', refunded: rf.refunded, kept: 0, ...bookingView(rf.booking), message: `Canceled and ${B.usd(rf.refunded)} refunded in full through PayPal (reference ${rf.reference}), since the business canceled this time.` });
      }
      const r = await B.customerCancel(b.id, { notify: true });
      const message =
        r.outcome === 'released' ? 'Canceled. Nothing was paid, so nothing is owed.' : r.outcome === 'refunded' ? `Canceled and ${B.usd(r.refunded)} refunded through PayPal (reference ${r.reference}).` : `Canceled after the free-cancel deadline (${r.deadline}). The ${B.usd(r.kept)} deposit is kept per the terms shown at booking.`;
      return ok({ canceled: true, outcome: r.outcome, refunded: r.refunded || 0, kept: r.kept || 0, ...bookingView(r.booking), message });
    },
  );

  return server;
}

// ---------- HTTP plumbing ----------
// Keyed on the visitor, not the host's proxy (see client-ip.js). One bucket for all MCP calls.
const mcpLimiter = makeRateLimiter({ onLimit: (req, res) => res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests. Try again in a minute.' }, id: null }) });
const rateLimit = (max, windowMs) => mcpLimiter(max, windowMs, () => 'mcp');

// Remote assistants (Claude connectors, ChatGPT, browser agents) call from other origins.
export function cors(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// Where this server is reachable from the caller's point of view. Local runs and tests listen on a port
// that config.publicUrl may not know about, so the request's own host wins there.
export function baseFor(req) {
  const host = req.get('host') || '';
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host);
  return local ? `${req.protocol}://${host}` : config.publicUrl;
}

const notAllowed = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless: POST only.' }, id: null });

async function handle(business, req, res) {
  const server = buildServer(business, { base: baseFor(req) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
}

export function mountMcp(app) {
  const limiter = rateLimit(120, 60 * 1000);
  const json = express.json({ limit: '1mb' });
  const forBusiness = (req, res) => {
    // Bare /mcp is the default demo business, never whichever business an owner page last showed.
    const business = B.businessById(req.params.bizId || defaultPresetId);
    if (!business) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: `No business with id "${req.params.bizId}".` }, id: null });
    return handle(business, req, res);
  };
  for (const path of ['/mcp', '/mcp/:bizId']) {
    app.options(path, cors);
    app.post(path, cors, limiter, json, forBusiness);
    app.get(path, cors, notAllowed);
    app.delete(path, cors, notAllowed);
  }
}
