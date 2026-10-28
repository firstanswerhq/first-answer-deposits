// Busy times from a private iCal link (Google, Apple or Outlook), refreshed every 10 minutes,
// so the AI never offers a time the owner is already busy.
import { safeFetch } from './safe-fetch.js';

const busyCache = new Map();
let fetchImpl = (url, opts) => safeFetch(url, opts); // https only, never internal addresses
export function _setFetch(fn) {
  fetchImpl = fn;
  busyCache.clear();
}

export function parseIcs(text) {
  const out = [];
  const blocks = String(text || '').replace(/\r?\n[ \t]/g, '').split('BEGIN:VEVENT').slice(1);
  for (const blk of blocks) {
    const get = (k) => {
      const m = blk.match(new RegExp(`^${k}[^:]*:(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    const start = toIso(get('DTSTART'));
    const end = toIso(get('DTEND')) || (start ? new Date(Date.parse(start) + 3600000).toISOString() : null);
    if (start && end && !/CANCELLED/.test(get('STATUS') || '')) out.push({ start, end, summary: get('SUMMARY') || 'Busy' });
  }
  return out;
}

function toIso(v) {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  // Floating or local times are treated as UTC-ish wall time; good enough to block the slot.
  return new Date(z || !h ? Date.UTC(y, mo - 1, d, h, mi, s) : Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
}

export async function busyTimes(business) {
  const url = business.busyCalendarUrl;
  if (!url) return [];
  const c = busyCache.get(business.id);
  if (c && Date.now() - c.at < 10 * 60000) return c.items;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(8000) });
    const items = parseIcs(await res.text());
    busyCache.set(business.id, { at: Date.now(), items });
    return items;
  } catch (err) {
    console.error('busy calendar', err.message);
    return c?.items || [];
  }
}

export function isBusy(items, slotStartIso, minutes) {
  const s = Date.parse(slotStartIso);
  const e = s + minutes * 60000;
  return items.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);
}


// Sync view for the slot finder: returns what is cached and refreshes in the background when stale.
export function cachedBusy(business) {
  if (!business?.busyCalendarUrl) return [];
  const c = busyCache.get(business.id);
  if (!c || Date.now() - c.at >= 10 * 60000) busyTimes(business).catch(() => {});
  return c?.items || [];
}
