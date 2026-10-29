// Scripted fallback used when no AI key is set, so anyone can run the full flow locally.
// The real product uses the AI agents in customer.js and owner.js.
import * as store from '../store.js';
import * as B from '../bookings.js';

const lower = (s) => String(s || '').toLowerCase();
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// "Friday morning", "tomorrow", "this weekend": pick the open times that match what they asked for.
export function slotsMatching(business, text, limit = 3) {
  const t = lower(text);
  const all = B.availableSlots(business, { limit: 60, days: 14 });
  const local = (iso) => new Date(new Date(iso).toLocaleString('en-US', { timeZone: business.timezone }));
  let want = all;
  const day = DAYS.findIndex((d) => new RegExp(`\\b${d}`).test(t));
  if (/\btomorrow\b/.test(t)) {
    const tomorrow = local(new Date().toISOString());
    tomorrow.setDate(tomorrow.getDate() + 1);
    want = all.filter((s) => local(s.start).toDateString() === tomorrow.toDateString());
  } else if (/\btoday\b/.test(t)) {
    const today = local(new Date().toISOString());
    want = all.filter((s) => local(s.start).toDateString() === today.toDateString());
  } else if (day >= 0) {
    want = all.filter((s) => local(s.start).getDay() === day);
  } else if (/weekend/.test(t)) {
    want = all.filter((s) => [0, 6].includes(local(s.start).getDay()));
  }
  if (/morning/.test(t)) want = want.filter((s) => local(s.start).getHours() < 12);
  else if (/afternoon|after lunch/.test(t)) want = want.filter((s) => local(s.start).getHours() >= 12 && local(s.start).getHours() < 17);
  else if (/evening|after work/.test(t)) want = want.filter((s) => local(s.start).getHours() >= 16);
  const picked = (want.length ? want : all).slice(0, limit);
  return { slots: picked, matched: want.length > 0, asked: want !== all };
}

function detectService(business, text) {
  const t = lower(text);
  return business.services.find((s) => t.includes(s.id) || t.includes(lower(s.name).split(' ')[0])) || null;
}

function detectSize(service, text) {
  const t = lower(text).replace(/three/g, '3').replace(/four/g, '4').replace(/one/g, '1').replace(/two/g, '2');
  const keys = Object.keys(service.sizes);
  return (
    keys.find((k) => t.includes(lower(k))) ||
    keys.find((k) => {
      const n = (k.match(/\d/) || [])[0];
      return n && new RegExp(`\\b${n}\\b`).test(t);
    }) ||
    keys.find((k) => lower(k).split(/\s+/).some((w) => w.length > 2 && t.includes(w))) ||
    null
  );
}

// "Is this refundable?" / "What if I cancel?" get the terms they agreed to, not an action.
function policyAnswer(booking) {
  const t = B.totals(booking);
  const deadline = B.freeCancelLabel(booking);
  if (booking.status === 'completed') {
    return `This is the balance for work that's already done. If anything wasn't right, tell me what happened and I'll get the owner on it right away.`;
  }
  const what = t.paid > 0 ? `the ${B.usd(t.paid)} you paid` : `your ${B.usd(booking.deposit)} deposit`;
  return Date.now() <= Date.parse(booking.freeCancelUntil)
    ? `Yes. Cancel by ${deadline} and ${what} comes right back to you. After that the deposit is kept, since the time is saved just for you. Moving to another time is always free, and your money moves with you.`
    : `The free-cancel time passed at ${deadline}, so the deposit is kept if you cancel now, as agreed when you booked. Moving to another time is still free, and your money moves with you.`;
}

function payLaterAnswer(booking) {
  const due = booking.payments.find((p) => p.status === 'pending')?.amount ?? booking.deposit;
  const small = due < 30 ? ` (Pay Later starts at $30, so for this ${B.usd(due)} a card or Venmo is easiest.)` : '';
  return `Yes! On the payment page, tap Pay Later. If you're eligible, PayPal can split it into smaller payments, like 4 interest-free payments, subject to approval.${small} Venmo and cards work too, and no PayPal account is needed.`;
}

