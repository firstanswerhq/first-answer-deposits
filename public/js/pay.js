import { api, money, linkify, listen, $, speechKit, escapeHtml, applyBrand } from './common.js';
import { registerWebMcpTools } from './webmcp.js';

const paymentId = location.pathname.split('/').pop();
const state = { data: null, tip: 0, sdkLoaded: false, rendered: false, speaking: false };

function firstName(n) {
  return String(n || '').trim().split(/\s+/)[0] || '';
}

function render() {
  const { payment, booking } = state.data;
  const t = booking.totals;
  document.title = `${booking.business.name} · Secure payment`;
  $('#biz-name').textContent = booking.business.name;
  $('#biz-mark').textContent = booking.business.name[0];
  applyBrand(booking.business.brand, { mark: $('#biz-mark'), name: $('#biz-name'), powered: $('#powered') });
  $('#pay-kind').textContent = payment.kind === 'deposit' ? 'Deposit to hold your appointment' : payment.kind === 'balance' ? 'Final balance' : payment.label;
  $('#pay-title').textContent = booking.title || booking.service;
  $('#pay-when').textContent = booking.appointment;
  const st = $('#pay-status');
  st.className = `status ${booking.status}`;
  st.textContent = booking.statusWords;

  const due = payment.amount + (payment.kind === 'balance' ? state.tip : 0);
  const rows = [];
  rows.push(['Total for the job', money(t.total)]);
  if (t.paid > 0) rows.push(['Already paid', money(t.paid)]);
  if (payment.kind === 'deposit') {
    // Once this deposit is paid it is already inside t.paid, so only subtract it while it is still due.
    const stillDue = payment.status === 'pending' ? payment.amount : 0;
    rows.push(['Balance after the job', money(Math.max(0, t.total - t.paid - stillDue))]);
  }
  if (payment.kind === 'balance' && state.tip > 0) rows.push(['Tip for the crew', money(state.tip)]);
  rows.push([payment.status === 'completed' ? 'Paid' : 'Due now', money(due), 'due']);
  $('#money-rows').innerHTML = rows.map(([k, v, c]) => `<li class="${c || ''}"><span>${escapeHtml(k)}</span><strong>${v}</strong></li>`).join('');

  $('#policy-note').innerHTML =
    payment.kind === 'deposit'
      ? `The deposit counts toward your total. Free to cancel or move until <strong>${escapeHtml(booking.freeCancelUntil)}</strong>. Rescheduling is always free.`
      : `Total ${money(t.total)} minus the ${money(t.paid)} you already paid. Questions about the bill? Ask on the right.`;

  if (payment.kind === 'balance' && payment.status === 'pending') {
    $('#tip-box').classList.remove('hidden');
    const opts = [0, 0.1, 0.15, 0.2].map((p) => ({ p, amt: Math.round(payment.amount * p) }));
    $('#tips').innerHTML = opts
      .map((o) => `<button type="button" data-tip="${o.amt}" class="${o.amt === state.tip ? 'on' : ''}">${o.p ? `${Math.round(o.p * 100)}%<br><span class="small muted">${money(o.amt)}</span>` : 'No tip'}</button>`)
      .join('');
  }

  const finished = payment.status === 'completed' || (payment.kind === 'deposit' && ['confirmed', 'paid_in_full', 'completed'].includes(booking.status));
  if (finished) return showDone();
  if (payment.status === 'void') {
    $('#pay-area').classList.add('hidden');
    $('#pay-error').textContent = 'This link was replaced by new ones (for example, a split payment). Check your texts, or ask on the right.';
    return;
  }
  setupPayment();
}

function icsFile() {
  const b = state.data.booking;
  const start = new Date(b.slotStart);
  const end = new Date(start.getTime() + (b.durationMinutes || 120) * 60000);
  const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//First Answer//Deposits//EN', 'BEGIN:VEVENT', `UID:${b.id}@firstanswer`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(start)}`, `DTEND:${f(end)}`, `SUMMARY:${b.service} - ${b.business.name}`, `DESCRIPTION:${b.title || b.service}. Booking: ${state.data.bookingUrl}`, `LOCATION:${b.address || ''}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
}

