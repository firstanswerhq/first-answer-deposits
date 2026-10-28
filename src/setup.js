// Setup by text: an owner answers a few plain questions and gets a working business profile
// (the same shape as the presets in business.js). No forms, no fields to figure out.
import { generateText } from 'ai';
import * as store from './store.js';
import { presets } from './business.js';
import { getModel } from './agent/model.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const cap = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const STEPS = [
  { id: 'name', ask: "Let's set you up. What's your business called?" },
  { id: 'trade', ask: 'What do you do, in a few words? (lawn care, plumbing, dog grooming, photography...)' },
  { id: 'city', ask: 'What city and state are you in?' },
  { id: 'hours', ask: 'What days do you work, and what start times can customers book? For example: Mon-Fri, 8am, 11am and 2pm.' },
  { id: 'services', ask: 'Now your services and prices, one per line. For example:\nMowing: small yard $45, large yard $65\nAeration: $120' },
  { id: 'deposit', ask: 'How much should a customer pay to hold a time? A flat amount like $50, or a percent like 25%. (Or say "no deposit".)' },
  { id: 'brand', ask: 'Your look, optional: paste a link to your logo image and a brand color like #2a9d8f (or a color name). Your customers see your logo and color on every page, not ours. Or say "skip".' },
  { id: 'payout', ask: 'Last one: which PayPal email should your money go to when a job is paid?' },
];

const COLOR_NAMES = { red: '#d7263d', orange: '#f26b1d', yellow: '#e0a800', gold: '#c9a227', green: '#1f9d55', teal: '#0e9f8f', blue: '#1d7bf2', navy: '#1b2a6b', purple: '#7c3aed', pink: '#e5489d', black: '#1a1a1a', gray: '#5b6270', grey: '#5b6270', brown: '#7b4b2a' };