export async function scriptedCustomerReply(lead) {
  const business = B.businessOf(lead);
  const last = lead.messages.filter((m) => m.role === 'customer').at(-1)?.text || '';
  const t = lower(last);
  const flow = lead.flow || {};
  const booking = B.activeBookingForLead(lead.id);
  const save = (patch) => store.updateLead(lead.id, { flow: { ...flow, ...patch } });
  const isQuestion = /\?\s*$/.test(last.trim()) || /^(what|can|could|how|is|are|do|does|will|would)\b/.test(t);

  if (booking) {
    if (/\b(yes|approve|ok)\b/.test(t) && booking.changes.some((c) => c.status === 'proposed')) {
      B.decideChange(booking.id, null, true);
      return 'Thanks, that change is approved.';
    }
    if (/\bno\b/.test(t) && booking.changes.some((c) => c.status === 'proposed')) {
      B.decideChange(booking.id, null, false);
      return "No problem, we'll leave it as is.";
    }
    // We canceled on our side: "refund" or "cancel" both mean "send my money back" (never a cancel fee).
    if (booking.status === 'needs_rebook' && (/refund/.test(t) || (/cancel/.test(t) && !isQuestion))) {
      const r = await B.refund(booking.id, { reason: 'Business canceled; customer chose a refund' });
      return `Done. ${B.usd(r.refunded)} is on its way back to you.`;
    }
    if (isQuestion && /(refund|cancel|money back)/.test(t)) return policyAnswer(booking);
    if (/(over time|pay later|installment|pay in 4|monthly|financ|afford|payment plan)/.test(t)) return payLaterAnswer(booking);
    if (!/split/.test(t) && /(someone else|husband|wife|\bmom\b|\bdad\b|partner|boss|employer|landlord|pay for (it|this|me)|send (it|the bill|the link) to)/.test(t)) {
      const r = await B.linkForSomeoneElse(booking.id, '');
      return `Sure! Forward them this link. They can pay with their own PayPal, Venmo or card (no account needed), and you'll both see the confirmation: ${r.link}`;
    }
    if (/cancel/.test(t)) {
      let r;
      try {
        r = await B.customerCancel(booking.id);
      } catch (err) {
        return err.message; // e.g. the job is already done: a plain-words answer, not a failed send
      }
      if (r.outcome === 'kept_deposit') return `Canceled. Since it's past the free-cancel time (${r.deadline}), the ${B.usd(r.kept)} deposit is kept, as agreed at booking. Want to reschedule instead next time? Rescheduling is always free.`;
      return 'All canceled. Text us anytime to book again.';
    }
    if (/split/.test(t)) {
      const r = await B.splitDue(booking.id, 2);
      return `Here are two links, ${B.usd(r.links[0].amount)} each: ${r.links.map((l) => l.link).join(' and ')}`;
    }
    const dayWord = /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(tomorrow|today|weekend|morning|afternoon|evening)\b/;
    const wantsMove = /(move|reschedule|another time|different time|change (the|my|it)|push (it )?(back|to)|switch|swap)/.test(t)
      || (dayWord.test(t) && /(instead|can we|could we|can you|could you|make it|do it|let'?s do|how about|what about)/.test(t));
    if (wantsMove || flow.rescheduling) {
      const pick = t.match(/\b([1-3])\b/);
      if (pick && flow.offered) {
        const slot = flow.offered[Number(pick[1]) - 1];
        if (slot) {
          save({ rescheduling: false, offered: null });
          await B.reschedule(booking.id, slot.start);
          return null; // reschedule() already texted the confirmation
        }
      }
      const found = slotsMatching(business, t, 4);
      const slots = found.slots.filter((s) => s.start !== booking.slotStart).slice(0, 3);
      save({ rescheduling: true, offered: slots });
      const lead_in = found.asked && !found.matched ? "Nothing's open then, but here's what I have. " : 'Sure! ';
      return `${lead_in}Reply 1, 2 or 3: ${slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ')}`;
    }
    const tt = B.totals(booking);
    return `You're ${B.STATUS_WORDS[booking.status].toLowerCase()} for ${booking.slotLabel}. Total ${B.usd(tt.total)}, paid ${B.usd(tt.paid)}, owed ${B.usd(tt.due)}. Details: ${B.bookingPageUrl(booking)}`;
  }

  // New booking flow
  const service = flow.serviceId ? business.services.find((s) => s.id === flow.serviceId) : detectService(business, last);
  if (!service) {
    return `Hi! Thanks for reaching out to ${business.name}. Which service do you need: ${business.services.map((s) => s.name.toLowerCase()).join(', ')}?`;
  }
  const oneSize = Object.keys(service.sizes).length === 1 ? Object.keys(service.sizes)[0] : null;
  const size = flow.size || oneSize || detectSize(service, last);
  if (!flow.serviceId || !size) {
    save({ serviceId: service.id, size: size || null });
    if (!size) return `Great, ${service.name.toLowerCase()}. ${business.sizeQuestion || 'Which option do you need?'}`;
  }
  if (!flow.slot) {
    const pick = t.match(/\b([1-3])\b/);
    if (pick && flow.offered) {
      const slot = flow.offered[Number(pick[1]) - 1];
      save({ serviceId: service.id, size, slot });
      if (!lead.name) return `Perfect, ${slot.label} it is. What's your first name?`;
    } else {
      const q = B.quote(business, service.id, size);
      const recent = lead.messages.filter((m) => m.role === 'customer').slice(-4).map((m) => m.text).join(' ');
      const { slots, matched, asked } = slotsMatching(business, recent, 3);
      save({ serviceId: service.id, size, offered: slots });
      const what = size === 'standard' ? service.name : `${service.name} for ${size}`;
      const lead_in = asked && !matched ? "Nothing's open then, but here's what I have: " : 'Open times: ';
      return `${what} is ${q.price > 0 ? B.usd(q.price) : 'free'}. ${lead_in}${slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ')}. Reply 1, 2 or 3.`;
    }
  }
  const chosen = (store.getLead(lead.id).flow || {}).slot;
  const name = lead.name || (last.length < 40 && !/\d/.test(last) ? last.trim().split(/\s+/)[0] : '');
  if (!name) return "What's your first name?";
  const r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: service.id, size, slotStart: chosen.start, customerName: name });
  save({ slot: null, offered: null });
  return `Got it, ${name}! I'm holding ${r.booking.slotLabel} for you. ${r.terms} Tap to pay the deposit (card, Venmo, Pay Later or PayPal): ${r.payLink}`;
}

