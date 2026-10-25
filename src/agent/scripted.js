// Scripted fallback used when no AI key is set, so anyone can run the full flow locally.
// The real product uses the AI agents in customer.js and owner.js.
import * as store from '../store.js';
import * as B from '../bookings.js';

const lower = (s) => String(s || '').toLowerCase();

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

export async function scriptedCustomerReply(lead) {
  const business = B.businessOf(lead);
  const last = lead.messages.filter((m) => m.role === 'customer').at(-1)?.text || '';
  const t = lower(last);
  const flow = lead.flow || {};
  const booking = B.activeBookingForLead(lead.id);
  const save = (patch) => store.updateLead(lead.id, { flow: { ...flow, ...patch } });

  if (booking) {
    if (/\b(yes|approve|ok)\b/.test(t) && booking.changes.some((c) => c.status === 'proposed')) {
      B.decideChange(booking.id, null, true);
      return 'Thanks, that change is approved.';
    }
    if (/\bno\b/.test(t) && booking.changes.some((c) => c.status === 'proposed')) {
      B.decideChange(booking.id, null, false);
      return "No problem, we'll leave it as is.";
    }
    if (/refund/.test(t) && booking.status === 'needs_rebook') {
      const r = await B.refund(booking.id, { reason: 'Business canceled; customer chose a refund' });
      return `Done. ${B.usd(r.refunded)} is on its way back to you.`;
    }
    if (/cancel/.test(t)) {
      const r = await B.customerCancel(booking.id);
      if (r.outcome === 'kept_deposit') return `Canceled. Since it's past the free-cancel time (${r.deadline}), the ${B.usd(r.kept)} deposit is kept, as agreed at booking. Want to reschedule instead next time? Rescheduling is always free.`;
      return 'All canceled. Text us anytime to book again.';
    }
    if (/split/.test(t)) {
      const r = await B.splitDue(booking.id, 2);
      return `Here are two links, ${B.usd(r.links[0].amount)} each: ${r.links.map((l) => l.link).join(' and ')}`;
    }
    if (/(move|reschedule|another time|different time)/.test(t) || flow.rescheduling) {
      const pick = t.match(/\b([1-3])\b/);
      if (pick && flow.offered) {
        const slot = flow.offered[Number(pick[1]) - 1];
        if (slot) {
          save({ rescheduling: false, offered: null });
          await B.reschedule(booking.id, slot.start);
          return null; // reschedule() already texted the confirmation
        }
      }
      const slots = B.availableSlots(business, { limit: 3 }).filter((s) => s.start !== booking.slotStart);
      save({ rescheduling: true, offered: slots });
      return `Sure! Reply 1, 2 or 3: ${slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ')}`;
    }
    const tt = B.totals(booking);
    return `You're ${B.STATUS_WORDS[booking.status].toLowerCase()} for ${booking.slotLabel}. Total ${B.usd(tt.total)}, paid ${B.usd(tt.paid)}, owed ${B.usd(tt.due)}. Details: ${B.bookingPageUrl(booking)}`;
  }

  // New booking flow
  const service = flow.serviceId ? business.services.find((s) => s.id === flow.serviceId) : detectService(business, last);
  if (!service) {
    return `Hi! Thanks for reaching out to ${business.name}. Which service do you need: ${business.services.map((s) => s.name.toLowerCase()).join(', ')}?`;
  }
  const size = flow.size || detectSize(service, last);
  if (!flow.serviceId || !size) {
    save({ serviceId: service.id, size: size || null });
    if (!size) return `Great, a ${service.name.toLowerCase()}. ${business.sizeQuestion}`;
  }
  if (!flow.slot) {
    const pick = t.match(/\b([1-3])\b/);
    if (pick && flow.offered) {
      const slot = flow.offered[Number(pick[1]) - 1];
      save({ serviceId: service.id, size, slot });
      if (!lead.name) return `Perfect, ${slot.label} it is. What's your first name?`;
    } else {
      const q = B.quote(business, service.id, size);
      const slots = B.availableSlots(business, { limit: 3 });
      save({ serviceId: service.id, size, offered: slots });
      return `A ${service.name.toLowerCase()} for ${size} is ${B.usd(q.price)}. Open times: ${slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ')}. Reply 1, 2 or 3.`;
    }
  }
  const chosen = (store.getLead(lead.id).flow || {}).slot;
  const name = lead.name || (last.length < 40 && !/\d/.test(last) ? last.trim().split(/\s+/)[0] : '');
  if (!name) return "What's your first name?";
  const r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: service.id, size, slotStart: chosen.start, customerName: name });
  save({ slot: null, offered: null });
  return `You're held for ${r.booking.slotLabel}, ${name}! ${r.terms}. Pay the deposit here (card, Venmo, Pay Later or PayPal): ${r.payLink}`;
}

export async function scriptedOwnerReply(text) {
  const t = lower(text);
  const byName = (re) => {
    const m = t.match(re);
    if (!m) return null;
    return B.findBookingsByName(m[1]).find((b) => !['canceled', 'refunded'].includes(b.status)) || B.findBookingsByName(m[1])[0] || null;
  };
  try {
    if (/(who|anyone).*(owe|hasn|not paid|unpaid)|owing/.test(t)) {
      const list = B.owing();
      if (!list.length) return 'Nobody owes you anything right now.';
      return list.map((b) => `${b.customerName}: ${B.usd(b.payments.find((p) => p.status === 'pending').amount)} (${b.slotLabel})`).join('; ');
    }
    if (/remind/.test(t)) {
      const names = [];
      for (const b of B.owing()) names.push((await B.remind(b.id)).customerName);
      return names.length ? `Reminders sent to ${names.join(', ')}.` : 'Nobody owes anything, so no reminders went out.';
    }
    let b = byName(/refund\s+(\w+)/);
    if (b) {
      const r = await B.refund(b.id, { reason: 'Owner request' });
      return `Refunded ${B.usd(r.refunded)} to ${b.customerName}. Reference ${r.reference}.`;
    }
    const cash = t.match(/(\w+)\s+paid\s+\$?(\d+(?:\.\d+)?)\s*(cash|check)?/);
    if (cash) {
      b = B.findBookingsByName(cash[1])[0];
      if (b) {
        B.recordOutsidePayment(b.id, { amount: Number(cash[2]), method: cash[3] || 'cash' });
        return `Recorded ${B.usd(cash[2])} ${cash[3] || 'cash'} from ${b.customerName}.`;
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
      const m = B.moneySummary({ days: 7 });
      return `Last 7 days: ${B.usd(m.gross)} in, ${B.usd(m.fees)} PayPal fees, ${B.usd(m.refunds)} refunded, ${B.usd(m.net)} net. ${B.usd(m.stillOwed)} still owed.`;
    }
    if (/rebook|repeat/.test(t)) {
      const r = await B.sendRebookNudges({ force: true });
      return r.nudged.length ? `Sent rebooking texts to ${r.nudged.join(', ')}.` : 'Nobody is due for a rebooking text yet.';
    }
  } catch (err) {
    return err.message;
  }
  return 'I can tell you who owes, send reminders, refund someone, mark a job done, record cash, cancel an appointment or give you a money summary.';
}
