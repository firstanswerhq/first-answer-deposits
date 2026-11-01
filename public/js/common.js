// Shared helpers for every page.
export async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const money = (n) => {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: v % 1 ? 2 : 0 });
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Escapes the text and turns links into tappable short labels.
export function linkify(text) {
  const safe = escapeHtml(text);
  return safe.replace(/https?:\/\/[^\s<]+[^\s<.,!?;:)]/g, (url) => {
    const short = url.includes('/p/') ? 'Open payment page' : url.includes('/b/') ? 'View your booking' : url.replace(/^https?:\/\//, '').slice(0, 32);
    return `<a href="${url}" data-link="${url}" target="_blank" rel="noopener">${short}</a>`;
  });
}

export function clock(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function listen(url, onEvent) {
  let es;
  const open = () => {
    es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {}
    };
    es.onerror = () => {
      es.close();
      setTimeout(open, 3000);
    };
  };
  open();
  return () => es && es.close();
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

// In-page dialog (no browser pop-ups). Resolves to true / the typed value, or null if canceled.
export function ask({ title, text = '', input = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    const field = input
      ? `<label class="field">${input.prefix ? `<span class="muted">${escapeHtml(input.prefix)}</span>` : ''}<input name="v" autocomplete="off" inputmode="${input.inputmode || 'text'}" placeholder="${escapeHtml(input.placeholder || '')}" value="${escapeHtml(input.value ?? '')}" ${input.optional ? '' : 'required'}></label>`
      : '';
    d.innerHTML = `<form method="dialog"><h3>${escapeHtml(title)}</h3>${text ? `<p class="muted">${escapeHtml(text)}</p>` : ''}${field}
      <div class="modal-actions"><button value="cancel" class="btn secondary" formnovalidate>${escapeHtml(cancel)}</button><button value="ok" class="btn ${danger ? 'danger' : 'primary'}">${escapeHtml(ok)}</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      const v = d.returnValue === 'ok' ? (input ? d.querySelector('input').value.trim() : true) : null;
      d.remove();
      resolve(v);
    });
    d.showModal();
    (d.querySelector('input') || d.querySelector('button[value=ok]')).focus();
  });
}

// Small message that fades away (used instead of alert()).
// One at a time: a new message replaces the one on screen, so two never stack on top of each other.
export function toast(text, kind = '') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// Browser speech for call mode (Chrome, Edge, Safari). Returns null when the browser can't do it.
export function speechKit() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec || !window.speechSynthesis) return null;
  return {
    listen() {
      return new Promise((resolve, reject) => {
        const rec = new Rec();
        rec.lang = 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = (e) => resolve(e.results[0][0].transcript);
        rec.onerror = (e) => reject(new Error(e.error));
        rec.onend = () => resolve('');
        rec.start();
      });
    },
    say(text) {
      return new Promise((resolve) => {
        const clean = String(text).replace(/https?:\/\/\S+/g, 'the link').replace(/[*_#]/g, '');
        const u = new SpeechSynthesisUtterance(clean);
        const voices = speechSynthesis.getVoices();
        u.voice = voices.find((v) => /en-US/.test(v.lang) && /Natural|Samantha|Google US English|Aria|Jenny/i.test(v.name)) || voices.find((v) => /en-US/.test(v.lang)) || null;
        u.rate = 1.03;
        u.onend = resolve;
        u.onerror = resolve;
        speechSynthesis.speak(u);
      });
    },
  };
}

// ---------- white label ----------
// Paint the page in the business's color and show its logo. Falls back to the First Answer look.
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
const mix = (rgb, to, k) => rgb.map((c, i) => Math.round(c + (to[i] - c) * k));
const rgbStr = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
export function applyBrand(brand, { mark = null, name = null, powered = null } = {}) {
  const b = brand || {};
  const rgb = hexToRgb(b.color);
  const root = document.documentElement.style;
  if (rgb) {
    const dark = mix(rgb, [20, 24, 60], 0.35);
    const light = mix(rgb, [255, 255, 255], 0.9);
    root.setProperty('--brand-1', b.color);
    root.setProperty('--brand-2', `rgb(${dark.join(',')})`);
    root.setProperty('--brand-3', b.color);
    root.setProperty('--grad', `linear-gradient(135deg, ${b.color}, rgb(${dark.join(',')}))`);
    root.setProperty('--info-bg', `rgb(${light.join(',')})`);
    root.setProperty('--brand-shadow', rgbStr(rgb, 0.28));
  }
  if (mark) {
    if (b.logoUrl) {
      mark.innerHTML = '';
      const img = document.createElement('img');
      img.src = b.logoUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { mark.textContent = (name && name.textContent ? name.textContent : 'B')[0]; };
      mark.appendChild(img);
      mark.classList.add('logo');
    } else if (name && name.textContent) mark.textContent = name.textContent[0];
  }
  if (powered) powered.textContent = `Powered by ${b.poweredBy || 'First Answer'}`;
}

// ---------- live status ----------
// One line fed by /api/health: "PayPal: sandbox connected · AI: Claude · live", or "demo mode" when a key is missing.
export function statusLine(h) {
  const paypalOn = h.paypal && !/^demo/i.test(h.paypal);
  const aiOn = Boolean(h.aiReady);
  const paypal = paypalOn ? `PayPal: ${h.paypal} connected` : 'PayPal: demo mode';
  const ai = aiOn ? `AI: ${h.ai}` : 'AI: scripted demo';
  return `${paypal} · ${ai} · ${paypalOn && aiOn ? 'live' : 'demo mode'}`;
}
export async function liveStatus(el) {
  if (!el) return;
  try {
    el.textContent = statusLine(await api('/api/health'));
  } catch {
    el.textContent = '';
  }
}
