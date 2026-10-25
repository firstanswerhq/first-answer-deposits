// Agent-to-agent demo: the customer talks to their own assistant (left); the assistant talks to the business
// over MCP (right, live). When a time is held, the human gets one PayPal approval. The assistant never pays.
import { api, escapeHtml, linkify, $, money } from './common.js';

const PRESETS = [
  { id: 'cleaning', label: 'House cleaner' },
  { id: 'detailing', label: 'Auto detailer' },
  { id: 'hvac', label: 'HVAC company' },
];
const CUSTOMER = { cleaning: ['Sarah', 'her'], detailing: ['Marcus', 'his'], hvac: ['Priya', 'her'], other: ['Alex', 'their'] };
const PROMPTS = {
  cleaning: ["Book a deep clean for my 3-bedroom this Friday morning, keep it under $300. I'm Sarah.", 'Did I pay yet?', 'Move it to Saturday afternoon'],
  detailing: ["Full detail on my SUV this week, I'm Marcus", 'Is it confirmed?', 'Cancel it'],
  hvac: ["AC tune-up for one system, next Tuesday morning, I'm Priya", 'What do I still owe?', 'Move it to Wednesday'],
  other: ['Book me the first open time this week. I\'m Alex.', 'Is it confirmed?', 'Move it to tomorrow'],
};

const params = new URLSearchParams(location.search);
let bizId = params.get('biz') || 'cleaning';
let info = null;
let sessionId = null;
let busy = false;
let watching = null;

const mem = {
  get: (k) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  },
  del: (k) => {
    try {
      sessionStorage.removeItem(k);
    } catch {}
  },
};
const newId = () => 'as_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clockNow = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

// ---------- chat ----------
function bubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role === 'user' ? 'me' : 'them'}`;
  div.innerHTML = linkify(text);
  $('#thread').appendChild(div);
  $('#thread').scrollTop = $('#thread').scrollHeight;
  return div;
}

function typing(on) {
  let el = $('#typing');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'typing';
    el.className = 'typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    $('#thread').appendChild(el);
    $('#thread').scrollTop = $('#thread').scrollHeight;
  } else if (!on && el) el.remove();
}

// The human-approval card. Polls the payment so the card flips to "paid" when they approve in the other tab.
function approvalCard(approval) {
  const paymentId = approval.url.split('/p/')[1] || '';
  // One card per deposit: a status check or a move brings the same link back, not a new one.
  const existing = paymentId && document.querySelector(`.approve[data-payment="${paymentId}"]`);
  if (existing) {
    $('#thread').appendChild(existing);
    $('#thread').scrollTop = $('#thread').scrollHeight;
    return;
  }
  const card = document.createElement('div');
  card.className = 'approve';
  card.dataset.payment = paymentId;
  card.innerHTML = `
    <div class="row">
      <div><div class="label">Deposit to hold the time</div><div class="amount">${money(approval.amount)}</div></div>
      <span class="status held">Held · waiting on you</span>
    </div>
    <a class="btn primary" href="${escapeHtml(approval.url)}" target="_blank" rel="noopener">Approve the ${money(approval.amount)} deposit in <span class="pp">PayPal</span></a>
    <p class="fine"><strong>The assistant can't pay. Only you can.</strong> PayPal, Venmo, Pay Later or a card, no account needed. The deposit counts toward the bill.</p>`;
  $('#thread').appendChild(card);
  $('#thread').scrollTop = $('#thread').scrollHeight;
  watchPayment(card);
}

function watchPayment(card) {
  if (watching) clearInterval(watching);
  const id = card.dataset.payment;
  if (!id) return;
  const check = async () => {
    try {
      const r = await api(`/api/pay/${id}`);
      if (r.payment.status === 'completed') {
        clearInterval(watching);
        card.classList.add('paid');
        card.querySelector('.status').className = 'status confirmed';
        card.querySelector('.status').textContent = 'Paid · confirmed';
        card.querySelector('.btn').outerHTML = `<a class="btn secondary" href="${escapeHtml(r.bookingUrl)}" target="_blank" rel="noopener">View the booking</a>`;
        card.querySelector('.fine').innerHTML = `<strong>You approved ${money(r.payment.amount)} in PayPal.</strong> ${escapeHtml(r.booking.appointment)} is confirmed. The business saw it the same second.`;
        bubble('assistant', `Your ${money(r.payment.amount)} deposit went through. ${r.booking.appointment} is confirmed.`);
      } else if (['void', 'canceled'].includes(r.payment.status)) clearInterval(watching);
    } catch {}
  };
  watching = setInterval(check, 4000);
}

