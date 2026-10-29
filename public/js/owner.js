import { api, money, linkify, listen, $, escapeHtml, clock, ask, toast } from './common.js';

const code = new URLSearchParams(location.search).get('code') || '';
// Owner keys for businesses set up at /setup (?key= in the owner link). Kept in this browser, then taken out of the
// address bar so it isn't shared by accident. Demo businesses need no key.
const ownerKeys = (() => {
  let keys = {};
  try {
    keys = JSON.parse(localStorage.getItem('fad-owner-keys') || '{}') || {};
  } catch {}
  const q = new URLSearchParams(location.search);
  if (q.get('key') && q.get('biz')) {
    keys[q.get('biz')] = q.get('key');
    try {
      localStorage.setItem('fad-owner-keys', JSON.stringify(keys));
    } catch {}
    q.delete('key');
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  }
  return Object.values(keys).filter(Boolean).slice(0, 10);
})();
const baseHdr = { ...(code ? { 'x-owner-passcode': code } : {}), ...(ownerKeys.length ? { 'x-owner-key': ownerKeys.join(',') } : {}) };
// The business this page shows. It is sent with every request (x-biz), so picking one in the dropdown changes
// only this browser's page, never anyone else's. /owner?biz=<id> (the owner link from setup) opens that one;
// otherwise the last one picked in this browser, else the server's default demo business.
let biz = (() => {
  const q = new URLSearchParams(location.search).get('biz');
  if (q) return q;
  try {
    return localStorage.getItem('fad-owner-biz') || '';
  } catch {
    return '';
  }
})();
function setBiz(id) {
  biz = id || '';
  try {
    localStorage.setItem('fad-owner-biz', biz);
  } catch {}
  const q = new URLSearchParams(location.search);
  if (biz) q.set('biz', biz);
  else q.delete('biz');
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
}
const hdr = () => ({ ...baseHdr, ...(biz ? { 'x-biz': biz } : {}) });
let seenOwner = 0;
let busy = false;
let refreshTimer = null;
let lastState = null;

const ACTIONS = {
  held: [['remind', 'Remind'], ['release', 'Release']],
  confirmed: [['done', 'Job done'], ['refund', 'Refund'], ['cancel', "Can't make it"]],
  completed: [['remind', 'Remind'], ['cash', 'Paid cash']],
  needs_rebook: [['refund', 'Refund']],
  paid_in_full: [['refund', 'Refund']],
};

