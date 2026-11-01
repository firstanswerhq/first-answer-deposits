// The customer's own AI assistant, for the agent-to-agent demo page. It is a real MCP client: it connects
// over HTTP to the business's endpoint (/mcp/:bizId) and uses the same tools any outside assistant would.
// With an AI key it runs a model with those tools; with none, a scripted planner makes the same calls.
// Either way it never pays the deposit: it hands the human one PayPal approval link. After the job it can pay the
// final bill through pay_balance, which the business only honors inside a limit the human pre-approved.
import { generateText, stepCountIs } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getModel } from '../agent/model.js';
import { parseName, bareName } from '../agent/names.js';
import { internalHeaders } from '../visitor.js';

export { parseName };

const sessions = new Map();
// A tool call that gets no answer in this long is given up (the business's booking system is on the same host, so a
// healthy call takes well under a second); a whole model turn gets 60 s before the human sees a plain message.
const TOOL_TIMEOUT_MS = 25000;
const TURN_TIMEOUT_MS = 60000;
const lower = (s) => String(s || '').toLowerCase();
const usd = (n) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`;

// The assistant's name is the model family it really runs on. Groq hosts other companies' open models, so a
// Groq key says which one ("GPT-OSS (on Groq)"), never "Groq AI".
export function agentName() {
  const m = getModel();
  if (!m) return 'Demo assistant';
  if (m.provider === 'anthropic') return 'Claude';
  if (m.provider === 'google') return 'Gemini';
  if (m.provider === 'meta') return 'Llama';
  const id = lower(m.name);
  const family = /gpt-oss/.test(id) ? 'GPT-OSS' : /llama/.test(id) ? 'Llama' : /qwen/.test(id) ? 'Qwen' : /kimi/.test(id) ? 'Kimi' : /deepseek/.test(id) ? 'DeepSeek' : /gemma/.test(id) ? 'Gemma' : 'Open model';
  return m.provider === 'groq' ? `${family} (on Groq)` : family;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

function session(id, bizId) {
  let s = sessions.get(id);
  if (!s || (bizId && s.bizId !== bizId)) {
    s = { id, bizId: bizId || 'cleaning', facts: {}, history: [], trace: [], info: null, booking: null, offered: null, pending: null, createdAt: Date.now() };
    sessions.set(id, s);
  }
  if (sessions.size > 500) for (const [k, v] of sessions) if (Date.now() - v.createdAt > 3600000) sessions.delete(k);
  return s;
}

// ---------- MCP client over HTTP ----------
// Every call is recorded for the protocol trace the page shows: tool, args, result.
async function connect(url, trace, headers = {}) {
  const client = new Client({ name: 'customer-assistant', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return {
    client,
    async call(tool, args = {}) {
      const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
      const text = r.content?.find((c) => c.type === 'text')?.text || '';
      let data = r.structuredContent;
      if (data === undefined) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { text };
        }
      }
      trace.push({ tool, args, result: r.isError ? { error: text } : data, error: Boolean(r.isError) });
      if (r.isError) throw new Error(text);
      return data;
    },
    close: () => client.close().catch(() => {}),
  };
}

// ---------- reading the human's words ----------
const DAY_RE = /\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/;
const DAYS = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
const STOP = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'my', 'on', 'to', 'in', 'out', 'inside', 'up', 'with', 'visit', 'new']);
const WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6' };

const normalize = (t) =>
  lower(t)
    .replace(/\b(one|two|three|four|five|six)\b/g, (w) => WORDS[w])
    .replace(/(\d)\s*-?\s*(br|bd|bdrm|beds?|bedrooms?)\b/g, '$1 bedroom');
// "systems" and "system" are the same word here.
const tokens = (t) => normalize(t).split(/[^a-z0-9]+/).filter(Boolean).map((w) => (w.length > 3 && /[a-z]s$/.test(w) ? w.slice(0, -1) : w));

export function parseDay(text) {
  const t = lower(text);
  if (/\btoday\b/.test(t)) return 'today';
  if (/\btomorrow\b/.test(t)) return 'tomorrow';
  const m = t.match(DAY_RE);
  if (m) return DAYS[m[1].slice(0, 3)];
  if (/\bweekend\b/.test(t)) return 'weekend';
  if (/this week|next week|any ?time|whenever|soonest|asap|first open|earliest|next open/.test(t)) return 'any';
  return null;
}

export function parsePart(text) {
  const t = lower(text);
  const clock = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (clock) {
    let h = Number(clock[1]);
    const ap = clock[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h <= 6) h += 12;
    return { hour: h };
  }
  if (/\bmorning\b|\bearly\b/.test(t)) return { part: 'morning' };
  if (/\bafternoon\b|\bmidday\b|\bnoon\b|\blunch/.test(t)) return { part: 'afternoon' };
  if (/\bevening\b|after work|\btonight\b|\blate\b/.test(t)) return { part: 'evening' };
  return null;
}

export function parseBudget(text) {
  const t = lower(text).replace(/,/g, '');
  const m =
    t.match(/(?:under|below|max(?:imum)?|no more than|not more than|up to|budget(?: of| is)?|less than|cap(?:ped)?(?: it)? at|keep it (?:under|below|to|at)|within|at most|limit(?: of)?)\s*\$?\s*(\d+(?:\.\d+)?)/) ||
    t.match(/\$\s?(\d+(?:\.\d+)?)\s*(?:max|budget|or less|tops|limit|cap|at most)/);
  return m ? Number(m[1]) : null;
}

// Which service they mean, scored by how many of its words show up. Ties are ambiguous.
export function pickService(services, text) {
  const words = new Set(tokens(text));
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const s of services) {
    const own = [...new Set([...tokens(s.name), ...tokens(s.id)])].filter((w) => !STOP.has(w) && w.length > 1);
    const score = own.filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore > 0 && !tie ? best : null;
}

// Which option (size) they mean, by the words that set each option apart ("3", "suv", "1 system").
export function pickSize(service, text) {
  const options = (service.options || []).map((o) => o.size).filter(Boolean);
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const words = new Set(tokens(text));
  const toks = options.map((o) => tokens(o.replace(/\+/g, '')).filter((w) => !STOP.has(w)));
  const shared = toks[0].filter((w) => toks.every((ts) => ts.includes(w)));
  const own = toks.map((ts) => ts.filter((w) => !shared.includes(w)));
  // Numbers first ("3", "2 systems"), then words ("suv", "truck").
  for (const numeric of [true, false]) {
    for (let i = 0; i < options.length; i++) {
      if (own[i].some((w) => /^\d/.test(w) === numeric && words.has(w))) return options[i];
    }
  }
  return null;
}

const slotHour = (label) => {
  const m = String(label).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 12;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h;
};
const inPart = (slot, when) => {
  if (!when) return true;
  const h = slotHour(slot.label);
  if (when.hour !== undefined) return h === when.hour;
  if (when.part === 'morning') return h < 12;
  if (when.part === 'afternoon') return h >= 12 && h < 17;
  return h >= 17;
};
const partWords = (when) => (when?.hour !== undefined ? `at ${((when.hour + 11) % 12) + 1}` : when?.part ? `in the ${when.part}` : '');
// "Friday morning", "Friday at 9", "Tomorrow afternoon".
const askedPhrase = (day, when) => {
  const d = dayWords(day);
  const w = when?.hour !== undefined ? `at ${((when.hour + 11) % 12) + 1}` : when?.part || '';
  const out = [d, w].filter(Boolean).join(' ');
  return out ? out[0].toUpperCase() + out.slice(1) : '';
};
// The label prefix ("Fri, Oct 30") of the nearest coming day with that weekday name, in the business's time zone.
function nearestDayPrefix(day, timeZone) {
  if (!day || !Object.values(DAYS).includes(day) || !timeZone) return null;
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400000);
    if (new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(d).toLowerCase() === day) {
      return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
    }
  }
  return null;
}
const dayWords = (day) => (day && day !== 'any' ? (day === 'weekend' ? 'this weekend' : day[0].toUpperCase() + day.slice(1)) : '');

// "Friday morning" means the nearest Friday. When that exact time is open it is the slot. When it is not (on a shared
// demo server someone may have just taken it), `nearest` is the closest open time: the same day first (closest hour),
// then the same part of the day on a later day, then the next open time at all. A booking is only a hold the human
// still approves in PayPal, so the assistant holds the nearest time and says so instead of stalling on a question.
const WANT_HOUR = { morning: 9, afternoon: 13, evening: 18 };
export function chooseSlot(slots, day, when, skip = null) {
  const open = slots.filter((x) => x.start !== skip);
  if (!open.length) return { slot: null, nearest: null, alternatives: [] };
  const specific = day && !['any', 'weekend'].includes(day);
  const firstDate = open[0].label.split(',').slice(0, 2).join(',');
  const pool = specific ? open.filter((x) => x.label.startsWith(firstDate)) : open;
  const slot = pool.find((x) => inPart(x, when)) || null;
  if (slot) return { slot, nearest: slot, alternatives: [] };
  const target = when?.hour ?? WANT_HOUR[when?.part] ?? 9;
  const sameDay = [...pool].sort((a, b) => Math.abs(slotHour(a.label) - target) - Math.abs(slotHour(b.label) - target));
  const later = open.filter((x) => !pool.includes(x) && inPart(x, when));
  const nearest = sameDay[0] || later[0] || open[0];
  return { slot: null, nearest, alternatives: [...pool.slice(0, 2), ...later.slice(0, 1)].slice(0, 3) };
}

function pickOffered(session, text) {
  if (!session.offered?.length) return null;
  const t = lower(text);
  const n = t.match(/\b([1-5])\b/) || t.match(/\b(first|second|third|fourth|fifth)\b/);
  if (n) {
    const idx = /\d/.test(n[1]) ? Number(n[1]) - 1 : ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(n[1]);
    if (session.offered[idx]) return session.offered[idx];
  }
  const day = parseDay(text);
  const when = parsePart(text);
  const match = session.offered.filter((s) => (!day || day === 'any' || lower(s.label).startsWith(day.slice(0, 3))) && inPart(s, when));
  if (match.length === 1 || (match.length && (day || when))) return match[0];
  if (/\b(yes|sure|ok|okay|fine|that works|sounds good|go ahead|book it)\b/.test(t)) return session.offered[0];
  return null;
}

// ---------- the scripted planner ----------
// Same tools, same order a model would use: info -> quote -> availability -> book. One short follow-up when
// something is missing; the session remembers what it has learned so far.
async function scriptedTurn(s, text, url, trace, headers) {
  const t = lower(text);
  const mcp = await connect(url, trace, headers);
  try {
    if (!s.info) s.info = await mcp.call('get_business_info', {});
    const biz = s.info;
    const f = s.facts;

    // Follow-ups about a booking that already exists. "Move it" means reschedule, not a move-out clean.
    const followUp = /\b(cancel|move|reschedule|change|switch|instead|status|paid|pay|confirmed|booked|approve|deposit|when is|what time)\b/.test(t);
    if (s.booking && (followUp || s.pending === 'move' || !pickService(biz.services, text))) {
      const keyed = { booking_id: s.booking.id, booking_key: s.booking.key };
      // "Pay the final bill and add a $20 tip": the business's pay_balance tool pays only inside the limit the
      // human pre-approved at the deposit; anything else comes back to the human as an approval.
      if ((/\b(pay|settle|cover)\b.*\b(bill|balance|rest|owe|final|remaining)\b|\btip\b|^\s*(please\s+)?pay (it|that|this)\b/.test(t)) && !/\b(did|have) i\b/.test(t)) {
        let tip = 0;
        const dollars = text.match(/\$\s?(\d+(?:\.\d+)?)\s*(?:tip)?/i) || text.match(/tip(?:\s+of)?\s+\$?(\d+(?:\.\d+)?)/i);
        const pct = text.match(/(\d{1,2})\s*%/);
        if (pct) {
          const st = await mcp.call('get_booking_status', keyed);
          tip = Math.round((st.due || 0) * Number(pct[1])) / 100;
        } else if (dollars && /tip/i.test(text)) tip = Number(dollars[1]);
        const r = await mcp.call('pay_balance', { ...keyed, ...(tip ? { tip } : {}) });
        const c = r.limit_check;
        if (r.payment_made) {
          return { reply: `Paid ${usd(r.amount)}${tip ? ` (${usd(r.amount - tip)} balance + ${usd(tip)} tip)` : ''} from your saved PayPal, inside the ${usd(c.limit)} limit you set at the deposit. No new approval needed. You're all paid up.${c.simulated ? ' (Demo: simulated, no PayPal call.)' : ''}`, approval: null, paid: true };
        }
        const approval = r.approval_url ? { url: r.approval_url, amount: r.amount || r.approval_amount, bookingId: r.booking_id, label: 'Final bill' } : null;
        const reply =
          r.reason === 'over_limit'
            ? `That's ${usd(r.amount)}, over the ${usd(c.limit)} limit you set (${usd(c.remaining_before)} left), so I didn't pay it. Approve it in PayPal if it looks right.`
            : r.reason === 'no_mandate'
              ? `You didn't give me a spending limit for this booking, so I can't pay the ${usd(r.amount)}. Approve it in PayPal.`
              : r.reason === 'job_not_done'
                ? `The business hasn't marked the job done yet, so there's no final bill. Once they do, I can pay it${s.booking.limit ? ` inside your ${usd(s.booking.limit)} limit` : ''}.`
                : r.message;
        return { reply, approval };
      }
      if (/\bcancel\b/.test(t)) {
        const r = await mcp.call('cancel_booking', keyed);
        s.booking = null;
        s.facts = {};
        return { reply: `${r.message} Want me to book something else?`, approval: null };
      }
      if (/\b(move|reschedule|change|switch|instead|different|another)\b/.test(t) || s.pending === 'move') {
        const day = parseDay(text);
        const when = parsePart(text);
        let slot = s.pending === 'move' ? pickOffered(s, text) : null;
        if (!slot) {
          const av = await mcp.call('check_availability', { day: day && day !== 'any' ? day : undefined, count: 8 });
          const pick = chooseSlot(av.slots, day, when, s.booking.slotStart);
          slot = pick.slot;
          if (!slot) {
            s.pending = 'move';
            s.offered = pick.alternatives;
            if (!s.offered.length) return { reply: `Nothing is open ${dayWords(day) || 'then'}. Try another day.`, approval: null };
            return { reply: `Nothing open ${dayWords(day) || 'then'} ${partWords(when)}. Closest: ${s.offered.map((x, i) => `${i + 1}) ${x.label}`).join('  ')}. Which one?`.replace(/\s+/g, ' '), approval: null };
          }
        }
        s.offered = null;
        const r = await mcp.call('reschedule_booking', { ...keyed, slot_start: slot.start });
        s.pending = null;
        s.booking.slotStart = r.slot_start;
        return { reply: `Moved. You're now down for ${r.appointment}. ${r.paid > 0 ? 'What you paid carried over.' : `The ${usd(r.approval_amount || r.deposit)} deposit still needs your approval in PayPal.`}`, approval: r.approval_url ? { url: r.approval_url, amount: r.approval_amount, bookingId: r.booking_id } : null };
      }
      const r = await mcp.call('get_booking_status', keyed);
      const line =
        r.status === 'held'
          ? `Still waiting on you: approve the ${usd(r.approval_amount)} deposit in PayPal and ${r.appointment} is locked in.`
          : r.status === 'confirmed'
            ? `You're confirmed for ${r.appointment}. ${r.deposit_held ? `Your ${usd(r.deposit_held)} deposit is held in PayPal, not charged until the job is done` : `Paid ${usd(r.paid)}`}, ${usd(r.due)} due after the job.${r.assistant_limit ? ` I can pay the final bill for you, up to ${usd(r.assistant_limit.remaining)}.` : ''}`
            : r.status === 'completed'
              ? `The job is done. The final bill is ${usd(r.due)}.${r.assistant_limit ? ` Say "pay it" and I'll pay it inside your ${usd(r.assistant_limit.limit)} limit.` : ' Approve it in PayPal.'}`
              : `Status: ${r.status_words}. Paid ${usd(r.paid)}, due ${usd(r.due)}.`;
      return { reply: line, approval: r.approval_url ? { url: r.approval_url, amount: r.approval_amount, bookingId: r.booking_id, ...(r.status === 'completed' ? { label: 'Final bill' } : {}) } : null };
    }

    // Learn what we can from this message.
    if (s.pending === 'budget' && /\b(yes|yeah|sure|ok|okay|fine|go ahead|book it|anyway|do it)\b/.test(t)) f.budget = null;
    else if (s.pending === 'budget' && /\b(no|nope|don'?t|stop|never ?mind|cancel)\b/.test(t)) {
      s.pending = null;
      s.facts = {};
      return { reply: 'No problem, nothing was booked. Tell me another service or a bigger budget and I will try again.', approval: null };
    }
    const svc = pickService(biz.services, text) || (biz.services.length === 1 && /\b(book|schedule|appointment|open|time|slot|come|visit)\b/.test(t) ? biz.services[0] : null);
    if (svc) {
      if (f.service && f.service !== svc.id) f.size = null;
      f.service = svc.id;
    }
    const service = biz.services.find((x) => x.id === f.service) || null;
    if (service) f.size = f.size || pickSize(service, text);
    const day = parseDay(text);
    if (day) f.day = day;
    const when = parsePart(text);
    if (when) f.when = when;
    const budget = parseBudget(text);
    if (budget) f.budget = budget;
    const name = parseName(text) || (s.pending === 'name' ? bareName(text) : null);
    if (name) f.name = name[0].toUpperCase() + name.slice(1);
    const phone = text.match(/(\+?1[ -.]?)?\(?\d{3}\)?[ -.]?\d{3}[ -.]?\d{4}/);
    if (phone) f.phone = phone[0];
    if (s.pending === 'slot') {
      const chosen = pickOffered(s, text);
      if (chosen) f.slot = chosen;
    }

    // Ask for the one thing we still need.
    if (!service) {
      s.pending = 'service';
      return { reply: `I can book ${biz.name} for you. Which service: ${biz.services.map((x) => x.name.toLowerCase()).join(', ')}?`, approval: null };
    }
    const needsSize = service.options.length > 1;
    if (needsSize && !f.size) {
      s.pending = 'size';
      return { reply: `${service.name}, got it. ${service.size_question || 'Which option?'} (${service.options.map((o) => o.size).join(', ')})`, approval: null };
    }
    const q = await mcp.call('get_quote', { service: service.id, ...(f.size ? { size: f.size } : {}) });
    const what = `${q.service}${q.size ? ` for ${q.size}` : ''}`;
    if (f.budget && q.price > f.budget) {
      s.pending = 'budget';
      const cheaper = biz.services.flatMap((x) => x.options.filter((o) => o.price <= f.budget && o.price > 0).map((o) => `${x.name}${o.size ? ` (${o.size})` : ''} ${usd(o.price)}`)).slice(0, 3);
      return { reply: `${what} is ${usd(q.price)}, over your ${usd(f.budget)} budget, so I did not book it. ${cheaper.length ? `Under budget: ${cheaper.join(', ')}. ` : ''}Say "book it anyway" or pick one of those.`, approval: null };
    }
    if (!f.name) {
      s.pending = 'name';
      return { reply: `${what} is ${usd(q.price)} with a ${usd(q.deposit_due_now)} deposit. What name should I book it under?`, approval: null };
    }
    let slot = f.slot || null;
    let swapped = null; // set when the exact time asked for was taken and the nearest open one was held instead
    let closed = false; // the day asked for had no open times at all (closed that day, or already full)
    const tried = new Set();
    // retry > 0: a time just got taken; pick at random among the few nearest open times.
    const findSlot = async (retry = 0) => {
      const av = await mcp.call('check_availability', { day: f.day && f.day !== 'any' ? f.day : undefined, count: 8 });
      const open = av.slots.filter((x) => !tried.has(x.start));
      if (!retry && f.day && f.day !== 'any' && !av.slots.length) closed = true;
      const pick = chooseSlot(open, f.day, f.when);
      if (pick.slot && !retry) return pick.slot;
      let near = retry ? null : pick.nearest;
      if (retry) {
        const pool = (open.length ? open : (await mcp.call('check_availability', { count: 8 })).slots.filter((x) => !tried.has(x.start))).slice(0, 3);
        near = pool[Math.floor(Math.random() * pool.length)] || null;
      }
      if (!near) near = (await mcp.call('check_availability', { count: 6 })).slots.find((x) => !tried.has(x.start)) || null;
      if (near) swapped = near;
      return near;
    };
    if (!slot) slot = await findSlot();
    if (!slot) return { reply: `${biz.name} has nothing open in the next three weeks. Want me to try another business?`, approval: null };
    s.offered = null;
    const bookArgs = (start) => ({
      service: service.id,
      ...(f.size ? { size: f.size } : {}),
      slot_start: start,
      customer_name: f.name,
      ...(f.phone ? { customer_phone: f.phone } : {}),
      ...(f.budget ? { max_total: f.budget } : {}),
      agent_name: agentName(),
    });
    // Someone else can take a time between the availability check and the booking (many visitors try the demo at
    // once): try the next open time, a few times, picking among the nearest ones so racing visitors spread out.
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await mcp.call('book_appointment', bookArgs(slot.start));
        break;
      } catch (err) {
        if (!/no longer open/i.test(err.message) || attempt >= 7) throw err;
        tried.add(slot.start);
        slot = await findSlot(attempt + 1);
        if (!slot) return { reply: `${biz.name} has nothing open in the next three weeks. Want me to try another business?`, approval: null };
      }
    }
    if (!r.booked) {
      s.pending = 'budget';
      return { reply: r.message, approval: null };
    }
    s.pending = null;
    s.offered = null;
    s.facts = { name: f.name, phone: f.phone };
    s.booking = { id: r.booking_id, key: r.booking_key, slotStart: r.slot_start, approvalUrl: r.approval_url, amount: r.approval_amount };
    if (!r.human_approval_required) return { reply: `Booked: ${what} with ${biz.name} on ${r.appointment}. No deposit needed, so you're confirmed.`, approval: null };
    // Say plainly when the time held is not the one asked for: the nearest weekday was full, or that time was taken.
    const nearest = nearestDayPrefix(f.day, biz.timezone);
    const dayFull = nearest && !String(r.appointment).startsWith(nearest);
    const asked = askedPhrase(f.day, f.when);
    const reply = [
      dayFull ? `This ${dayWords(f.day)} is fully booked, so I held the closest open time instead.` : swapped ? `${closed ? `Nothing was open ${dayWords(f.day).toLowerCase() || 'then'}` : asked ? `${asked} was taken` : 'That time was taken'}, so I held the closest open time instead.` : '',
      `Done. I held ${what} with ${biz.name} for ${r.appointment}.`,
      `Total ${usd(r.total)}: a ${usd(r.deposit)} deposit now and ${usd(r.total - r.deposit)} after the job.`,
      `I can't pay the deposit for you. Approve the ${usd(r.deposit)} in PayPal (card, Venmo or Pay Later work too) and the time is yours. Free to cancel or move until ${r.free_cancel_until}.`,
      swapped || dayFull ? 'Want a different time? Say "move it to" and the day.' : '',
    ].filter(Boolean).join(' ');
    return { reply, approval: { url: r.approval_url, amount: r.approval_amount, bookingId: r.booking_id } };
  } finally {
    await mcp.close();
  }
}