// ---------- protocol trace ----------
const short = (v) => {
  if (typeof v === 'string') return `"${v.length > 42 ? v.slice(0, 40) + '…' : v}"`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') return '{…}';
  return String(v);
};
const kv = (obj, keys) =>
  keys
    .filter((k) => obj[k] !== undefined && obj[k] !== null)
    .map((k) => `<span class="k">${escapeHtml(k)}</span> ${escapeHtml(short(obj[k]))}`)
    .join('  ');

// One line per result: the fields a human cares about for that tool.
function summarize(tool, r) {
  if (!r || typeof r !== 'object') return escapeHtml(String(r ?? ''));
  if (r.error) return escapeHtml(String(r.error));
  switch (tool) {
    case 'get_business_info':
      return `${escapeHtml(r.name)} · ${(r.services || []).length} services · deposit ${escapeHtml(r.deposit_rule || '')} · pays by ${escapeHtml((r.payment?.methods || []).join(', '))}`;
    case 'check_availability':
      return `${(r.slots || []).length} open: ${escapeHtml((r.slots || []).slice(0, 3).map((s) => s.label).join(' · '))}${(r.slots || []).length > 3 ? ' …' : ''}${r.note ? ` · ${escapeHtml(r.note)}` : ''}`;
    case 'get_quote':
      return kv(r, ['service', 'size', 'price', 'deposit_due_now', 'balance_after']);
    case 'book_appointment':
      if (r.booked === false) return `<span class="k">booked</span> false  <span class="k">reason</span> ${escapeHtml(r.reason)} · ${escapeHtml(r.message || '')}`;
      return `${kv(r, ['booked', 'status', 'appointment', 'total', 'deposit'])}  <span class="k">approval_url</span> ${escapeHtml(short(r.approval_url))}  <span class="k">human_approval_required</span> ${r.human_approval_required}`;
    case 'get_booking_status':
      return kv(r, ['status', 'appointment', 'paid', 'due', 'human_approval_required']);
    case 'reschedule_booking':
      return `${kv(r, ['moved', 'from'])}  <span class="k">to</span> ${escapeHtml(short(r.appointment))}  ${kv(r, ['paid'])}`;
    case 'cancel_booking':
      return kv(r, ['canceled', 'outcome', 'refunded', 'kept']);
    default:
      return escapeHtml(
        Object.entries(r)
          .slice(0, 4)
          .map(([k, v]) => `${k} ${short(v)}`)
          .join('  '),
      );
  }
}

const argsLine = (args) =>
  Object.entries(args || {}).length
    ? Object.entries(args)
        .map(([k, v]) => `<span class="k">${escapeHtml(k)}</span>: ${escapeHtml(short(v))}`)
        .join(', ')
    : '<span class="k">no arguments</span>';

function addCall(entry, { animate = true } = {}) {
  $('#trace-empty')?.remove();
  const li = document.createElement('li');
  li.className = `rpc${entry.error ? ' err' : ''}`;
  if (!animate) li.style.animation = 'none';
  li.innerHTML = `
    <div class="ln"><span class="arrow">&rarr;</span><span class="args"><span class="tool">${escapeHtml(entry.tool)}</span> ${argsLine(entry.args)}</span><span class="t">${clockNow()}</span></div>
    <div class="ln"><span class="arrow">&larr;</span><span class="res">${summarize(entry.tool, entry.result)}</span></div>
    <details><summary>full result</summary><pre>${escapeHtml(JSON.stringify(entry.result, null, 2))}</pre></details>`;
  $('#trace').appendChild(li);
  $('#trace').scrollTop = $('#trace').scrollHeight;
}

function addSeparator(text) {
  const li = document.createElement('li');
  li.className = 'sep';
  li.textContent = text;
  $('#trace').appendChild(li);
}