function showDone() {
  const { payment, booking } = state.data;
  $('#pay-area').classList.add('hidden');
  $('#tip-box').classList.add('hidden');
  $('#done').classList.remove('hidden');
  if (payment.kind === 'deposit') {
    $('#done-title').textContent = "You're confirmed!";
    $('#done-sub').textContent = `${booking.appointment}. Free to cancel or move until ${booking.freeCancelUntil}.`;
  } else {
    $('#done-title').textContent = 'All paid up. Thank you!';
    $('#done-sub').textContent = 'Your receipt is on your booking page.';
  }
  $('#ics').href = icsFile();
  $('#view-booking').href = state.data.bookingUrl;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function setupPayment() {
  const { paypal: pp, payment } = state.data;
  if (!pp) {
    // Demo mode (no PayPal keys): one button stands in for PayPal's.
    $('#paypal-buttons').classList.add('hidden');
    $('#paylater-message').classList.add('hidden');
    $('#demo-pay').classList.remove('hidden');
    return;
  }
  try {
    if (!state.sdkLoaded) {
      const params = new URLSearchParams({ 'client-id': pp.clientId, currency: 'USD', intent: 'capture', components: 'buttons,messages', 'enable-funding': 'venmo,paylater' });
      if (pp.env === 'sandbox') params.set('buyer-country', 'US');
      await loadScript(`https://www.paypal.com/sdk/js?${params}`);
      state.sdkLoaded = true;
    }
    renderPayLaterMessage();
    if (state.rendered) return;
    state.rendered = true;
    await window.paypal
      .Buttons({
        style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 48 },
        createOrder: async () => {
          const r = await api(`/api/pay/${paymentId}/order`, { method: 'POST', body: { tip: state.tip } });
          if (r.paid) throw new Error('Already paid');
          return r.orderId;
        },
        onApprove: async () => {
          $('#pay-error').textContent = '';
          const r = await api(`/api/pay/${paymentId}/capture`, { method: 'POST', body: {} });
          await load();
          if (r.status !== 'completed') $('#pay-error').textContent = 'PayPal is still finishing up. This page will update by itself.';
        },
        onCancel: () => say(`No problem, nothing was charged. ${payment.kind === 'deposit' ? 'Your time is held for a little while, so take your time.' : ''} Any questions?`),
        onError: (err) => {
          console.error(err);
          $('#pay-error').textContent = "That didn't go through and nothing was charged. Try again, or pick another way to pay.";
        },
      })
      .render('#paypal-buttons');
  } catch (err) {
    console.error(err);
    // Fallback: send them to PayPal's own page and back.
    $('#paypal-buttons').innerHTML = '<button class="btn primary" id="pp-redirect" style="width:100%">Pay with PayPal</button>';
    $('#pp-redirect').onclick = async () => {
      const r = await api(`/api/pay/${paymentId}/order`, { method: 'POST', body: { tip: state.tip, redirect: true } });
      if (r.url) location.href = r.url;
    };
  }
}

function renderPayLaterMessage() {
  if (!window.paypal?.Messages) return;
  const { payment } = state.data;
  const amount = payment.amount + (payment.kind === 'balance' ? state.tip : 0);
  // PayPal's own Pay Later wording, for the amount due now. Small deposits skip the banner (the option is still in the buttons).
  if (payment.kind === 'deposit' && amount < 100) {
    $('#paylater-message').innerHTML = '';
    return;
  }
  window.paypal.Messages({ amount, placement: 'payment', style: { layout: 'text', logo: { type: 'inline' } } }).render('#paylater-message');
}