export async function scriptedOwnerReply(text) {
  const t = lower(text);
  const current = B.currentBusiness();
  const can = (b) => B.ownerCanTouch(b, current);
  const named = (n) => B.findBookingsByName(n).filter(can);
  const byName = (re) => {
    const m = t.match(re);
    if (!m) return null;
    return named(m[1]).find((b) => !['canceled', 'refunded'].includes(b.status)) || named(m[1])[0] || null;
  };
  try {
    if (/(who|anyone).*(owe|hasn|not paid|unpaid)|owing/.test(t)) {
      const list = B.owing().filter(can);
      if (!list.length) return 'Nobody owes you anything right now.';
      return list.map((b) => `${b.customerName}: ${B.usd(b.payments.find((p) => p.status === 'pending').amount)} (${b.slotLabel})`).join('; ');
    }
    if (/remind/.test(t)) {
      const names = [];
      for (const b of B.owing().filter(can)) names.push((await B.remind(b.id)).customerName);
      return names.length ? `Reminders sent to ${names.join(', ')}.` : 'Nobody owes anything, so no reminders went out.';
    }
    let b = byName(/refund\s+(\w+)/);
    if (b) {
      const r = await B.refund(b.id, { reason: 'Owner request' });
      return `Refunded ${B.usd(r.refunded)} to ${b.customerName}. Reference ${r.reference}.`;
    }
    const cash = t.match(/(\w+)\s+paid\s+\$?(\d+(?:\.\d+)?)\s*(cash|check)?/);
    if (cash) {
      b = named(cash[1])[0];
      if (b) {
        const recorded = B.recordOutsidePayment(b.id, { amount: Number(cash[2]), method: cash[3] || 'cash' }).payments.at(-1);
        return `Recorded ${B.usd(recorded.amount)} ${cash[3] || 'cash'} from ${b.customerName}.`;
      }
    }
    b = byName(/(?:done|finished)(?:\s+(?:at|with))?\s+(\w+)/);
    if (b) {
      const r = await B.markCompleted(b.id);
      return r.payLink ? `Marked done. Sent ${b.customerName} the ${B.usd(r.due)} balance link.` : `Marked done. ${b.customerName} is paid up.`;
    }
    b = byName(/cancel\s+(\w+)/);
    if (b) {
      await B.businessCancel(b.id, '');
      return `Told ${b.customerName} we have to cancel and offered new times or a full refund.`;
    }
    if (/(how did we do|summary|this week|money)/.test(t)) {
      const m = B.moneySummary({ days: 7, presetId: current.id });
      return `Last 7 days: ${B.usd(m.gross)} in, ${B.usd(m.fees)} PayPal fees, ${B.usd(m.refunds)} refunded, ${B.usd(m.net)} net. ${B.usd(m.stillOwed)} still owed.`;
    }
    if (/rebook|repeat/.test(t)) {
      const r = await B.sendRebookNudges({ force: true, presetId: current.id });
      return r.nudged.length ? `Sent rebooking texts to ${r.nudged.join(', ')}.` : 'Nobody is due for a rebooking text yet.';
    }
  } catch (err) {
    return err.message;
  }
  return 'I can tell you who owes, send reminders, refund someone, mark a job done, record cash, cancel an appointment or give you a money summary.';
}