// ---------- the model planner (needs an AI key) ----------
async function modelTurn(s, text, url, trace, model, headers) {
  const mcp = await createMCPClient({ transport: { type: 'http', url, headers } });
  try {
    const tools = await mcp.tools();
    const messages = s.history.slice(-20).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
    messages.push({ role: 'user', content: text });
    const result = await generateText({
      model,
      system: `You are the customer's personal AI assistant (your name is ${agentName()}). The customer wants you to book a local service business for them. The business's booking system is available as tools over MCP.
How to work: call get_business_info first, then get_quote, then check_availability, then book_appointment with the exact slot_start. Pass the customer's budget as max_total if they gave one, and agent_name "${agentName()}". Use their name as customer_name; ask for it if you do not have it. Ask one short question when something is missing. If the exact time they asked for is taken, book the closest open time within their budget and tell them which time you held (they can move it); do not stall on a question.
Money: you cannot pay the deposit. When book_appointment returns approval_url, tell the customer the total, the deposit due now, that only they can approve it in PayPal (card, Venmo and Pay Later work too, no account needed), and give the link. Never say the appointment is confirmed until get_booking_status says confirmed.
After the job, if they ask you to pay the final bill (and maybe a tip), call pay_balance. It pays only inside the spending limit they pre-approved at the deposit; if it returns payment_made false, tell them why (over the limit, no limit, job not done) and give approval_url.
Style: 1 to 3 short plain sentences, no markdown, no lists.`,
      messages,
      tools,
      stopWhen: stepCountIs(8),
      temperature: 0.2,
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    let approval = null;
    for (const step of result.steps) {
      for (const tr of step.toolResults || []) {
        const out = tr.output || {};
        let data = out.structuredContent;
        if (data === undefined) {
          try {
            data = JSON.parse(out.content?.find((c) => c.type === 'text')?.text || '');
          } catch {
            data = out;
          }
        }
        trace.push({ tool: tr.toolName, args: tr.input || {}, result: data, error: Boolean(out.isError) });
        if (tr.toolName === 'book_appointment' && data?.approval_url) {
          approval = { url: data.approval_url, amount: data.approval_amount, bookingId: data.booking_id };
          s.booking = { id: data.booking_id, key: data.booking_key, slotStart: data.slot_start, approvalUrl: data.approval_url, amount: data.approval_amount };
        }
        if ((tr.toolName === 'get_booking_status' || tr.toolName === 'reschedule_booking') && data?.approval_url) approval = { url: data.approval_url, amount: data.approval_amount, bookingId: data.booking_id };
        if (tr.toolName === 'pay_balance') approval = data?.payment_made ? null : data?.approval_url ? { url: data.approval_url, amount: data.amount || data.approval_amount, bookingId: data.booking_id, label: 'Final bill' } : approval;
      }
    }
    return { reply: (result.text || '').trim() || 'Done.', approval };
  } finally {
    await mcp.close();
  }
}

// ---------- one turn ----------
// What the human sees when the booking system errors: its plain-words message, never raw JSON-RPC or HTTP noise.
export function friendlyError(message) {
  const m = String(message || '').replace(/^MCP error -?\d+:\s*/i, '').trim();
  if (/timed? ?out|timeout|aborted|AbortError/i.test(m)) {
    return "The business's booking system took too long to answer, so nothing was booked or charged. Please try again in a moment.";
  }
  if (!m || /jsonrpc|^\s*[{[]|HTTP error|Error POSTing|status code|ECONN|fetch failed|429|Too many requests|Internal server error|-32\d{3}/i.test(m)) {
    return "The business's booking system is busy right now, so nothing was booked or charged. Please try again in a minute.";
  }
  return `The business's booking system said: ${m}`;
}

export async function assistantTurn({ sessionId, text, bizId, base, loopback = null, visitorId = null }) {
  const s = session(sessionId, bizId);
  // The endpoint the page shows is the public one; the calls themselves go over loopback when the server knows its
  // own port (no DNS, TLS or proxy hop on the way back to itself), with the public address passed along for links.
  const url = `${base}/mcp/${s.bizId}`;
  const callUrl = loopback ? `${loopback}/mcp/${s.bizId}` : url;
  // This demo assistant runs inside the server: its MCP calls carry the internal secret (no shared public rate
  // limit) and the visitor's id (so their Reset demo clears what they booked). See visitor.js.
  const headers = internalHeaders(visitorId, { publicBase: loopback ? base : '' });
  // Each call lands in the session's trace as it happens, so the page can show it while the turn is still running.
  const trace = [];
  const push = trace.push.bind(trace);
  trace.push = (...entries) => {
    s.trace.push(...entries);
    return push(...entries);
  };
  s.history.push({ role: 'user', text, at: new Date().toISOString() });
  const m = getModel();
  let out;
  try {
    out = m ? await modelTurn(s, text, callUrl, trace, m.model, headers) : await scriptedTurn(s, text, callUrl, trace, headers);
  } catch (err) {
    if (m) {
      console.error(`Assistant model failed (${m.name}): ${err.message}. Using the scripted planner.`);
      try {
        out = await scriptedTurn(s, text, callUrl, trace, headers);
      } catch (err2) {
        out = { reply: friendlyError(err2.message), approval: null };
      }
    } else out = { reply: friendlyError(err.message), approval: null };
  }
  s.history.push({ role: 'assistant', text: out.reply, at: new Date().toISOString(), approval: out.approval || null });
  return { reply: out.reply, trace: [...trace], traceTotal: s.trace.length, approval: out.approval || null, endpoint: url, assistant: agentName(), mode: m ? 'model' : 'scripted' };
}