// "logo: https://x/logo.png, color #2a9d8f" or "blue" or "skip" -> { color, logoUrl } (either may be empty).
export function parseBrand(text) {
  const t = String(text || '').trim();
  if (!t || /^(skip|no|none|later|nope)\b/i.test(t)) return { color: '', logoUrl: '' };
  const url = (t.match(/https?:\/\/\S+/i) || [''])[0].replace(/[),.;]+$/, '');
  let color = (t.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/i) || [''])[0].toLowerCase();
  if (!color) {
    const word = Object.keys(COLOR_NAMES).find((c) => new RegExp(`\\b${c}\\b`, 'i').test(t.replace(url, '')));
    if (word) color = COLOR_NAMES[word];
  }
  if (color.length === 4) color = `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  return { color, logoUrl: url };
}

export function parseHours(text) {
  const t = String(text || '').toLowerCase();
  let days = [];
  if (/every ?day|7 days|all week/.test(t)) days = [0, 1, 2, 3, 4, 5, 6];
  else if (/weekdays|mon(day)?\s*(-|to|through|thru)\s*fri/.test(t)) days = [1, 2, 3, 4, 5];
  else if (/mon(day)?\s*(-|to|through|thru)\s*sat/.test(t)) days = [1, 2, 3, 4, 5, 6];
  else {
    const range = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*(?:-|to|through|thru)\s*(sun|mon|tue|wed|thu|fri|sat)/);
    if (range) {
      let i = DAYS.indexOf(range[1]);
      const end = DAYS.indexOf(range[2]);
      for (let n = 0; n < 7; n++) {
        days.push(i);
        if (i === end) break;
        i = (i + 1) % 7;
      }
    } else {
      DAYS.forEach((d, i) => {
        if (new RegExp(`\\b${d}`).test(t)) days.push(i);
      });
      if (/weekends?/.test(t)) days.push(0, 6);
    }
  }
  days = [...new Set(days)].sort();
  const times = [];
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/g)) {
    let h = Number(m[1]);
    const min = m[2] || '00';
    const ap = (m[3] || '').replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6) h += 12; // "2" alone is almost always 2 pm for a service business
    if (h >= 5 && h <= 21) times.push(`${String(h).padStart(2, '0')}:${min}`);
  }
  return {
    openDays: days.length ? days : [1, 2, 3, 4, 5],
    slotTimes: times.length ? [...new Set(times)].sort() : ['09:00', '13:00'],
  };
}

export function parseServices(text) {
  const services = [];
  const lines = String(text || '')
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const [rawName, rest] = line.includes(':') ? [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)] : splitNamePrices(line);
    const name = cap(rawName.replace(/[-–]\s*$/, ''));
    if (!name) continue;
    const sizes = {};
    for (const m of rest.matchAll(/([A-Za-z0-9][A-Za-z0-9 \-\/+'’]*?)?\s*\$\s*(\d+(?:\.\d+)?)/g)) {
      const label = (m[1] || '').trim().replace(/^(and|or|,)\s+/i, '').replace(/\s*(for|at|is|-)$/i, '');
      sizes[label || 'standard'] = Number(m[2]);
    }
    if (!Object.keys(sizes).length) {
      const n = rest.match(/(\d+(?:\.\d+)?)/);
      if (n) sizes.standard = Number(n[1]);
    }
    if (!Object.keys(sizes).length) continue;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || `service${services.length + 1}`;
    services.push({ id: services.some((s) => s.id === id) ? `${id}_${services.length + 1}` : id, name, sizes });
  }
  return services;
}

// "Mowing small yard $45, large yard $65" has no colon: the name is everything before the first price label.
function splitNamePrices(line) {
  const i = line.search(/\$\s*\d/);
  if (i < 0) return [line, ''];
  const before = line.slice(0, i).trim();
  const words = before.split(/\s+/);
  if (words.length <= 2) return [before, line.slice(i)];
  // Keep the first one or two words as the service name, the rest is a size label.
  const nameWords = words.length > 3 ? 2 : 1;
  return [words.slice(0, nameWords).join(' '), line.slice(line.indexOf(words[nameWords]))];
}

export function parseDeposit(text) {
  const t = String(text || '').toLowerCase();
  if (/\bno\b|none|zero|skip/.test(t) && !/\d/.test(t)) return { type: 'flat', amount: 0 };
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*percent/);
  if (pct) return { type: 'percent', percent: Number(pct[1] || pct[2]), minimum: 20 };
  const amt = t.match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (amt) return { type: 'flat', amount: Number(amt[1]) };
  return null;
}

export function parseEmail(text) {
  const m = String(text || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].toLowerCase() : null;
}

// Turn one answer into profile fields. Returns { ok, patch, say } so the page can show a friendly reply.
export function applyAnswer(stepId, text, profile = {}) {
  const t = String(text || '').trim();
  switch (stepId) {
    case 'name':
      if (t.length < 2) return { ok: false, say: 'What should customers call your business?' };
      return { ok: true, patch: { name: cap(t.replace(/^(it's|its|we are|we're|called)\s+/i, '')) } };
    case 'trade':
      return { ok: true, patch: { trade: t.toLowerCase().replace(/^(we do|we're|we are|i do)\s+/i, '').replace(/\.$/, '') || 'services' } };
    case 'city':
      return { ok: true, patch: { city: cap(t.replace(/^(in|we're in|i'm in)\s+/i, '')) } };
    case 'hours': {
      const h = parseHours(t);
      return { ok: true, patch: h, say: `Got it: ${h.openDays.map((d) => cap(DAYS[d])).join(', ')} with start times ${h.slotTimes.map(prettyTime).join(', ')}.` };
    }
    case 'services': {
      const services = parseServices(t);
      if (!services.length) return { ok: false, say: 'I need at least one price. Try something like "Mowing: $45" on its own line.' };
      return { ok: true, patch: { services: [...(profile.services || []), ...services] }, say: `${services.length} service${services.length > 1 ? 's' : ''} added. Send more lines, or type "done".` };
    }
    case 'deposit': {
      const d = parseDeposit(t);
      if (!d) return { ok: false, say: 'Just a number works, like $50 or 25%.' };
      return { ok: true, patch: { deposit: d }, say: d.amount === 0 ? 'No deposit. Customers book free and pay after the job.' : d.type === 'percent' ? `${d.percent}% deposit, applied to the bill.` : `$${d.amount} deposit, applied to the bill.` };
    }
    case 'brand': {
      const b = parseBrand(t);
      const parts = [b.logoUrl ? 'logo saved' : '', b.color ? `color ${b.color}` : ''].filter(Boolean);
      return { ok: true, patch: { brand: b }, say: parts.length ? `Looks good: ${parts.join(', ')}. Your customers will see it on the booking and payment pages.` : 'No problem, you can add a logo and color later from the owner page.' };
    }
    case 'payout': {
      const e = parseEmail(t);
      if (!e) return { ok: false, say: "That doesn't look like an email. Which email is your PayPal under?" };
      return { ok: true, patch: { payoutEmail: e } };
    }
    default:
      return { ok: false, say: 'Sorry, I lost my place. Start over?' };
  }
}

function prettyTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${ap}`;
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'business';
}

// Plain text only: no tags, no control characters, one line, a sane length.
function plain(v, max) {
  return String(v ?? '')
    .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const positive = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : null;
};