// Calls arrive together; show them one by one so the eye can follow the handshake.
async function playTrace(trace) {
  for (const entry of trace) {
    addCall(entry);
    await new Promise((r) => setTimeout(r, 420));
  }
}

// ---------- turns ----------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  $('#live-dot').classList.add('busy');
  bubble('user', text);
  typing(true);
  addSeparator(`“${text.length > 48 ? text.slice(0, 46) + '…' : text}”`);
  try {
    const r = await api('/api/assistant', { method: 'POST', body: { sessionId, text, bizId } });
    await playTrace(r.trace || []);
    typing(false);
    bubble('assistant', r.reply);
    if (r.approval) approvalCard(r.approval);
  } catch (err) {
    typing(false);
    bubble('assistant', err.message.includes('Too many') ? err.message : 'Something went wrong talking to the business. Try again.');
  } finally {
    busy = false;
    $('#live-dot').classList.remove('busy');
  }
}

function renderChips() {
  const list = PROMPTS[bizId] || PROMPTS.other;
  $('#chips').innerHTML = list.map((p) => `<button type="button" class="chip" data-say="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('');
}

function renderPick() {
  const custom = PRESETS.some((b) => b.id === bizId) ? '' : `<button data-id="${escapeHtml(bizId)}" class="on">${escapeHtml(info?.business?.name || 'Your business')}</button>`;
  $('#pick').innerHTML = custom + PRESETS.map((b) => `<button data-id="${b.id}" class="${b.id === bizId ? 'on' : ''}">${b.label}</button>`).join('');
}

async function start(fresh = false) {
  busy = false;
  if (watching) clearInterval(watching);
  $('#thread').innerHTML = '';
  $('#trace').innerHTML = '<li class="trace-empty" id="trace-empty">Waiting for the first call. Every MCP tool call the assistant makes to the business shows up here: the tool, what it sent, what came back.</li>';
  try {
    info = await api(`/api/assistant/info?biz=${encodeURIComponent(bizId)}`);
  } catch {
    bubble('assistant', 'The business endpoint is not answering. Reload in a moment.');
    return;
  }
  bizId = info.business.id;
  $('#biz-name').textContent = info.business.name;
  const [cust, poss] = CUSTOMER[bizId] || CUSTOMER.other;
  document.querySelectorAll('.lede .cust').forEach((el) => (el.textContent = cust));
  document.querySelectorAll('.lede .poss').forEach((el) => (el.textContent = poss));
  $('#endpoint').textContent = info.endpoint;
  $('#assistant-name').textContent = info.mode === 'model' ? `${info.assistant}, your assistant` : 'Your assistant';
  $('#assistant-sub').textContent = `${info.mode === 'model' ? `${info.assistant} · ` : 'scripted demo (no AI key) · '}connected to ${info.business.name} over MCP`;
  $('#avatar').textContent = info.assistant[0];
  $('#link-ucp').href = info.discovery.ucp;
  $('#link-card').href = info.discovery.agentCard;
  $('#link-llms').href = info.discovery.llms;
  renderPick();
  renderChips();

  const key = `fad-assistant-${bizId}`;
  sessionId = fresh ? null : mem.get(key);
  let restored = null;
  if (sessionId) {
    try {
      restored = await api(`/api/assistant/${sessionId}`);
    } catch {
      sessionId = null;
    }
  }
  if (!sessionId) {
    sessionId = newId();
    mem.set(key, sessionId);
  }
  if (restored) {
    for (const m of restored.history) {
      bubble(m.role, m.text);
      if (m.approval) approvalCard(m.approval);
    }
    for (const entry of restored.trace) addCall(entry, { animate: false });
  } else {
    bubble('assistant', `Hi! I can book ${info.business.name} for you. Tell me what you need and when, and I'll handle the business. You'll only need to approve the deposit.`);
  }
}

// ---------- wiring ----------
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msg').value;
  $('#msg').value = '';
  send(v);
});
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-say]');
  if (b) send(b.dataset.say);
});
$('#pick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b || b.dataset.id === bizId) return;
  bizId = b.dataset.id;
  history.replaceState(null, '', `?biz=${encodeURIComponent(bizId)}`);
  start();
});
$('#restart').addEventListener('click', () => {
  mem.del(`fad-assistant-${bizId}`);
  start(true);
});

start();
