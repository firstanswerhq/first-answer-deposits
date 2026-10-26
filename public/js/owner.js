import { api, money, linkify, listen, $, escapeHtml, clock, ask, toast } from './common.js';

const code = new URLSearchParams(location.search).get('code') || '';
const hdr = code ? { 'x-owner-passcode': code } : {};
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
    ['Money in (30 days)', money(s.money.gross)],
    ['Still owed', money(s.money.stillOwed)],
  ];
  $('#kpis').innerHTML = tiles.map(([l, v]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
}

function bookings(list) {
  if (!list.length) {
    $('#bookings').innerHTML = '<tr><td class="muted">No bookings yet. Open the customer\'s phone and text the business.</td></tr>';
    return;
  }
  $('#bookings').innerHTML =
    '<tr><th>Customer</th><th>Appointment</th><th>Status</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Owed</th><th></th></tr>' +
    list
      .map((b) => {
        const acts = (ACTIONS[b.status] || []).map(([a, label]) => `<button class="btn secondary small" data-act="${a}" data-id="${b.id}">${label}</button>`).join('');
        return `<tr><td><strong>${escapeHtml(b.customerName)}</strong><div class="small muted">${escapeHtml(b.title || b.service)}</div></td>
          <td>${escapeHtml(b.appointment)}</td>
          <td><span class="status ${b.status}">${escapeHtml(b.statusWords)}</span></td>
          <td class="num">${money(b.totals.total)}</td><td class="num">${money(b.totals.paid)}${b.totals.tips ? `<div class="small muted">+${money(b.totals.tips)} tip</div>` : ''}</td><td class="num">${money(b.totals.due)}</td>
          <td><div class="actions">${acts}<a class="btn ghost small" href="/evidence/${b.id}${code ? `?code=${code}` : ''}" target="_blank" title="Everything about this booking in one file">Record</a></div></td></tr>`;
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
  const s = await api('/api/owner/state', { headers: hdr });
  lastState = s;
  $('#biz').innerHTML = s.presets.map((p) => `<option value="${p.id}" ${p.id === s.business.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
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
  const c = await api('/api/owner/connections', { headers: hdr });
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
  const ro = !c.business.custom;
  for (const id of ['c-busy', 'c-webhook', 'c-payout', 'c-logo', 'c-color']) $(`#${id}`).disabled = ro;
  $('#c-save').disabled = ro;
  $('#c-save-brand').disabled = ro;
  $('#c-note').textContent = ro ? 'Demo businesses are read-only. Set up your own at /setup to connect apps.' : c.webhookSecret ? `Webhook signing secret: ${c.webhookSecret}` : '';
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
    await api('/api/owner/connections', {
      method: 'POST',
      headers: hdr,
      body: { busyCalendarUrl: $('#c-busy').value, webhookUrl: $('#c-webhook').value, payoutEmail: $('#c-payout').value, logoUrl: $('#c-logo').value, brandColor: $('#c-color').value },
    });
    toast('Saved.');
    connections();
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
    await api('/api/owner/text', { method: 'POST', body: { text: q }, headers: hdr });
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
      text: `${money(bk ? bk.totals.paid : 0)} goes back through PayPal to the account they paid with, and they get a text with the reference number.`,
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
  b.disabled = true;
  try {
    await api(`/api/owner/bookings/${id}/${act}`, { method: 'POST', body, headers: hdr });
    toast({ remind: `Reminder sent to ${name}.`, refund: `Refund sent to ${name}.`, done: `Marked done. ${name} got the balance link.`, cancel: `${name} got new times and a refund option.`, release: `Released ${name}'s hold.`, cash: `Recorded the payment from ${name}.` }[act] || 'Done.');
  } catch (err) {
    toast(err.message, 'bad');
  }
  refresh();
});
$('#biz').addEventListener('change', async (e) => {
  await api('/api/owner/preset', { method: 'POST', body: { presetId: e.target.value }, headers: hdr });
  refresh();
  connections();
});
$('#seed').addEventListener('click', async () => {
  $('#seed').disabled = true;
  try {
    await api('/api/owner/seed', { method: 'POST', headers: hdr });
    toast('Sample day loaded.');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('#seed').disabled = false;
    refresh();
  }
});
$('#reset').addEventListener('click', async () => {
  if (!(await ask({ title: 'Start the demo over?', text: 'This clears every demo booking, message and payment.', ok: 'Clear it', danger: true }))) return;
  await api('/api/owner/reset', { method: 'POST', headers: hdr });
  seenOwner = 0;
  refresh();
});

await refresh();
connections();
// /owner?biz=<id> opens a specific business (used by the setup page's "owner's phone" link).
const wantBiz = new URLSearchParams(location.search).get('biz');
if (wantBiz && lastState && lastState.business.id !== wantBiz && lastState.presets.some((p) => p.id === wantBiz)) {
  await api('/api/owner/preset', { method: 'POST', body: { presetId: wantBiz }, headers: hdr });
  seenOwner = 0;
  await refresh();
  connections();
}
listen(`/api/events?owner=1${code ? `&code=${code}` : ''}`, scheduleRefresh);
