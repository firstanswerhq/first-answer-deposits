import { api, linkify, listen, $, speechKit, clock } from './common.js';

const BIZ = [
  { id: 'cleaning', label: 'House cleaner' },
  { id: 'detailing', label: 'Auto detailer' },
  { id: 'hvac', label: 'HVAC company' },
];

const params = new URLSearchParams(location.search);
let presetId = BIZ.some((b) => b.id === params.get('biz')) ? params.get('biz') : 'cleaning';
let leadId = null;
let seen = 0;
let stopListening = null;
let waiting = false;

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

function renderPick() {
  $('#pick').innerHTML = BIZ.map((b) => `<button data-id="${b.id}" class="${b.id === presetId ? 'on' : ''}">${b.label}</button>`).join('');
}

function addBubble(m) {
  const div = document.createElement('div');
  div.className = `bubble ${m.role === 'customer' ? 'me' : 'them'}`;
  div.innerHTML = linkify(m.text);
  $('#thread').appendChild(div);
}

function renderMessages(messages) {
  const thread = $('#thread');
  if (seen === 0) {
    thread.innerHTML = `<div class="stamp">Today ${messages[0] ? clock(messages[0].at) : ''}</div>`;
  }
  for (const m of messages.slice(seen)) addBubble(m);
  seen = messages.length;
  thread.scrollTop = thread.scrollHeight;
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

async function start(fresh = false) {
  if (stopListening) stopListening();
  seen = 0;
  $('#thread').innerHTML = '';
  const key = `fad-lead-${presetId}`;
  leadId = fresh ? null : store.get(key);
  let data = null;
  if (leadId) {
    try {
      data = await api(`/api/text/${leadId}`);
    } catch {
      leadId = null;
    }
  }
  if (!leadId) {
    const r = await api('/api/text/start', { method: 'POST', body: { presetId } });
    leadId = r.leadId;
    store.set(key, leadId);
    data = { business: r.business, messages: [] };
  }
  $('#biz').textContent = data.business;
  $('#avatar').textContent = data.business[0];
  $('#call-who').textContent = data.business;
  renderMessages(data.messages);
  stopListening = listen(`/api/events?lead=${leadId}`, async (evt) => {
    if (evt.kind === 'message' && !waiting) {
      const d = await api(`/api/text/${leadId}`);
      renderMessages(d.messages);
    }
  });
}

async function send(text, channel = 'text') {
  text = text.trim();
  if (!text) return null;
  waiting = true;
  addBubble({ role: 'customer', text });
  seen += 1;
  $('#thread').scrollTop = $('#thread').scrollHeight;
  typing(true);
  try {
    const r = await api(`/api/text/${leadId}`, { method: 'POST', body: { text, channel } });
    typing(false);
    renderMessages(r.messages);
    return r.reply;
  } catch (err) {
    typing(false);
    addBubble({ role: 'assistant', text: err.message.includes('Too many') ? err.message : 'Sorry, the message did not send. Try again.' });
    return null;
  } finally {
    waiting = false;
  }
}

// ---------- call mode ----------
const kit = speechKit();
let onCall = false;

async function callLoop() {
  const ui = $('#callui');
  const stateEl = $('#call-state');
  const cap = $('#call-caption');
  const greeting = `Thanks for calling ${$('#biz').textContent}. How can I help?`;
  stateEl.textContent = 'connected';
  cap.textContent = greeting;
  await kit.say(greeting);
  while (onCall) {
    ui.classList.add('listening');
    stateEl.textContent = 'listening…';
    let heard = '';
    try {
      heard = await kit.listen();
    } catch {
      heard = '';
    }
    ui.classList.remove('listening');
    if (!onCall) break;
    if (!heard) continue;
    cap.textContent = `“${heard}”`;
    stateEl.textContent = 'thinking…';
    const reply = await send(heard, 'voice');
    if (!onCall) break;
    if (reply) {
      cap.textContent = reply;
      stateEl.textContent = 'speaking';
      await kit.say(reply);
    }
  }
}

$('#call').addEventListener('click', () => {
  if (!kit) {
    addBubble({ role: 'assistant', text: 'Calling works in Chrome, Edge or Safari. You can text here too.' });
    return;
  }
  onCall = true;
  $('#callui').classList.remove('hidden');
  callLoop();
});
$('#hangup').addEventListener('click', () => {
  onCall = false;
  speechSynthesis.cancel();
  $('#callui').classList.add('hidden');
});

// ---------- wiring ----------
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msg').value;
  $('#msg').value = '';
  send(v);
});
$('#thread').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  const url = a.dataset.link;
  if (url.startsWith(location.origin)) {
    e.preventDefault();
    $('#sheet-frame').src = url;
    $('#sheet').classList.remove('hidden');
  }
});
$('#sheet-close').addEventListener('click', () => {
  $('#sheet').classList.add('hidden');
  $('#sheet-frame').src = 'about:blank';
});
$('#pick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  presetId = b.dataset.id;
  history.replaceState(null, '', `?biz=${presetId}`);
  renderPick();
  start();
});
$('#restart').addEventListener('click', () => {
  store.del(`fad-lead-${presetId}`);
  start(true);
});

renderPick();
start();
