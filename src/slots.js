// Open appointment slots in the business's own time zone, minus anything already booked.

function tzOffsetMinutes(ts, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - ts) / 60000);
}

// "2026-10-30" + "09:00" in America/Chicago -> Date (UTC instant)
export function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let utc = naive;
  for (let i = 0; i < 3; i++) utc = naive - tzOffsetMinutes(utc, timeZone) * 60000;
  return new Date(utc);
}

export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function formatSlot(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

const HOLDING = new Set(['held', 'confirmed', 'completed', 'paid_in_full', 'needs_rebook']);

export function openSlots(business, bookings = [], { days = 7, now = new Date(), leadHours = 2, limit = 12, busy = [] } = {}) {
  const minutes = business.slotMinutes || 120;
  const isBusy = (iso) => {
    const s = Date.parse(iso);
    const e = s + minutes * 60000;
    return busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);
  };
  const taken = new Set(
    bookings.filter((b) => b.presetId === business.id && HOLDING.has(b.status)).map((b) => b.slotStart),
  );
  const earliest = now.getTime() + leadHours * 3600 * 1000;
  const today = localDate(now, business.timezone);
  const out = [];
  for (let i = 0; i < days && out.length < limit; i++) {
    const date = addDays(today, i);
    if (!business.openDays.includes(dayOfWeek(date))) continue;
    for (const time of business.slotTimes) {
      const start = zonedToUtc(date, time, business.timezone);
      if (start.getTime() < earliest) continue;
      const iso = start.toISOString();
      if (taken.has(iso) || (busy.length && isBusy(iso))) continue;
      out.push({ start: iso, label: formatSlot(iso, business.timezone) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function isSlotOpen(business, bookings, iso, opts = {}) {
  return openSlots(business, bookings, { ...opts, limit: 500, days: 21 }).some((s) => s.start === iso);
}
