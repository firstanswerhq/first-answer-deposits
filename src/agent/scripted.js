// Scripted fallback used when no AI key is set, so anyone can run the full flow locally.
// The real product uses the AI agents in customer.js and owner.js.
import * as store from '../store.js';
import * as B from '../bookings.js';
import { parseName, bareName } from './names.js';

const lower = (s) => String(s || '').toLowerCase();
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WORD_NUM = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8' };
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
// The last day the text names wins: "Friday... do you have Saturday?" means Saturday.
const DAY_MENTION = /\b(tomorrow|today|weekend|sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/g;
// Asking for other times without naming one: "another day", "anything else?", "a different time".
const OTHER_TIMES = /\b(another|different|other|else|later|earlier)\b|next week/;
const TIME_WORDS = /\b(tomorrow|today|weekend|morning|afternoon|evening|tonight|sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/;

function lastDayMention(t) {
  const all = [...lower(t).matchAll(DAY_MENTION)];
  return all.length ? all.at(-1)[1] : null;
}

// "Friday morning", "tomorrow", "this weekend": pick the open times that match what they asked for.
// avoid: times offered before; "another day" with no day named skips those days.
export function slotsMatching(business, text, limit = 3, { avoid = [] } = {}) {
  const t = lower(text);
  let all = B.availableSlots(business, { limit: 60, days: 14 });
  const local = (iso) => new Date(new Date(iso).toLocaleString('en-US', { timeZone: business.timezone }));
  const dateKey = (iso) => local(iso).toDateString();
  const said = lastDayMention(t);
  if (!said && avoid.length && OTHER_TIMES.test(t)) {
    const days = new Set(avoid.map((s) => dateKey(s.start)));
    const starts = new Set(avoid.map((s) => s.start));
    const otherDay = all.filter((s) => !days.has(dateKey(s.start)));
    all = /\bday|date|week\b/.test(t) || !otherDay.length ? (otherDay.length ? otherDay : all) : all.filter((s) => !starts.has(s.start));
  }
  let want = all;
  if (said === 'tomorrow' || said === 'today') {
    const d = local(new Date().toISOString());
    if (said === 'tomorrow') d.setDate(d.getDate() + 1);
    want = all.filter((s) => local(s.start).toDateString() === d.toDateString());
  } else if (said === 'weekend') {
    want = all.filter((s) => [0, 6].includes(local(s.start).getDay()));
  } else if (said) {
    const day = DAYS.indexOf(said.slice(0, 3));
    want = all.filter((s) => local(s.start).getDay() === day);
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

const SIZE_NOUN = /\b(bed(?:room)?s?|br|bd|bdrm|rooms?|systems?|units?|homes?|house|apartment|apt)\b/;
const singular = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const numWords = (s) => lower(s).replace(/\b(one|two|three|four|five|six|seven|eight)\b/g, (w) => WORD_NUM[w]).replace(/\bstudio\b/g, '1');

// Which size they mean. Numbers count when they come with a size word ("2 bedroom", "two systems") or when we
// just asked the size question ("2"); "1-2 bedrooms" covers 1 and 2, "4+ bedrooms" covers 4 and up.
export function detectSize(service, text, { asked = false } = {}) {
  const keys = Object.keys(service.sizes);
  if (keys.length === 1) return keys[0];
  const t = numWords(text).replace(/(\d)\s*-?\s*(br|bd|bdrm)\b/g, '$1 bedroom');
  const exact = keys.find((k) => t.includes(lower(k)));
  if (exact) return exact;
  if (SIZE_NOUN.test(t) || (asked && /^\s*\d{1,2}\s*\+?\s*[.!]?\s*$/.test(t))) {
    for (const m of t.matchAll(/\b(\d{1,2})\b/g)) {
      const n = Number(m[1]);
      const key = keys.find((k) => {
        const kl = numWords(k);
        const range = kl.match(/(\d+)\s*-\s*(\d+)/);
        if (range) return n >= Number(range[1]) && n <= Number(range[2]);
        const plus = kl.match(/(\d+)\s*\+/);
        if (plus) return n >= Number(plus[1]);
        const one = kl.match(/\b(\d+)\b/);
        return one && Number(one[1]) === n;
      });
      if (key) return key;
    }
  }
  // Words that set one option apart ("suv", "truck", "car").
  const words = new Set(t.split(/[^a-z]+/).filter(Boolean).map(singular));
  const own = keys.map((k) => lower(k).split(/[^a-z]+/).filter((w) => w.length > 1 && !['or', 'and', 'the', 'a'].includes(w)).map(singular));
  const shared = own[0].filter((w) => own.every((ws) => ws.includes(w)));
  const i = own.findIndex((ws) => ws.some((w) => !shared.includes(w) && words.has(w)));
  return i >= 0 ? keys[i] : null;
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

const timesLine = (slots) => slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
// "2", "#2", "option 2", "the second one".
function pickNumber(t, max = 3) {
  const m = t.match(/^\s*(?:#|option\s*|number\s*|the\s+)?([1-9])\b/) || t.match(/\b(first|second|third)\b/);
  if (!m) return null;
  const n = /\d/.test(m[1]) ? Number(m[1]) : ['first', 'second', 'third'].indexOf(m[1]) + 1;
  return n >= 1 && n <= max ? n : null;
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
      const r = await B.acceptBusinessCancel(booking.id);
      if (r.outcome === 'released') return "All canceled. Nothing was charged, so there's nothing to refund. Text us anytime to book again.";
      return `Done. ${B.usd(r.refunded)} is on its way back to you.`;
    }
    if (isQuestion && /(refund|cancel|money back)/.test(t)) return policyAnswer(booking);
    if (/(over time|pay later|installment|pay in 4|monthly|financ|afford|payment plan)/.test(t)) return payLaterAnswer(booking);
    const email = (last.match(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i) || [''])[0];
    const askedForEmail = /What email should I send the invoice to/.test(lead.messages.filter((m) => m.role === 'assistant').at(-1)?.text || '');
    if (/\b(invoice|e-?mail me|email it|bill me)\b/.test(t) || (email && askedForEmail)) {
      try {
        const r = await B.emailDepositInvoice(booking.id, { email });
        return r.message;
      } catch (err) {
        return err.message;
      }
    }
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
    const wantsMove = /(move|reschedule|another (time|day)|different (time|day)|other (times|days)|change (the|my|it)|push (it )?(back|to)|switch|swap)/.test(t)
      || (dayWord.test(t) && /(instead|can we|could we|can you|could you|make it|do it|let'?s do|how about|what about|do you have|anything)/.test(t));
    if (wantsMove || flow.rescheduling) {
      const pick = pickNumber(t);
      if (pick && flow.offered && !TIME_WORDS.test(t)) {
        const slot = flow.offered[pick - 1];
        if (slot) {
          save({ rescheduling: false, offered: null });
          await B.reschedule(booking.id, slot.start);
          return null; // reschedule() already texted the confirmation
        }
      }
      // Asked for another day without naming one: never offer the same times again.
      const avoid = [...(flow.offered || []), { start: booking.slotStart }];
      const found = slotsMatching(business, t, 6, { avoid: OTHER_TIMES.test(t) ? avoid : [] });
      const slots = found.slots.filter((s) => s.start !== booking.slotStart).slice(0, 3);
      if (!slots.length) return "Nothing else is open in the next two weeks. Want me to put you on the waitlist?";
      save({ rescheduling: true, offered: slots });
      const leadIn = found.asked && !found.matched ? "Nothing's open then, but here's what I have. " : 'Sure! ';
      return `${leadIn}Reply 1, 2 or 3: ${timesLine(slots)}`;
    }
    const tt = B.totals(booking);
    return `You're ${B.STATUS_WORDS[booking.status].toLowerCase()} for ${booking.slotLabel}. Total ${B.usd(tt.total)}, paid ${B.usd(tt.paid)}, owed ${B.usd(tt.due)}. Details: ${B.bookingPageUrl(booking)}`;
  }

  // ---------- new booking: service, size, time, name, then book ----------
  const said = detectService(business, last);
  const service = said || (flow.serviceId ? business.services.find((s) => s.id === flow.serviceId) : null);
  // A name can come at any point: "My name is Dana Cole", or a bare "Dana" right after we asked.
  // A bare "Dana" counts when we asked for it, or when no name is known yet and it isn't a pick or a question.
  const named = parseName(last) || (flow.askedName || (!lead.name && flow.offered && !pickNumber(t)) ? bareName(last) : null);
  if (named) store.updateLead(lead.id, { name: named });
  const name = named || lead.name || '';
  if (!service) {
    return `Hi${name ? ` ${firstName(name)}` : ''}! Thanks for reaching out to ${business.name}. Which service do you need: ${business.services.map((s) => s.name.toLowerCase()).join(', ')}?`;
  }
  const sameService = flow.serviceId === service.id;
  const sizeNow = detectSize(service, last, { asked: Boolean(flow.askedSize && sameService) });
  const size = sizeNow || (sameService ? flow.size : null);
  const next = { serviceId: service.id, size: size || null, slot: sameService ? flow.slot || null : null, offered: sameService ? flow.offered || null : null, askedSize: false, askedName: false };
  if (!size) {
    save({ ...next, askedSize: true });
    return `Great, ${service.name.toLowerCase()}. ${business.sizeQuestion || 'Which option do you need?'}`;
  }

  // A day or time named now ("Can we do Saturday instead?", "anything else?") means new times, even after a pick.
  const asksTimes = TIME_WORDS.test(t) || (next.offered && OTHER_TIMES.test(t));
  const sizeSaidNow = Object.keys(service.sizes).length > 1 && sizeNow;
  const pick = !asksTimes && next.offered && !sizeSaidNow ? pickNumber(t) : null;
  if (pick && next.offered[pick - 1]) next.slot = next.offered[pick - 1];
  if (!next.slot && named && next.offered?.length && !asksTimes) {
    save(next);
    return `Thanks, ${firstName(named)}! Which time works? Reply 1, 2 or 3: ${timesLine(next.offered)}`;
  }
  if (!next.slot || asksTimes) {
    const q = B.quote(business, service.id, size);
    // The latest message that names a time decides; else the first ones ("deep clean Friday morning, 2 bedroom").
    const recent = lead.messages.filter((m) => m.role === 'customer').slice(-4).map((m) => m.text);
    const dayText = TIME_WORDS.test(t) || OTHER_TIMES.test(t) ? last : [...recent].reverse().find((x) => TIME_WORDS.test(lower(x))) || '';
    const { slots, matched, asked } = slotsMatching(business, dayText, 3, { avoid: next.offered || [] });
    if (!slots.length) return `Sorry, nothing is open in the next two weeks. Want me to put you on the waitlist?`;
    save({ ...next, slot: null, offered: slots });
    const what = size === 'standard' ? service.name : `${service.name} for ${size}`;
    const leadIn = asked && !matched ? "Nothing's open then, but here's what I have: " : 'Open times: ';
    return `${what} is ${q.price > 0 ? B.usd(q.price) : 'free'}. ${leadIn}${timesLine(slots)}. Reply 1, 2 or 3.`;
  }
  if (!name) {
    save({ ...next, askedName: true });
    return `Perfect, ${next.slot.label} it is. What's your first name?`;
  }
  let r;
  try {
    r = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: service.id, size, slotStart: next.slot.start, customerName: name });
  } catch (err) {
    // The time was taken a moment ago: offer fresh ones instead of failing.
    const { slots } = slotsMatching(business, '', 3, { avoid: [next.slot] });
    save({ ...next, slot: null, offered: slots });
    return `${err.message.replace(/ Offer other times\.?$/, '')} Here's what's open now: ${timesLine(slots)}. Reply 1, 2 or 3.`;
  }
  save({ slot: null, offered: null, askedName: false, askedSize: false });
  return `Got it, ${firstName(name)}! I'm holding ${r.booking.slotLabel} for you. ${r.terms} Tap to pay the deposit (card, Venmo, Pay Later or PayPal): ${r.payLink}`;
}

// ---------- the owner's scripted office manager ----------
const YES = /^\s*(yes|y|yep|yeah|yup|confirm|confirmed|do it|go ahead|ok|okay|sure)\b/i;
const NO = /^\s*(no|n|nope|nah|don'?t|stop|never ?mind|cancel that)\b/i;

function describe(b) {
  const t = B.totals(b);
  return `${b.customerName}, ${b.service} ${b.slotLabel}, paid ${B.usd(t.paid)}${t.tips ? ` + ${B.usd(t.tips)} tip` : ''}`;
}

// What the owner is asked before money moves or a job closes early. Returns the question, or null to run now.
function questionFor(action, b, amount) {
  if (action === 'refund') {
    const t = B.totals(b);
    const full = amount === null || amount === undefined;
    const sum = full ? Math.round((t.paid + t.tips) * 100) / 100 : amount;
    const what = full && t.tips > 0 ? ` (${B.usd(t.paid)} paid plus the ${B.usd(t.tips)} tip)` : full ? '' : ` of the ${B.usd(t.paid)} paid`;
    return `Refund ${B.usd(sum)}${what} to ${b.customerName}? Reply YES to send it back the way they paid, or NO.`;
  }
  if (action === 'no_show') {
    return `Mark ${b.customerName} as a no-show for ${b.slotLabel}? Per the terms they agreed to, the ${B.usd(B.totals(b).depositPaid)} deposit is kept. Reply YES or NO.`;
  }
  if (action === 'done' && Date.parse(b.slotStart) > Date.now()) {
    return `${b.customerName}'s appointment is ${b.slotLabel}, which hasn't happened yet. Mark it done now and text the final bill anyway? Reply YES or NO.`;
  }
  return null;
}

async function runAction(action, b, amount) {
  if (action === 'refund') {
    const r = await B.refund(b.id, { amount: amount ?? null, reason: 'Owner request' });
    const demo = String(r.reference).startsWith('DEMO-') ? ' (demo money: settled here, no PayPal call)' : '';
    if (r.released) return `Released ${b.customerName}'s ${B.usd(r.refunded)} deposit hold in PayPal; they were never charged. Reference ${r.reference}${demo}.`;
    return `Refunded ${B.usd(r.refunded)} to ${b.customerName}${r.tipRefunded ? ` (including the ${B.usd(r.tipRefunded)} tip)` : ''}. Reference ${r.reference}${demo}.`;
  }
  if (action === 'done') {
    const r = await B.markCompleted(b.id);
    return r.payLink ? `Marked done. Sent ${b.customerName} the ${B.usd(r.due)} balance link.` : `Marked done. ${b.customerName} is paid up.`;
  }
  if (action === 'no_show') {
    const nb = await B.markNoShow(b.id);
    return `Marked ${b.customerName} as a no-show. ${B.usd(nb.depositKept || 0)} deposit kept, as agreed at booking.`;
  }
  if (action === 'cancel') {
    await B.businessCancel(b.id, '');
    return `Told ${b.customerName} we have to cancel and offered new times or a full refund.`;
  }
  throw new Error('Unknown action.');
}

// One booking: ask (if the action needs a YES) or run. Several: ask which one.
async function askOrRun(businessId, action, matches, amount) {
  if (matches.length > 1) {
    store.setOwnerPending(businessId, { kind: 'choose', action, amount, options: matches.slice(0, 5).map((b) => b.id) });
    const first = firstName(matches[0].customerName);
    return `Which ${first}? ${matches.slice(0, 5).map((b, i) => `${i + 1}) ${describe(b)}`).join('  ')}. Reply with the number.`;
  }
  const b = matches[0];
  const q = questionFor(action, b, amount);
  if (q) {
    store.setOwnerPending(businessId, { kind: 'confirm', action, amount, bookingId: b.id });
    return q;
  }
  return runAction(action, b, amount);
}

function scheduleFor(current, t, mine) {
  const tz = current.timezone;
  const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const said = lastDayMention(t);
  const now = new Date();
  let label = 'coming up';
  let keep = (b) => Date.parse(b.slotStart) >= now.getTime() - 3 * 3600 * 1000;
  if (said === 'today' || said === 'tomorrow') {
    const d = new Date(now.getTime() + (said === 'tomorrow' ? 86400000 : 0));
    label = said;
    keep = (b) => dayKey(new Date(b.slotStart)) === dayKey(d);
  } else if (said && said !== 'weekend') {
    const day = DAYS.indexOf(said.slice(0, 3));
    label = `on ${said[0].toUpperCase()}${said.slice(1)}`;
    keep = (b) => Date.parse(b.slotStart) >= now.getTime() && new Date(new Date(b.slotStart).toLocaleString('en-US', { timeZone: tz })).getDay() === day && Date.parse(b.slotStart) < now.getTime() + 7 * 86400000;
  }
  const list = store
    .listBookings()
    .filter(mine)
    .filter((b) => ['held', 'confirmed', 'completed', 'needs_rebook'].includes(b.status))
    .filter(keep)
    .sort((a, b) => Date.parse(a.slotStart) - Date.parse(b.slotStart))
    .slice(0, 8);
  if (!list.length) return `Nothing on the calendar ${label}.`;
  return `${label[0].toUpperCase()}${label.slice(1)}: ${list.map((b) => `${b.slotLabel.replace(/^\w+, /, '')} ${b.customerName}, ${b.service.toLowerCase()} (${B.STATUS_WORDS[b.status].toLowerCase()})`).join('; ')}.`;
}

export async function scriptedOwnerReply(text) {
  const t = lower(text).trim();
  const current = B.currentBusiness();
  // The office manager works on the business it is running for, nothing else.
  const mine = (b) => B.ownerCanTouch(b, current);
  const named = (n) => B.findBookingsByName(n).filter(mine);
  const NAME = "([a-z][a-z'-]+(?:\\s+[a-z][a-z'-]+)?)";
  // Two words ("sarah kim") if that matches someone, else the first word ("sarah").
  const candidates = (raw, keep) => {
    const words = String(raw || '').replace(/'s$/, '').split(/\s+/).filter((w) => !['at', 'with', 'for', 'to', 'the'].includes(w));
    for (const n of [words.slice(0, 2).join(' '), words[0]]) {
      if (!n) continue;
      const found = named(n.replace(/'s$/, '')).filter(keep);
      if (found.length) return found;
    }
    return [];
  };
  try {
    // An answer to the last question ("Refund $260 to Sarah Kim? Reply YES", "Which Sarah?").
    const pending = store.getOwnerPending(current.id);
    if (pending) {
      store.setOwnerPending(current.id, null);
      if (pending.kind === 'confirm' && YES.test(t)) {
        const b = store.getBooking(pending.bookingId);
        if (b && mine(b)) return await runAction(pending.action, b, pending.amount);
      }
      if (NO.test(t)) return 'OK, nothing was changed.';
      if (pending.kind === 'choose') {
        const options = pending.options.map((id) => store.getBooking(id)).filter((b) => b && mine(b));
        const n = pickNumber(t, options.length);
        const chosen = n ? options[n - 1] : options.filter((b) => lower(b.customerName).includes(t.replace(/^the\s+/, ''))).length === 1 ? options.find((b) => lower(b.customerName).includes(t)) : null;
        if (chosen) return await askOrRun(current.id, pending.action, [chosen], pending.amount);
      }
      // Anything else: the question is dropped and the new message is handled on its own.
    }

    if (/(who|anyone).*(owe|hasn|not paid|unpaid)|owing/.test(t)) {
      const list = B.owing().filter(mine);
      if (!list.length) return 'Nobody owes you anything right now.';
      return list.map((b) => `${b.customerName}: ${B.usd(b.payments.find((p) => p.status === 'pending').amount)}${b.status === 'held' ? ' deposit' : ' balance'} (${b.slotLabel})`).join('; ');
    }
    if (/what'?s on|what is on|schedule|calendar|agenda|upcoming|appointments|who'?s (booked|coming)|what do (i|we) have/.test(t)) return scheduleFor(current, t, mine);
    if (/remind/.test(t)) {
      const names = [];
      for (const b of B.owing().filter(mine)) names.push((await B.remind(b.id)).customerName);
      return names.length ? `Reminders sent to ${names.join(', ')}.` : 'Nobody owes anything, so no reminders went out.';
    }
    // "refund Sarah", "refund Sarah $50", "refund $50 to Sarah"
    const rf = t.match(new RegExp(`refund\\s+(?:\\$?(\\d+(?:\\.\\d+)?)\\s+(?:to\\s+)?)?${NAME}(?:\\s+\\$?(\\d+(?:\\.\\d+)?))?`));
    if (rf) {
      const amount = rf[1] || rf[3] ? Number(rf[1] || rf[3]) : null;
      const all = candidates(rf[2], () => true);
      const list = all.filter((b) => B.totals(b).paid > 0 || B.totals(b).tips > 0);
      if (!all.length) return `I couldn't find a booking for "${rf[2]}".`;
      if (!list.length) return `${all[0].customerName} hasn't paid anything, so there is nothing to refund.`;
      return await askOrRun(current.id, 'refund', list, amount);
    }
    const cash = t.match(/(\w+)\s+paid\s+\$?(\d+(?:\.\d+)?)\s*(cash|check)?/);
    if (cash) {
      const b = named(cash[1]).find((x) => B.totals(x).due > 0) || named(cash[1])[0];
      if (b) {
        const recorded = B.recordOutsidePayment(b.id, { amount: Number(cash[2]), method: cash[3] || 'cash' }).payments.at(-1);
        return `Recorded ${B.usd(recorded.amount)} ${cash[3] || 'cash'} from ${b.customerName}.`;
      }
    }
    const ns = t.match(new RegExp(`no[- ]?show(?:\\s+(?:for|at))?\\s+${NAME}`)) || t.match(new RegExp(`${NAME}\\s+(?:didn'?t|did not|never)\\s+show`));
    if (ns) {
      const all = candidates(ns[1], () => true);
      const list = all.filter((b) => ['confirmed', 'held'].includes(b.status));
      if (!all.length) return `I couldn't find a booking for "${ns[1]}".`;
      if (!list.length) return `${all[0].customerName}'s booking is ${B.STATUS_WORDS[all[0].status].toLowerCase()}, so it can't be a no-show.`;
      return await askOrRun(current.id, 'no_show', list, null);
    }
    const done = t.match(new RegExp(`(?:done|finished)(?:\\s+(?:at|with))?\\s+${NAME}`)) || t.match(new RegExp(`${NAME}(?:'s)?\\s+(?:is|job is)\\s+(?:done|finished)`));
    if (done) {
      const all = candidates(done[1], () => true);
      const list = all.filter((b) => ['confirmed', 'held'].includes(b.status));
      if (!all.length) return `I couldn't find a booking for "${done[1]}".`;
      if (!list.length) return `${all[0].customerName}'s booking is ${B.STATUS_WORDS[all[0].status].toLowerCase()}, so there's no open job to mark done.`;
      return await askOrRun(current.id, 'done', list, null);
    }
    const cn = t.match(new RegExp(`cancel\\s+${NAME}`));
    if (cn) {
      const list = candidates(cn[1], (b) => ['held', 'confirmed'].includes(b.status));
      if (list.length) return await askOrRun(current.id, 'cancel', list, null);
    }
    if (/(how did we do|summary|this week|money)/.test(t)) {
      const m = B.moneySummary({ days: 7, presetId: current.id });
      return `Last 7 days: ${B.usd(m.gross)} in, ${B.usd(m.fees)} PayPal fees, ${B.usd(m.refunds)} refunded, ${B.usd(m.net)} net. ${B.usd(m.stillOwed)} still owed.${m.onHold ? ` ${B.usd(m.onHold)} in deposits held in PayPal, not charged yet.` : ''}`;
    }
    if (/rebook|repeat/.test(t)) {
      const r = await B.sendRebookNudges({ force: true, presetId: current.id });
      return r.nudged.length ? `Sent rebooking texts to ${r.nudged.join(', ')}.` : 'Nobody is due for a rebooking text yet.';
    }
  } catch (err) {
    return err.message;
  }
  return "I can tell you who owes, what's on the calendar, send reminders, refund someone, mark a job done or a no-show, record cash, cancel an appointment or give you a money summary.";
}
