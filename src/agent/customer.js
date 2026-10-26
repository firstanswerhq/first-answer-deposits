// The customer-facing AI: texts, the guided payment page and call mode all use this one agent.
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as store from '../store.js';
import * as B from '../bookings.js';
import { priceSheet } from '../business.js';
import { formatSlot } from '../slots.js';
import { getModel } from './model.js';
import { scriptedCustomerReply } from './scripted.js';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function nowLine(business) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: business.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date());
}

function bookingContext(booking) {
  if (!booking) return 'This customer has no booking yet.';
  const t = B.totals(booking);
  const open = booking.payments.filter((p) => p.status === 'pending').map((p) => `${p.label} ${B.usd(p.amount)}: ${B.payPageUrl(p)}`);
  const proposed = booking.changes.filter((c) => c.status === 'proposed').map((c) => `${c.description} (${B.usd(c.amount)})`);
  return [
    `Current booking ${booking.id}: ${booking.service} (${booking.size}) on ${booking.slotLabel}.`,
    `Status: ${B.STATUS_WORDS[booking.status] || booking.status}.`,
    `Total ${B.usd(t.total)}, paid ${B.usd(t.paid)}, still owed ${B.usd(t.due)}${t.refunded ? `, refunded ${B.usd(t.refunded)}` : ''}.`,
    `Free to cancel until ${B.freeCancelLabel(booking)}. Rescheduling is always free; the money moves with the booking.`,
    open.length ? `Open payment links: ${open.join(' | ')}` : 'No open payment links.',
    proposed.length ? `Change waiting for the customer's YES or NO: ${proposed.join('; ')}` : '',
    `Booking page (receipt): ${B.bookingPageUrl(booking)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function systemPrompt(business, lead, booking, channel) {
  const offer = store.listWaitlist().find((w) => w.leadId === lead.id && w.status === 'offered');
  const nudge = [...lead.messages].reverse().find((m) => m.kind === 'rebook_nudge');
  const rebook =
    nudge && nudge.slotStart && !B.activeBookingForLead(lead.id)
      ? `They were invited to book again: ${nudge.serviceId} / ${nudge.size} on ${formatSlot(nudge.slotStart, business.timezone)} (slotStart ${nudge.slotStart}), name ${nudge.name}. If they say yes, book exactly that.`
      : '';
  const days = business.openDays.map((d) => DAY_NAMES.at(d)).join(', ');
  const where =
    channel === 'voice'
      ? 'phone call (your words are spoken aloud, so never read out links or long numbers; say "I just texted you the link")'
      : channel === 'payment page'
        ? 'the chat box on the secure payment page, right next to the PayPal buttons (they are looking at the amount due; answer their question about the payment, the terms, Pay Later, splitting, someone else paying or changing the time, then point them back to the buttons)'
        : 'text message';
  return `You are the front desk for ${business.name}, a ${business.trade} business in ${business.city}. You talk with customers by ${where}.
Right now it is ${nowLine(business)}. The business works ${days}.

PRICE SHEET (the only prices you may quote):
${priceSheet(business)}
${business.sizeQuestion ? `To quote, you need the size: ${business.sizeQuestion}` : ''}

PAYMENT: Every payment link opens a simple page with PayPal, Venmo, Pay Later and debit or credit card. No account or app is needed. If they ask about paying over time: PayPal Pay Later can split a purchase into smaller payments (for example 4 interest-free payments) if they're eligible, subject to approval, starting at $30; PayPal shows what they qualify for at checkout. Never promise approval or quote interest rates.
REFUND QUESTIONS ("is this refundable?") are questions, not requests: explain the terms (free to cancel until the deadline below, then the deposit is kept; moving is always free) and do not cancel anything unless they clearly ask you to.

WHAT YOU KNOW ABOUT THIS CUSTOMER:
Name: ${lead.name || 'not given yet'}. ${bookingContext(booking)}
${offer ? `They were offered the waitlist opening ${formatSlot(offer.offeredSlot, business.timezone)} (slot start ${offer.offeredSlot}). If they say yes, book that exact slot.` : ''}
${rebook}

HOW TO WORK:
- Reply like a friendly, competent person texting: 1 to 3 short sentences, under 320 characters, no markdown, no lists, at most one emoji.
- Ask one question at a time. To book you need the service, the size, a time and their first name. Email is optional.
- Always call get_open_slots before naming any time. Offer 2 or 3 times. Never invent times, prices, services or discounts.
- When they pick a time, call book_and_send_deposit with the exact slotStart from get_open_slots. Then tell them the total, the deposit due now (it counts toward the bill), the free-cancel deadline, and give the payment link exactly as the tool returned it.
- "Am I booked?", "what do I owe?", "where's my refund?": answer from the booking info above or call my_booking.
- Reschedule with reschedule_booking (no new charge, the money moves). Cancel with cancel_booking, which applies the policy they agreed to; explain the result kindly and offer to reschedule instead if they would lose the deposit.
- If a change is waiting for their approval and they answer, call answer_change.
- Someone else paying: link_for_someone_else. Splitting the bill: split_payment.
- No open times that work: offer join_waitlist.
- Anything you cannot handle (complaints, special requests, commercial jobs, questions outside this business): call hand_off_to_owner and say the owner will reply shortly.
- Answer in the customer's language. If they write in Spanish, reply in Spanish.`;
}

function customerTools(lead, business, state) {
  const getBooking = () => B.activeBookingForLead(lead.id) || B.latestBookingForLead(lead.id);
  const safe = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return { error: err.message };
    }
  };
  return {
    get_price: tool({
      description: 'Look up the price and the deposit for a service and size from the price sheet.',
      inputSchema: z.object({ serviceId: z.string().describe('service id from the price sheet'), size: z.string().describe('size label from the price sheet') }),
      execute: safe(async ({ serviceId, size }) => B.quote(business, serviceId, size) || { error: 'Unknown service or size. Ask the customer to clarify.' }),
    }),
    get_open_slots: tool({
      description: 'Get real open appointment times. Optionally filter to a day like "friday" or "2026-10-30".',
      inputSchema: z.object({ day: z.string().optional(), count: z.number().int().min(1).max(8).optional() }),
      execute: safe(async ({ day, count }) => {
        let slots = B.availableSlots(business, { days: 14, limit: 40 });
        if (day) {
          const d = day.toLowerCase();
          const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
          slots = slots.filter((s) =>
            iso
              ? new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(new Date(s.start)) === iso
              : s.label.toLowerCase().startsWith(d.slice(0, 3)),
          );
        }
        return { slots: slots.slice(0, count || 4) };
      }),
    }),
    book_and_send_deposit: tool({
      description: 'Book the chosen time and create the PayPal deposit link. Use the exact slotStart from get_open_slots.',
      inputSchema: z.object({
        serviceId: z.string(),
        size: z.string(),
        slotStart: z.string().describe('ISO time from get_open_slots'),
        customerName: z.string(),
        customerEmail: z.string().optional(),
      }),
      execute: safe(async (args) => {
        const r = await B.bookAndRequestDeposit({ leadId: lead.id, ...args });
        state.payLink = r.payLink;
        const t = B.totals(r.booking);
        return { bookingId: r.booking.id, appointment: r.booking.slotLabel, total: t.total, depositDueNow: r.booking.deposit, freeCancelUntil: B.freeCancelLabel(r.booking), payLink: r.payLink };
      }),
    }),
    my_booking: tool({
      description: "Get the customer's booking: status, what is paid, what is owed, deadlines, open links and refunds.",
      inputSchema: z.object({}),
      execute: safe(async () => {
        const b = getBooking();
        if (!b) return { booking: null };
        const t = B.totals(b);
        return {
          appointment: b.slotLabel,
          service: `${b.service} (${b.size})`,
          status: B.STATUS_WORDS[b.status] || b.status,
          ...t,
          freeCancelUntil: B.freeCancelLabel(b),
          openLinks: b.payments.filter((p) => p.status === 'pending').map((p) => ({ what: p.label, amount: p.amount, link: B.payPageUrl(p) })),
          refunds: b.payments.filter((p) => p.refund).map((p) => ({ amount: p.refund.amount, reference: p.refund.refundId, status: p.refund.status })),
        };
      }),
    }),
    reschedule_booking: tool({
      description: 'Move the booking to a new open time. Free; money already paid moves with it.',
      inputSchema: z.object({ slotStart: z.string().describe('ISO time from get_open_slots') }),
      execute: safe(async ({ slotStart }) => {
        const b = getBooking();
        if (!b) return { error: 'No booking to move.' };
        const nb = await B.reschedule(b.id, slotStart, { notify: false });
        const paid = B.totals(nb).paid;
        return { ok: true, newTime: nb.slotLabel, moneyCarriedOver: paid, freeCancelUntil: B.freeCancelLabel(nb) };
      }),
    }),
    cancel_booking: tool({
      description: 'Cancel the booking. Applies the cancellation policy the customer agreed to and refunds when allowed.',
      inputSchema: z.object({}),
      execute: safe(async () => {
        const b = getBooking();
        if (!b) return { error: 'No booking to cancel.' };
        if (b.status === 'needs_rebook') {
          const r = await B.refund(b.id, { reason: 'Business canceled; customer chose a refund', notify: false });
          return { outcome: 'refunded_in_full', amount: r.refunded, reference: r.reference, timing: 'Shows in PayPal right away; card refunds can take a few business days at the bank.' };
        }
        const r = await B.customerCancel(b.id, { notify: false });
        return { outcome: r.outcome, refunded: r.refunded || 0, reference: r.reference || null, depositKept: r.kept || 0, deadline: r.deadline || null, refundTiming: r.refunded ? 'Shows in PayPal right away; card refunds can take a few business days at the bank.' : null };
      }),
    }),
    answer_change: tool({
      description: 'Record the customer approving or declining a proposed change to the job.',
      inputSchema: z.object({ approve: z.boolean() }),
      execute: safe(async ({ approve }) => {
        const b = getBooking();
        if (!b) return { error: 'No booking.' };
        const r = B.decideChange(b.id, null, approve, { notify: false });
        return { ok: true, approved: approve, newTotal: r.totals.total, stillOwed: r.totals.due };
      }),
    }),
    split_payment: tool({
      description: 'Split what is due right now into equal PayPal links, one per person.',
      inputSchema: z.object({ ways: z.number().int().min(2).max(6) }),
      execute: safe(async ({ ways }) => {
        const b = getBooking();
        if (!b) return { error: 'No booking.' };
        return B.splitDue(b.id, ways);
      }),
    }),
    link_for_someone_else: tool({
      description: 'Get a payment link the customer can forward to whoever is paying (spouse, parent, employer).',
      inputSchema: z.object({ payerName: z.string().optional() }),
      execute: safe(async ({ payerName }) => {
        const b = getBooking();
        if (!b) return { error: 'No booking.' };
        return B.linkForSomeoneElse(b.id, payerName);
      }),
    }),
    join_waitlist: tool({
      description: 'Put the customer on the waitlist so they get first dibs when a time opens up.',
      inputSchema: z.object({ note: z.string().optional().describe('days or times they want') }),
      execute: safe(async ({ note }) => {
        B.joinWaitlist(lead.id, note || '');
        return { ok: true };
      }),
    }),
    hand_off_to_owner: tool({
      description: 'Flag the conversation for the owner when the request is outside what you can handle.',
      inputSchema: z.object({ reason: z.string() }),
      execute: safe(async ({ reason }) => {
        store.updateLead(lead.id, { needsOwner: true, needsOwnerReason: reason });
        store.logActivity(`${lead.name || 'A customer'} needs you: ${reason}`, { leadId: lead.id, kind: 'handoff' });
        return { ok: true };
      }),
    }),
  };
}

