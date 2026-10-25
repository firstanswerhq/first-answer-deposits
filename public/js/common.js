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
