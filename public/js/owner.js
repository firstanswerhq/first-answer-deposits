import { api, money, linkify, listen, $, escapeHtml, clock } from './common.js';

const code = new URLSearchParams(location.search).get('code') || '';
const hdr = code ? { 'x-owner-passcode': code } : {};
let seenOwner = 0;
let busy = false;
let refreshTimer = null;

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
    ['Avg first reply', s.avgFirstReplySec === null ? '—' : `${s.avgFirstReplySec}s`],
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
        return `<tr><td><strong>${escapeHtml(b.customerName)}</strong><div class="small muted">${escapeHtml(b.service)}, ${escapeHtml(b.size)}</div></td>
          <td>${escapeHtml(b.appointment)}</td>
          <td><span class="status ${b.status}">${escapeHtml(b.statusWords)}</span></td>
          <td class="num">${money(b.totals.total)}</td><td class="num">${money(b.totals.paid)}${b.totals.tips ? `<div class="small muted">+${money(b.totals.tips)} tip</div>` : ''}</td><td class="num">${money(b.totals.due)}</td>
          <td><div class="actions">${acts}<a class="btn ghost small" href="/evidence/${b.id}${code ? `?code=${code}` : ''}" target="_blank" title="Everything about this booking in one file">Record</a></div></td></tr>`;
      })
      .join('');
}

function feed(items) {
  $('#feed').innerHTML = items.map((a) => `<li><time>${clock(a.at)}</time>${escapeHtml(a.text)}</li>`).join('') || '<li class="muted">Nothing yet.</li>';
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
  const body = {};
  if (act === 'cash') {
    const amt = prompt('How much did they pay in cash?');
    if (!amt) return;
    body.amount = Number(amt.replace(/[^0-9.]/g, ''));
  }
  if (act === 'refund' && !confirm('Refund this customer through PayPal?')) return;
  b.disabled = true;
  try {
    await api(`/api/owner/bookings/${id}/${act}`, { method: 'POST', body, headers: hdr });
  } catch (err) {
    alert(err.message);
  }
  refresh();
});
$('#biz').addEventListener('change', async (e) => {
  await api('/api/owner/preset', { method: 'POST', body: { presetId: e.target.value }, headers: hdr });
  refresh();
});
$('#reset').addEventListener('click', async () => {
  if (!confirm('Clear all demo bookings and messages?')) return;
  await api('/api/owner/reset', { method: 'POST', headers: hdr });
  seenOwner = 0;
  refresh();
});

await refresh();
listen(`/api/events?owner=1${code ? `&code=${code}` : ''}`, scheduleRefresh);