function toModelMessages(messages) {
  const out = [];
  for (const m of messages.slice(-30)) {
    const role = m.role === 'customer' ? 'user' : 'assistant';
    const last = out.at(-1);
    if (last && last.role === role) last.content += `\n${m.text}`;
    else out.push({ role, content: m.text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function replyToCustomer(leadId, { channel = 'text' } = {}) {
  const lead = store.getLead(leadId);
  if (!lead) throw new Error('Lead not found.');
  const business = B.businessOf(lead);
  const m = getModel();
  if (!m) return scriptedCustomerReply(lead);
  const booking = B.activeBookingForLead(leadId) || B.latestBookingForLead(leadId);
  const state = { payLink: null };
  let result;
  try {
    result = await generateText({
      model: m.model,
      system: systemPrompt(business, lead, booking, channel),
      messages: toModelMessages(lead.messages),
      tools: customerTools(lead, business, state),
      stopWhen: stepCountIs(6),
      temperature: 0.3,
      maxOutputTokens: 500,
    });
  } catch (err) {
    // A rate limit or an outage at the AI provider should never leave a customer on read.
    console.error(`Customer AI failed (${m.name}): ${err.message}. Using the scripted reply.`);
    if (state.payLink) return `You're all set. Pay the deposit here: ${state.payLink}`;
    return scriptedCustomerReply(store.getLead(leadId));
  }
  let text = (result.text || '').trim();
  if (state.payLink && channel !== 'voice' && !text.includes(state.payLink)) text += ` Pay the deposit here: ${state.payLink}`;
  if (state.payLink && channel === 'voice') {
    // On a call the link can't be read out, so it's texted right away.
    store.addMessage(lead.id, 'assistant', `Here's the secure payment link from our call (card, Venmo, Pay Later or PayPal): ${state.payLink}`, { kind: 'link', channel: 'text' });
  }
  return text || "Sorry, I missed that. Could you say it another way?";
}