// ---------- AI assistant ----------
function bubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role === 'me' ? 'me' : 'them'}`;
  div.innerHTML = linkify(text);
  $('#log').appendChild(div);
  $('#log').scrollTop = $('#log').scrollHeight;
}

function say(text) {
  bubble('them', text);
}

function typing(on) {
  let el = $('#typing');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'typing';
    el.className = 'typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    $('#log').appendChild(el);
    $('#log').scrollTop = $('#log').scrollHeight;
  } else if (!on && el) el.remove();
}

async function ask(text, { voice = false } = {}) {
  if (!text.trim()) return;
  bubble('me', text);
  typing(true);
  try {
    const r = await api(`/api/pay/${paymentId}/chat`, { method: 'POST', body: { text, channel: voice ? 'voice' : 'text' } });
    typing(false);
    if (r.reply) {
      say(r.reply);
      if (voice && kit) kit.say(r.reply);
    }
    state.data.booking = r.booking;
    state.data.payment = { ...state.data.payment, ...r.payment };
    state.rendered = state.rendered && r.payment.status === 'pending';
    render();
  } catch (err) {
    typing(false);
    say(err.message.includes('Too many') ? err.message : 'Sorry, I hit a snag. Try asking again.');
  }
}

const kit = speechKit();

function wire() {
  $('#ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q').value;
    $('#q').value = '';
    ask(q);
  });
  $('#suggest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (b) ask(b.dataset.q);
  });
  $('#ask-fab').addEventListener('click', () => {
    $('#assist').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('#q').focus({ preventScroll: true }), 400);
  });
  // Hide the pill once the assistant is on screen.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => $('#ask-fab').classList.toggle('hidden', e.isIntersecting), { threshold: 0.25 }).observe($('#assist'));
  }
  $('#tips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tip]');
    if (!b) return;
    state.tip = Number(b.dataset.tip);
    render();
  });
  $('#demo-pay').addEventListener('click', async () => {
    $('#demo-pay').disabled = true;
    await api(`/api/pay/${paymentId}/capture`, { method: 'POST', body: { tip: state.tip } });
    await load();
  });
  const mic = $('#mic');
  if (!kit) mic.classList.add('hidden');
  mic.addEventListener('click', async () => {
    mic.style.background = '#e5484d';
    mic.style.color = '#fff';
    try {
      const heard = await kit.listen();
      if (heard) await ask(heard, { voice: true });
    } catch {
      say("I couldn't hear that. You can type instead.");
    } finally {
      mic.style.background = '';
      mic.style.color = '';
    }
  });
}

async function load() {
  try {
    state.data = await api(`/api/pay/${paymentId}`);
    render();
  } catch (err) {
    $('#pay-title').textContent = 'Link not found';
    $('#pay-error').textContent = err.message;
  }
}

wire();
await load();
if (state.data) {
  // Browser assistants that speak WebMCP get the same help the chat box gives: read the bill, ask, change things.
  registerWebMcpTools([
    {
      name: 'get_payment_details',
      description: 'What this payment page is for: the business, service, appointment, total, what is paid, what is due now, the cancellation terms and how to pay.',
      execute: () => {
        const { booking, payment } = state.data;
        return { business: booking.business.name, service: booking.title || booking.service, appointment: booking.appointment, status: booking.statusWords, totals: booking.totals, dueNow: payment.status === 'pending' ? payment.amount : 0, paymentStatus: payment.status, freeCancelUntil: booking.freeCancelUntil, paymentMethods: ['PayPal', 'Venmo', 'Pay Later', 'debit or credit card'], note: 'Only the person can pay: use the PayPal buttons on the page.' };
      },
    },
    {
      name: 'ask_the_business',
      description: "Ask the business's AI a question about this booking or payment, or request a change (move the time, split the bill, send it to someone else, cancel). Returns the reply.",
      inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      execute: async ({ question }) => {
        const r = await api(`/api/pay/${paymentId}/chat`, { method: 'POST', body: { text: String(question).slice(0, 500), channel: 'text' } });
        if (r.reply) say(r.reply);
        state.data.booking = r.booking;
        state.data.payment = { ...state.data.payment, ...r.payment };
        render();
        return r.reply;
      },
    },
  ]);
  const { booking, payment } = state.data;
  const name = firstName(booking.customerName);
  if (payment.status === 'pending') {
    say(
      payment.kind === 'deposit'
        ? `Hi${name ? ` ${name}` : ''}! This ${money(payment.amount)} deposit holds ${booking.appointment}. It counts toward your ${money(booking.totals.total)} total, and you can cancel free until ${booking.freeCancelUntil}. Ask me anything.`
        : `Hi${name ? ` ${name}` : ''}! Your balance is ${money(payment.amount)}. You can add a tip for the crew if you'd like, and pay any way you want. Ask me anything.`,
    );
  }
  listen(`/api/events?lead=${state.data.leadId}`, (evt) => {
    if (evt.kind === 'booking') load();
  });
}