// The profile comes from the browser (or from a model reading free text), so every field is checked here
// before it is saved. Throws a plain-words error the setup page can show.
export function cleanProfile(profile = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const name = plain(p.name, 80);
  if (name.length < 2) throw new Error('What should customers call your business?');
  if (!Array.isArray(p.services) || !p.services.length) throw new Error('A name and at least one service are needed.');
  if (p.services.length > 30) throw new Error('That is a lot of services. Keep it to 30 or fewer.');
  const services = [];
  for (const s of p.services) {
    const sName = plain(s?.name, 60);
    if (!sName) throw new Error('Every service needs a name.');
    const entries = Object.entries(s?.sizes && typeof s.sizes === 'object' ? s.sizes : {}).slice(0, 12);
    if (!entries.length) throw new Error(`"${sName}" needs a price.`);
    const sizes = {};
    for (const [label, price] of entries) {
      const n = positive(price, 100000);
      if (n === null) throw new Error(`Prices must be numbers above $0 (check "${sName}").`);
      sizes[plain(label, 40) || 'standard'] = n;
    }
    let id = String(s?.id || sName).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || `service${services.length + 1}`;
    if (services.some((x) => x.id === id)) id = `${id}_${services.length + 1}`;
    services.push({ id, name: sName, sizes });
  }
  let deposit = { type: 'flat', amount: 50 };
  if (p.deposit && typeof p.deposit === 'object') {
    if (p.deposit.type === 'percent') {
      const percent = positive(p.deposit.percent, 100);
      if (percent === null) throw new Error('A percent deposit must be above 0% and at most 100%.');
      const minimum = p.deposit.minimum === undefined ? 20 : Number(p.deposit.minimum);
      if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100000) throw new Error('The deposit minimum must be a number.');
      deposit = { type: 'percent', percent, minimum };
    } else {
      // 0 is allowed: "no deposit" is a real choice in setup.
      const amount = Number(p.deposit.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new Error('The deposit must be a number, like $50 or 25%.');
      deposit = { type: 'flat', amount: Math.round(amount * 100) / 100 };
    }
  }
  const email = p.payoutEmail ? parseEmail(String(p.payoutEmail).slice(0, 120)) : null;
  if (p.payoutEmail && !email) throw new Error("That payout email doesn't look right.");
  const days = Array.isArray(p.openDays) ? [...new Set(p.openDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  const times = Array.isArray(p.slotTimes) ? [...new Set(p.slotTimes.map(String).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, 12) : [];
  let timezone = 'America/Chicago';
  try {
    if (p.timezone) timezone = new Intl.DateTimeFormat('en-US', { timeZone: String(p.timezone) }).resolvedOptions().timeZone;
  } catch {
    // unknown zone: keep the default
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(p.brand?.color || '')) ? String(p.brand.color).toLowerCase() : '';
  const logo = String(p.brand?.logoUrl || '').trim();
  return {
    name,
    trade: plain(p.trade, 60) || 'services',
    city: plain(p.city, 80),
    timezone,
    openDays: days.length ? days : [1, 2, 3, 4, 5],
    slotTimes: times.length ? times : ['09:00', '13:00'],
    slotMinutes: positive(p.slotMinutes, 24 * 60) || 120,
    rebookDays: positive(p.rebookDays, 365) || 30,
    services,
    deposit,
    payoutEmail: email,
    brand: { color, logoUrl: /^https?:\/\/[^\s"'<>]+$/i.test(logo) ? logo.slice(0, 500) : '' },
  };
}

// Build the full profile and save it. Missing pieces get sensible defaults so the business works right away.
export function createBusiness(raw) {
  const profile = cleanProfile(raw);
  let id = slug(profile.name);
  if (presets[id] || store.getBusiness(id)) id = `${id}-${store.newId('').slice(1, 5)}`;
  const services = profile.services;
  const multi = services.some((s) => Object.keys(s.sizes).length > 1);
  const labels = [...new Set(services.flatMap((s) => Object.keys(s.sizes)).filter((k) => k !== 'standard'))];
  const business = {
    id,
    custom: true,
    name: profile.name,
    trade: profile.trade || 'services',
    city: profile.city || '',
    timezone: profile.timezone || 'America/Chicago',
    openDays: profile.openDays || [1, 2, 3, 4, 5],
    slotTimes: profile.slotTimes || ['09:00', '13:00'],
    slotMinutes: profile.slotMinutes || 120,
    deposit: profile.deposit || { type: 'flat', amount: 50 },
    cancellation: 'The deposit is fully refundable up to 24 hours before the appointment.',
    services,
    sizeQuestion: multi ? `Which option fits: ${labels.slice(0, 6).join(', ')}?` : '',
    rebookDays: profile.rebookDays || 30,
    plan: null,
    descriptor: profile.name.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, 22),
    payoutEmail: profile.payoutEmail || null,
    brand: { color: profile.brand?.color || '', logoUrl: profile.brand?.logoUrl || '' },
    createdAt: new Date().toISOString(),
  };
  store.saveBusiness(business);
  store.logActivity(`${business.name} is set up and taking bookings.`, { kind: 'setup', presetId: id });
  return business;
}

// With an AI key, one paragraph is enough: the model fills the whole profile from free text.
export async function profileFromText(text) {
  const m = getModel();
  if (!m) return null;
  const { text: out } = await generateText({
    model: m.model,
    temperature: 0,
    maxOutputTokens: 1200,
    system:
      'You turn a small business owner\'s description into JSON for a booking system. Reply with JSON only, no prose. Shape: {"name":string,"trade":string,"city":string,"openDays":[0-6 numbers, 0=Sunday],"slotTimes":["HH:MM" 24h],"services":[{"id":snake_case,"name":string,"sizes":{"label or standard":number}}],"deposit":{"type":"flat","amount":number}|{"type":"percent","percent":number,"minimum":number},"payoutEmail":string|null}. Only use prices the owner stated. Unknown fields: use sensible defaults (Mon-Fri, 09:00 and 13:00, $50 flat deposit).',
    prompt: text,
  });
  const json = out.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (!p.name || !Array.isArray(p.services) || !p.services.length) return null;
    return p;
  } catch {
    return null;
  }
}