function kpis(s) {
  const tiles = [
    ['New leads', s.leads],
    ['Avg first reply', s.avgFirstReplySec === null ? '—' : s.avgFirstReplySec < 1 ? '&lt;1s' : `${s.avgFirstReplySec}s`],
    ['Deposits waiting', s.held],
    ['Confirmed', s.confirmed],
    ['Money in (30 days)', `${money(s.money.gross)}${s.money.onHold ? `<div class="small muted" style="font-size:12px;font-weight:600">+ ${money(s.money.onHold)} held in PayPal</div>` : ''}`],
    ['Still owed', money(s.money.stillOwed)],
  ];
  $('#kpis').innerHTML = tiles.map(([l, v]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
}

// Closed bookings owe nothing, whatever the bill said before.
const CLOSED = ['canceled', 'refunded', 'no_show'];
// A refund only makes sense when money (or a tip) is still in: no Refund button on a $0 booking.
const refundable = (b) => b.totals.paid > 0 || b.totals.tips > 0;

function bookings(list) {
  if (!list.length) {
    $('#bookings').innerHTML = '<tr><td class="muted">No bookings yet. Open the customer\'s phone and text the business.</td></tr>';
    return;
  }
  $('#bookings').innerHTML =
    '<tr><th>Customer</th><th>Appointment</th><th>Status</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Owed</th><th></th></tr>' +
    list
      .map((b) => {
        const demoDispute = lastState?.health.paypal === 'demo mode' && refundable(b) && !(b.disputes || []).length ? [['demo-dispute', 'Test a dispute']] : [];
        const acts = [...(ACTIONS[b.status] || []), ...demoDispute].filter(([a]) => a !== 'refund' || refundable(b)).map(([a, label]) => `<button class="btn secondary small" data-act="${a}" data-id="${b.id}">${label}</button>`).join('');
        const limit = b.assistantLimit && ['active', 'used'].includes(b.assistantLimit.status) ? `<div class="small" style="color:#1f7a45">${escapeHtml(b.bookedBy || 'Assistant')} may pay up to ${money(b.assistantLimit.limit)}${b.assistantLimit.spent ? ` (${money(b.assistantLimit.spent)} paid)` : ''}</div>` : '';
        const dispute = (b.disputes || []).length ? `<div class="small" style="color:#9a5b00">Dispute: ${escapeHtml(b.disputes.at(-1).status.replace(/_/g, ' '))}</div>` : '';
        return `<tr><td><strong>${escapeHtml(b.customerName)}</strong><div class="small muted">${escapeHtml(b.title || b.service)}</div>${limit}${dispute}</td>
          <td>${escapeHtml(b.appointment)}</td>
          <td><span class="status ${b.status}">${escapeHtml(b.statusWords)}</span></td>
          <td class="num">${money(b.totals.total)}</td><td class="num">${money(b.totals.paid)}${b.totals.tips ? `<div class="small muted">+${money(b.totals.tips)} tip</div>` : ''}${b.totals.refunded || b.totals.tipsRefunded ? `<div class="small muted">${money(b.totals.refunded + b.totals.tipsRefunded)} refunded</div>` : ''}</td><td class="num">${CLOSED.includes(b.status) ? '<span class="muted" title="Closed: nothing owed">—</span>' : b.status === 'held' ? `${money(b.owedNow)}<div class="small muted">deposit now</div>` : money(b.totals.due)}${b.hold ? `<div class="small muted">${escapeHtml(b.hold)}</div>` : ''}</td>
          <td><div class="actions">${acts}<a class="btn ghost small" href="/evidence/${encodeURIComponent(b.id)}${code ? `?code=${encodeURIComponent(code)}` : ''}" target="_blank" title="Everything about this booking in one file">Record</a></div></td></tr>`;
      })
      .join('');
}

function feed(items) {
  $('#feed').innerHTML =
    items
      .map((a) => {
        const open = a.kind === 'lead_in' && a.leadId ? ` <a href="/text?biz=${encodeURIComponent(a.presetId || lastState?.business.id || '')}&lead=${encodeURIComponent(a.leadId)}" target="_blank">Open the thread</a>` : '';
        return `<li><time>${clock(a.at)}</time>${escapeHtml(a.text)}${open}</li>`;
      })
      .join('') || '<li class="muted">Nothing yet.</li>';
}

function ownerThread(msgs) {
  const thread = $('#thread');
  if (seenOwner === 0) thread.innerHTML = '<div class="stamp">Ask about money, bookings or customers</div>';
  for (const m of msgs.slice(seenOwner)) {
    const div = document.createElement('div');
    div.className = `bubble ${m.role === 'owner' ? 'me' : 'them'}`;
    div.innerHTML = linkify(m.text);
    thread.appendChild(div);
  }
  seenOwner = msgs.length;
  thread.scrollTop = thread.scrollHeight;
}

async function refresh() {
  const s = await api('/api/owner/state', { headers: hdr() });
  lastState = s;
  // Asked for a business this browser can't open (no owner key): the server showed the demo one instead.
  if (biz && s.business.id !== biz) {
    if (s.presets.some((p) => p.id === biz)) toast('That business opens with its owner link. Showing the demo business.', 'bad');
    setBiz(s.business.id);
  }
  $('#biz').innerHTML = s.presets.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === s.business.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  // Starting over is off on the hosted demo unless the host turns it on: hide the button when it would only fail.
  $('#reset').style.display = s.resetAllowed ? '' : 'none';
  $('#pp-badge').textContent = `PayPal: ${s.health.paypal}`;
  $('#ai-badge').textContent = `AI: ${s.health.ai}`;
  kpis(s.summary);
  bookings(s.bookings);
  feed(s.activity);
  if (!busy) ownerThread(s.ownerThread);
  $('#needs').innerHTML =
    s.leads
      .filter((l) => l.needsOwner)
      .map((l) => `<li>${escapeHtml(l.name || 'A customer')}: ${escapeHtml(l.lastMessage?.text?.slice(0, 80) || '')}</li>`)
      .join('') || '<li class="muted">All handled by the AI.</li>';
  $('#waitlist').innerHTML = s.waitlist.map((w) => `<li>${escapeHtml(w.name)} <span class="muted">${escapeHtml(w.status)}${w.note ? ` · ${escapeHtml(w.note)}` : ''}</span></li>`).join('') || '<li class="muted">Nobody waiting.</li>';
}

async function connections() {
  const c = await api('/api/owner/connections', { headers: hdr() });
  $('#c-leadin').textContent = c.leadInUrl;
  $('#c-cal').textContent = c.calendarUrl;
  $('#c-mcp').textContent = c.mcpUrl;
  $('#c-busy').value = c.busyCalendarUrl;
  $('#c-webhook').value = c.webhookUrl;
  $('#c-payout').value = c.payoutEmail;
  $('#c-logo').value = c.brand.logoUrl || '';
  $('#c-color').value = c.brand.color || '#4f5bff';
  $('#c-color-hex').textContent = c.brand.color || 'default';
  const pv = $('#c-preview');
  pv.textContent = c.business.name[0];
  pv.style.background = c.brand.color || '';
  if (c.brand.logoUrl) pv.innerHTML = `<img src="${escapeHtml(c.brand.logoUrl)}" alt="" referrerpolicy="no-referrer" />`;
  const ro = !c.business.custom || c.locked;
  for (const id of ['c-busy', 'c-webhook', 'c-payout', 'c-logo', 'c-color']) $(`#${id}`).disabled = ro;
  $('#c-save').disabled = ro;
  $('#c-save-brand').disabled = ro;
  $('#c-note').textContent = !c.business.custom
    ? 'Demo businesses are read-only. Set up your own at /setup to connect apps.'
    : c.locked
      ? 'This business belongs to its owner. Open the owner link from setup to change it.'
      : c.webhookSecret
        ? `Webhook signing secret: ${c.webhookSecret} (shown in full once, when the webhook address is saved)`
        : '';
}
const copy = (id) => async () => {
  try {
    await navigator.clipboard.writeText($(id).textContent);
    toast('Copied.');
  } catch {
    toast('Select the address and copy it.', 'bad');
  }
};
$('#c-copy-leadin').addEventListener('click', copy('#c-leadin'));
$('#c-copy-cal').addEventListener('click', copy('#c-cal'));
$('#c-copy-mcp').addEventListener('click', copy('#c-mcp'));
$('#c-test-lead').addEventListener('click', async () => {
  $('#c-test-lead').disabled = true;
  try {
    const r = await fetch($('#c-leadin').textContent + '?source=test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Dana Whitfield', phone: '615-555-0142', message: 'Hi! Do you have anything this week?' }) }).then((x) => x.json());
    toast(r.ok ? `Test lead answered in ${r.seconds}s. It's in the activity feed.` : r.error || 'Could not send', r.ok ? '' : 'bad');
  } finally {
    $('#c-test-lead').disabled = false;
    refresh();
  }
});
async function saveConnections() {
  try {
    const r = await api('/api/owner/connections', {
      method: 'POST',
      headers: hdr(),
      body: { busyCalendarUrl: $('#c-busy').value, webhookUrl: $('#c-webhook').value, payoutEmail: $('#c-payout').value, logoUrl: $('#c-logo').value, brandColor: $('#c-color').value },
    });
    toast('Saved.');
    await connections();
    if (r.webhookSecret) $('#c-note').textContent = `Webhook signing secret: ${r.webhookSecret}. Copy it now: it is only shown this once.`;
  } catch (err) {
    toast(err.message, 'bad');
  }
}
$('#c-save').addEventListener('click', saveConnections);
$('#c-save-brand').addEventListener('click', saveConnections);
$('#c-color').addEventListener('input', () => { $('#c-color-hex').textContent = $('#c-color').value; });

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

