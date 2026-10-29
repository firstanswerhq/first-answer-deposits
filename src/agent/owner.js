// The owner's AI office manager. The owner texts it; it moves the calendar and the money.
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as store from '../store.js';
import * as B from '../bookings.js';
import { getModel } from './model.js';
import { scriptedOwnerReply } from './scripted.js';
import { config } from '../config.js';

function snapshot(business) {
  const active = store
    .listBookings()
    .filter((b) => B.ownerCanTouch(b, business) && ['held', 'confirmed', 'completed', 'needs_rebook'].includes(b.status))
    .slice(0, 25)
    .map((b) => {
      const t = B.totals(b);
      return `- ${b.id} | ${b.customerName} | ${b.service} (${b.size}) | ${b.slotLabel} | ${B.STATUS_WORDS[b.status]} | total ${B.usd(t.total)}, paid ${B.usd(t.paid)}, owed ${B.usd(t.due)}`;
    });
  return active.length ? active.join('\n') : '(no active bookings)';
}

function systemPrompt(business) {
  const now = new Intl.DateTimeFormat('en-US', { timeZone: business.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return `You are the AI office manager for ${business.name}. The owner texts you short commands from their phone. Today is ${now}.

ACTIVE BOOKINGS:
${snapshot(business)}

HOW TO WORK:
- Use the tools to do what the owner asks, then reply in 1 to 3 short sentences that say exactly what you did: names, amounts, times, and PayPal reference numbers when there are any. No markdown.
- Never invent bookings, names or numbers. If a name matches more than one booking, ask which one.
- Refunds, cancellations and no-shows move real money: only do them when the owner clearly asks. Partial refunds are fine when the owner gives an amount.
- "Done at Sarah's" or "finished Sarah" means mark_job_done, which texts Sarah her balance link with an optional tip.
- "Sarah paid $210 cash" means record_outside_payment so nobody chases her.
- "Add the inside of the fridge for $40" means propose_change; the customer approves by text before it counts.
- When the owner can't make an appointment, use business_cancel: the customer picks a new time or a full refund.
- For money questions use money_summary. For a chargeback, use evidence_file and give the link.
- Money flow: customers pay through PayPal (card, Venmo, Pay Later, PayPal). When a job is paid in full, the net is sent to the owner's PayPal email with PayPal Payouts${business.payoutEmail ? ` (${business.payoutEmail})` : ' (none set yet: they can add it under Connections on their owner page)'}. Refunds go back the way the customer paid.
- Connections (leads in from other apps, the calendar subscribe link, updates out to a CRM, the MCP address for AI assistants) live under Connections on the owner page; point the owner there for setup questions.`;
}

function ownerTools(business) {
  const safe = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return { error: err.message };
    }
  };
  // Every booking ID the model passes is checked: it must belong to this business or a shared demo one.
  const mine = (id) => {
    const b = store.getBooking(String(id || ''));
    if (!b || !B.ownerCanTouch(b, business)) throw new Error('Booking not found.');
    return b.id;
  };
  const brief = (b) => {
    const t = B.totals(b);
    return { bookingId: b.id, customer: b.customerName, appointment: b.slotLabel, service: `${b.service} (${b.size})`, status: B.STATUS_WORDS[b.status], total: t.total, paid: t.paid, owed: t.due };
  };
  return {
    list_bookings: tool({
      description: 'List bookings. Filters: owes (anyone with an open payment), held (unpaid deposits), confirmed, upcoming, past, all.',
      inputSchema: z.object({ filter: z.enum(['owes', 'held', 'confirmed', 'upcoming', 'past', 'all']).default('upcoming') }),
      execute: safe(async ({ filter }) => {
        const now = Date.now();
        let list = store.listBookings().filter((b) => B.ownerCanTouch(b, business));
        if (filter === 'owes') list = B.owing().filter((b) => B.ownerCanTouch(b, business));
        else if (filter === 'held') list = list.filter((b) => b.status === 'held');
        else if (filter === 'confirmed') list = list.filter((b) => b.status === 'confirmed');
        else if (filter === 'upcoming') list = list.filter((b) => Date.parse(b.slotStart) >= now && !['canceled', 'refunded'].includes(b.status));
        else if (filter === 'past') list = list.filter((b) => Date.parse(b.slotStart) < now);
        return { bookings: list.slice(0, 20).map(brief) };
      }),
    }),
    find_booking: tool({
      description: "Find bookings by the customer's name.",
      inputSchema: z.object({ name: z.string() }),
      execute: safe(async ({ name }) => ({ matches: B.findBookingsByName(name).filter((b) => B.ownerCanTouch(b, business)).slice(0, 5).map(brief) })),
    }),
    send_reminders: tool({
      description: 'Text a payment reminder with the link. Pass bookingIds, or leave empty to remind everyone who owes.',
      inputSchema: z.object({ bookingIds: z.array(z.string()).optional() }),
      execute: safe(async ({ bookingIds }) => {
        const ids = bookingIds && bookingIds.length ? bookingIds : B.owing().filter((b) => B.ownerCanTouch(b, business)).map((b) => b.id);
        const done = [];
        const skipped = [];
        for (const id of ids) {
          try {
            const b = await B.remind(mine(id));
            done.push(b.customerName);
          } catch (e) {
            skipped.push(e.message);
          }
        }
        return { reminded: done, skipped };
      }),
    }),
    refund: tool({
      description: 'Refund money to a customer through PayPal. Leave amount empty for a full refund.',
      inputSchema: z.object({ bookingId: z.string(), amount: z.number().positive().optional(), reason: z.string().optional() }),
      execute: safe(async ({ bookingId, amount, reason }) => {
        const r = await B.refund(mine(bookingId), { amount: amount || null, reason: reason || '' });
        return { refunded: r.refunded, reference: r.reference, status: B.STATUS_WORDS[r.booking.status] };
      }),
    }),
    business_cancel: tool({
      description: "The business can't make it. Customer is offered new times or a full refund, their choice.",
      inputSchema: z.object({ bookingId: z.string(), reason: z.string().optional() }),
      execute: safe(async ({ bookingId, reason }) => {
        const r = await B.businessCancel(mine(bookingId), reason || '');
        return { ok: true, offeredTimes: r.options.map((o) => o.label) };
      }),
    }),
    release_hold: tool({
      description: 'Release an unpaid hold so the time can be booked by someone else.',
      inputSchema: z.object({ bookingId: z.string() }),
      execute: safe(async ({ bookingId }) => brief(await B.releaseHold(mine(bookingId), 'Released by the owner'))),
    }),
    mark_job_done: tool({
      description: 'Mark the job finished. Texts the customer one link for the balance with an optional tip.',
      inputSchema: z.object({ bookingId: z.string() }),
      execute: safe(async ({ bookingId }) => {
        const r = await B.markCompleted(mine(bookingId));
        return { ok: true, balanceDue: r.due || 0, linkSent: Boolean(r.payLink) };
      }),
    }),
    record_outside_payment: tool({
      description: 'Record money paid outside PayPal (cash or check) so reminders stop.',
      inputSchema: z.object({ bookingId: z.string(), amount: z.number().positive(), method: z.enum(['cash', 'check', 'other']).default('cash') }),
      execute: safe(async ({ bookingId, amount, method }) => brief(B.recordOutsidePayment(mine(bookingId), { amount, method }))),
    }),
    propose_change: tool({
      description: 'Add or remove work and price. The customer gets a text to approve with YES before it counts.',
      inputSchema: z.object({ bookingId: z.string(), description: z.string(), amount: z.number().describe('positive adds, negative takes off') }),
      execute: safe(async ({ bookingId, description, amount }) => {
        const c = B.proposeChange(mine(bookingId), { description, amount });
        return { ok: true, change: c.description, amount: c.amount, waitingOnCustomer: true };
      }),
    }),
    get_open_slots: tool({
      description: 'Get open appointment times.',
      inputSchema: z.object({ count: z.number().int().min(1).max(8).optional() }),
      execute: safe(async ({ count }) => ({ slots: B.availableSlots(business, { limit: count || 5 }) })),
    }),
    reschedule: tool({
      description: 'Move a booking to a new open time. Money already paid moves with it.',
      inputSchema: z.object({ bookingId: z.string(), slotStart: z.string() }),
      execute: safe(async ({ bookingId, slotStart }) => brief(await B.reschedule(mine(bookingId), slotStart))),
    }),
    mark_no_show: tool({
      description: 'Mark a customer as a no-show. The deposit is kept per the terms they agreed to.',
      inputSchema: z.object({ bookingId: z.string() }),
      execute: safe(async ({ bookingId }) => brief(B.markNoShow(mine(bookingId)))),
    }),
    money_summary: tool({
      description: 'Money in, PayPal fees, refunds, tips, net, and what is still owed, for the last N days.',
      inputSchema: z.object({ days: z.number().int().min(1).max(365).default(7) }),
      execute: safe(async ({ days }) => B.moneySummary({ days, presetId: B.currentBusiness().id })),
    }),
    evidence_file: tool({
      description: 'Get the dispute evidence file for a booking: terms agreed, payments, changes, messages.',
      inputSchema: z.object({ bookingId: z.string() }),
      execute: safe(async ({ bookingId }) => ({ link: `${config.publicUrl}/evidence/${mine(bookingId)}` })),
    }),
    send_rebook_nudges: tool({
      description: 'Text past customers who are due to book again (repeat business).',
      inputSchema: z.object({}),
      execute: safe(async () => B.sendRebookNudges({ force: true, presetId: B.currentBusiness().id })),
    }),
  };
}

export async function ownerCommand(text) {
  const business = B.currentBusiness();
  store.addOwnerMessage('owner', text, { presetId: business.id });
  const m = getModel();
  let reply;
  if (!m) {
    reply = await scriptedOwnerReply(text);
  } else {
    const history = store
      .listOwnerMessages()
      .slice(-12)
      .map((x) => ({ role: x.role === 'owner' ? 'user' : 'assistant', content: x.text }));
    while (history.length && history[0].role !== 'user') history.shift();
    try {
      const result = await generateText({
        model: m.model,
        system: systemPrompt(business),
        messages: history,
        tools: ownerTools(business),
        stopWhen: stepCountIs(8),
        temperature: 0.2,
        maxOutputTokens: 500,
      });
      reply = (result.text || '').trim() || 'Done.';
    } catch (err) {
      console.error(`Owner AI failed (${m.name}): ${err.message}. Using the scripted reply.`);
      reply = await scriptedOwnerReply(text);
    }
  }
  store.addOwnerMessage('assistant', reply, { presetId: business.id });
  return reply;
}