async function text(q) {
  q = q.trim();
  if (!q) return;
  busy = true;
  const thread = $('#thread');
  const me = document.createElement('div');
  me.className = 'bubble me';
  me.textContent = q;
  thread.appendChild(me);
  const t = document.createElement('div');
  t.className = 'typing';
  t.innerHTML = '<span></span><span></span><span></span>';
  thread.appendChild(t);
  thread.scrollTop = thread.scrollHeight;
  try {
    await api('/api/owner/text', { method: 'POST', body: { text: q }, headers: hdr() });
  } catch (err) {
    const e = document.createElement('div');
    e.className = 'bubble them';
    e.textContent = err.message;
    thread.appendChild(e);
  }
  t.remove();
  me.remove();
  busy = false;
  await refresh();
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msg').value;
  $('#msg').value = '';
  text(v);
});
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]');
  if (b) text(b.dataset.q);
});
$('#bookings').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  const bk = lastState?.bookings.find((x) => x.id === id);
  const name = bk?.customerName || 'this customer';
  const body = {};
  if (act === 'cash') {
    const amt = await ask({
      title: 'Record a cash or check payment',
      text: `How much did ${name} pay outside PayPal? Any open payment link is turned off so nobody gets chased twice.`,
      input: { prefix: '$', inputmode: 'decimal', value: bk ? bk.totals.due : '' },
      ok: 'Record it',
    });
    if (!amt) return;
    body.amount = Number(String(amt).replace(/[^0-9.]/g, ''));
    if (!body.amount) return toast('Enter an amount, like 210.', 'bad');
  }
  if (act === 'refund') {
    const okRefund = await ask({
      title: `Refund ${name}?`,
      text: bk && bk.totals.onHold > 0 && bk.totals.onHold + 0.001 >= bk.totals.paid
        ? `${money(bk.totals.onHold)} is a deposit hold in PayPal, not charged yet. Refunding releases the hold, so ${name} is never charged, and they get a text.`
        : bk && bk.totals.tips > 0
        ? `Full refund: the ${money(bk.totals.paid)} they paid plus the ${money(bk.totals.tips)} tip (${money(bk.totals.paid + bk.totals.tips)} in all) goes back through PayPal to the account they paid with, and they get a text with the reference number.`
        : `${money(bk ? bk.totals.paid : 0)} goes back through PayPal to the account they paid with, and they get a text with the reference number.`,
      ok: 'Refund',
      danger: true,
    });
    if (!okRefund) return;
  }
  if (act === 'cancel') {
    const reason = await ask({
      title: `Cancel ${name}'s appointment?`,
      text: `We'll text ${name} three new times or a full refund, their choice. They're never charged for your cancellation.`,
      input: { placeholder: 'Reason (optional), like "truck broke down"', optional: true },
      ok: 'Cancel and text them',
      danger: true,
    });
    if (reason === null) return;
    body.reason = reason;
  }
  if (act === 'demo-dispute') {
    const go = await ask({ title: `Test a dispute on ${name}'s payment?`, text: 'Plays a PayPal dispute on this demo booking so you can watch the AI send the evidence file. Demo only: no PayPal call.', ok: 'Open a test dispute' });
    if (!go) return;
  }
  b.disabled = true;
  try {
    await api(`/api/owner/bookings/${id}/${act}`, { method: 'POST', body, headers: hdr() });
    toast({ remind: `Reminder sent to ${name}.`, refund: bk && bk.totals.tips > 0 ? `Refunded ${money(bk.totals.paid + bk.totals.tips)} to ${name}, tip included.` : `Refund sent to ${name}.`, done: `Marked done. ${name} got the balance link.`, cancel: `${name} got new times and a refund option.`, release: `Released ${name}'s hold.`, cash: `Recorded the payment from ${name}.`, 'demo-dispute': `Test dispute opened. The AI sent the evidence file (simulated). See Live activity.` }[act] || 'Done.');
  } catch (err) {
    toast(err.message, 'bad');
  }
  refresh();
});
$('#biz').addEventListener('change', async (e) => {
  setBiz(e.target.value);
  seenOwner = 0;
  try {
    await refresh();
    await connections();
  } catch (err) {
    toast(err.message, 'bad');
  }
});
$('#seed').addEventListener('click', async () => {
  $('#seed').disabled = true;
  try {
    const r = await api('/api/owner/seed', { method: 'POST', headers: hdr() });
    toast(r.already ? 'The sample day is already loaded. Use Reset demo for a fresh one.' : 'Sample day loaded.');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('#seed').disabled = false;
    refresh();
  }
});
$('#reset-biz').addEventListener('click', async () => {
  const name = lastState?.business.name || 'this business';
  if (!(await ask({ title: `Reset ${name}?`, text: `Clears ${name}'s demo bookings, texts and activity, then loads a fresh sample day. Other businesses are not touched, and any booking holding real PayPal sandbox money is kept.`, ok: 'Reset it', danger: true }))) return;
  $('#reset-biz').disabled = true;
  try {
    const r = await api('/api/owner/reset-business', { method: 'POST', headers: hdr() });
    seenOwner = 0;
    toast(`Reset. Fresh sample day loaded${r.kept ? ` (${r.kept} booking${r.kept === 1 ? '' : 's'} with real PayPal money kept)` : ''}.`);
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('#reset-biz').disabled = false;
    refresh();
  }
});
$('#reset').addEventListener('click', async () => {
  if (!(await ask({ title: 'Wipe all demo data?', text: 'This clears every demo booking, message and payment for every business on this server.', ok: 'Wipe it', danger: true }))) return;
  try {
    await api('/api/owner/reset', { method: 'POST', headers: hdr() });
  } catch (err) {
    return toast(err.message, 'bad');
  }
  seenOwner = 0;
  refresh();
});

await refresh();
connections();
listen(`/api/events?owner=1${code ? `&code=${encodeURIComponent(code)}` : ''}`, scheduleRefresh);
