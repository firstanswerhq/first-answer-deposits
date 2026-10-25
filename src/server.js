import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paypalReady, aiReady } from './config.js';
import * as store from './store.js';
import * as B from './bookings.js';
import * as paypal from './paypal.js';
import { presets } from './business.js';
import { replyToCustomer } from './agent/customer.js';
import { ownerCommand } from './agent/owner.js';
import { modelLabel, checkModel, aiStatus } from './agent/model.js';
import * as setup from './setup.js';
import * as connect from './connect.js';
import { seedSampleDay } from './seed.js';

const app = express();
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// PayPal webhooks need the raw body for signature checks, so this route comes before express.json().
app.post('/api/webhooks/paypal', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  try {
    const check = await paypal.verifyWebhook(req.headers, raw);
    if (!check.verified) {
      console.warn('PayPal webhook not verified:', check.reason);
      return res.status(400).json({ ok: false });
    }
    await B.handlePayPalEvent(JSON.parse(raw));
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(pub, { extensions: ['html'] }));

// ---------- small helpers ----------
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.route?.path || ''}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many messages, give it a minute.' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}
const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
const ownerOnly = (req, res, next) => {
  if (!config.ownerPasscode) return next();
  if (req.get('x-owner-passcode') === config.ownerPasscode || req.query.code === config.ownerPasscode) return next();
  res.status(401).json({ error: 'Owner passcode required.' });
};
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

function publicBooking(b) {
  if (!b) return null;
  const business = B.businessOf(b);
  return {
    id: b.id,
    business: { name: business.name, trade: business.trade, city: business.city },
    customerName: b.customerName,
    service: b.service,
    size: b.size === 'standard' ? '' : b.size,
    title: b.size === 'standard' ? b.service : `${b.service}, ${b.size}`,
    appointment: b.slotLabel,
    slotStart: b.slotStart,
    durationMinutes: business.slotMinutes,
    address: business.city,
    status: b.status,
    statusWords: B.STATUS_WORDS[b.status] || b.status,
    deposit: b.deposit,
    totals: B.totals(b),
    freeCancelUntil: B.freeCancelLabel(b),
    changes: b.changes,
    payments: b.payments.map((p) => ({ id: p.id, label: p.label, kind: p.kind, amount: p.amount, tip: p.tip || 0, status: p.status, via: p.via || p.mode || null, refund: p.refund || null, at: p.completedAt || p.createdAt })),
    timeline: b.timeline,
  };
}

async function customerTurn(leadId, text, channel = 'text') {
  store.addMessage(leadId, 'customer', text, { channel });
  const reply = await replyToCustomer(leadId, { channel });
  if (reply) store.addMessage(leadId, 'assistant', reply, { channel });
  return reply;
}

// ---------- health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, paypal: paypalReady ? config.paypal.env : 'demo mode (no keys)', ai: modelLabel(), aiReady, aiCheck: aiStatus });
});

// ---------- customer text thread ----------
app.post('/api/text/start', wrap(async (req, res) => {
  const presetId = B.businessById(req.body.presetId) ? req.body.presetId : store.getSettings().presetId;
  const lead = store.createLead({ channel: req.body.channel || 'text', presetId, phone: req.body.phone || '' });
  res.json({ leadId: lead.id, business: B.businessById(presetId).name });
}));

app.get('/api/text/:leadId', (req, res) => {
  const lead = store.getLead(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json({ leadId: lead.id, business: B.businessOf(lead).name, messages: lead.messages });
});

app.post('/api/text/:leadId', rateLimit(40, 10 * 60 * 1000), wrap(async (req, res) => {
  const lead = store.getLead(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const text = cleanText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const reply = await customerTurn(lead.id, text, req.body.channel === 'voice' ? 'voice' : 'text');
  res.json({ reply, messages: store.getLead(lead.id).messages });
}));

// ---------- guided payment page ----------
app.get('/p/:paymentId', (req, res) => res.sendFile(path.join(pub, 'pay.html')));

app.get('/api/pay/:paymentId', (req, res) => {
  const found = store.findPayment(req.params.paymentId);
  if (!found) return res.status(404).json({ error: 'This link is not valid.' });
  const { booking, payment } = found;
  res.json({
    payment: { id: payment.id, label: payment.label, kind: payment.kind, amount: payment.amount, status: payment.status, tip: payment.tip || 0, expectedPayer: payment.expectedPayer || null },
    booking: publicBooking(booking),
    leadId: booking.leadId,
    bookingUrl: B.bookingPageUrl(booking),
    paypal: paypalReady ? { clientId: config.paypal.clientId, env: config.paypal.env } : null,
  });
});

app.post('/api/pay/:paymentId/order', rateLimit(30, 10 * 60 * 1000), wrap(async (req, res) => {
  const tip = Math.max(0, Math.min(500, Math.round(Number(req.body.tip || 0) * 100) / 100));
  const r = await B.checkoutFor(req.params.paymentId, { tip, redirect: Boolean(req.body.redirect) });
  if (r.paid) return res.json({ paid: true });
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.demo) return res.json({ demo: true });
  res.json({ orderId: r.orderId, url: r.url });
}));

app.post('/api/pay/:paymentId/capture', wrap(async (req, res) => {
  const found = store.findPayment(req.params.paymentId);
  if (!found) return res.status(404).json({ error: 'Not found' });
  if (found.payment.mode === 'demo' || !paypalReady) {
    B.completeDemoPayment(found.payment.id, { tip: Number(req.body.tip || 0) });
  } else {
    await B.syncPayment(found.payment.id);
  }
  const after = store.findPayment(req.params.paymentId);
  res.json({ status: after.payment.status, booking: publicBooking(after.booking) });
}));

app.post('/api/pay/:paymentId/chat', rateLimit(40, 10 * 60 * 1000), wrap(async (req, res) => {
  const found = store.findPayment(req.params.paymentId);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const text = cleanText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const reply = await customerTurn(found.booking.leadId, text, req.body.channel === 'voice' ? 'voice' : 'payment page');
  const after = store.findPayment(req.params.paymentId);
  res.json({ reply, booking: publicBooking(after.booking), payment: after.payment });
}));

// Redirect flow (used if the PayPal buttons can't load): PayPal sends people back here.
app.get('/pay/return', wrap(async (req, res) => {
  const id = String(req.query.payment || '');
  if (store.findPayment(id)) await B.syncPayment(id).catch((e) => console.error(e.message));
  res.redirect(`/p/${encodeURIComponent(id)}?done=1`);
}));
app.get('/pay/cancel', (req, res) => res.redirect(`/p/${encodeURIComponent(String(req.query.payment || ''))}?canceled=1`));

// ---------- customer booking page (receipt, record) ----------
app.get('/b/:bookingId', (req, res) => res.sendFile(path.join(pub, 'booking.html')));
app.get('/api/booking/:bookingId', (req, res) => {
  const b = store.getBooking(req.params.bookingId);
  if (!b || req.query.k !== b.secret) return res.status(404).json({ error: 'Not found' });
  const open = b.payments.find((p) => p.status === 'pending');
  res.json({ booking: publicBooking(b), payLink: open ? B.payPageUrl(open) : null });
});

// ---------- setup by text (any business, in a minute) ----------
app.get('/api/setup/steps', (req, res) => res.json({ steps: setup.STEPS, ai: Boolean(modelLabel() && aiReady) }));
app.post('/api/setup/answer', rateLimit(60, 10 * 60 * 1000), (req, res) => {
  // Keep line breaks here: services come one per line.
  const text = String(req.body.text || '').replace(/[ \t]+/g, ' ').trim().slice(0, 4000);
  const r = setup.applyAnswer(String(req.body.stepId || ''), text, req.body.profile || {});
  res.json(r);
});
app.post('/api/setup/text', rateLimit(20, 10 * 60 * 1000), wrap(async (req, res) => {
  const profile = await setup.profileFromText(String(req.body.text || '').slice(0, 4000));
  res.json({ profile });
}));
app.post('/api/setup/create', rateLimit(10, 10 * 60 * 1000), wrap(async (req, res) => {
  const b = setup.createBusiness(req.body.profile || {});
  res.json({
    business: { id: b.id, name: b.name, trade: b.trade, city: b.city, services: b.services, deposit: b.deposit, payoutEmail: b.payoutEmail },
    links: {
      text: `${config.publicUrl}/text?biz=${b.id}`,
      owner: `${config.publicUrl}/owner?biz=${b.id}`,
      agent: `${config.publicUrl}/agent?biz=${b.id}`,
      mcp: `${config.publicUrl}/mcp/${b.id}`,
    },
  });
}));

// ---------- connections: leads in from any app, calendar out, busy times in, updates out ----------
app.post('/api/leads/in/:bizId', express.urlencoded({ extended: true }), rateLimit(60, 10 * 60 * 1000), wrap(async (req, res) => {
  const business = B.businessById(req.params.bizId);
  if (!business) return res.status(404).json({ error: 'Unknown business' });
  const r = await connect.leadIn(business, req.body || {}, { source: String(req.query.source || '') });
  res.json({ ok: true, ...r });
}));
app.get('/calendar/:bizId.ics', (req, res) => {
  const business = B.businessById(req.params.bizId);
  if (!business) return res.status(404).send('Unknown business');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="${business.id}.ics"`, 'Cache-Control': 'no-cache' });
  res.send(connect.calendarFor(business));
});
app.get('/api/owner/connections', ownerOnly, (req, res) => {
  const business = B.currentBusiness();
  res.json({
    business: { id: business.id, name: business.name, custom: Boolean(business.custom) },
    leadInUrl: connect.leadInUrl(business),
    calendarUrl: connect.calendarUrl(business),
    busyCalendarUrl: business.busyCalendarUrl || '',
    webhookUrl: business.webhookUrl || '',
    webhookSecret: business.webhookSecret || '',
    payoutEmail: business.payoutEmail || '',
    mcpUrl: `${config.publicUrl}/mcp/${business.id}`,
  });
});
app.post('/api/owner/connections', ownerOnly, wrap(async (req, res) => {
  const business = B.currentBusiness();
  if (!business.custom) return res.status(400).json({ error: 'The demo businesses are read-only. Set up your own at /setup to connect apps.' });
  const url = (v) => (v && /^https?:\/\//.test(String(v)) ? String(v).trim().slice(0, 500) : '');
  const patch = { busyCalendarUrl: url(req.body.busyCalendarUrl), webhookUrl: url(req.body.webhookUrl), payoutEmail: String(req.body.payoutEmail || '').trim().slice(0, 120) };
  if (patch.webhookUrl && !business.webhookSecret) patch.webhookSecret = store.newId('whsec');
  store.saveBusiness({ ...business, ...patch });
  res.json({ ok: true });
}));

// ---------- owner ----------
app.get('/api/owner/state', ownerOnly, (req, res) => {
  const business = B.currentBusiness();
  res.json({
    business: { id: business.id, name: business.name, trade: business.trade },
    presets: B.listAllBusinesses().map((p) => ({ id: p.id, name: p.name, trade: p.trade, custom: !presets[p.id] })),
    summary: B.summary(),
    bookings: store.listBookings().slice(0, 50).map(publicBooking),
    leads: store.listLeads().slice(0, 50).map((l) => ({ id: l.id, name: l.name, status: l.status, presetId: l.presetId, needsOwner: Boolean(l.needsOwner), lastMessage: l.messages.at(-1) || null, firstReplyMs: l.firstReplyMs })),
    ownerThread: store.listOwnerMessages(),
    activity: store.listActivity().slice(0, 40),
    waitlist: store.listWaitlist().filter((w) => w.status !== 'done'),
    health: { paypal: paypalReady ? config.paypal.env : 'demo mode', ai: modelLabel() },
  });
});

app.post('/api/owner/text', ownerOnly, rateLimit(40, 10 * 60 * 1000), wrap(async (req, res) => {
  const text = cleanText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const reply = await ownerCommand(text);
  res.json({ reply });
}));

const ownerAction = (fn) => wrap(async (req, res) => res.json({ ok: true, result: await fn(req) }));
app.post('/api/owner/bookings/:id/remind', ownerOnly, ownerAction((req) => B.remind(req.params.id)));
app.post('/api/owner/bookings/:id/refund', ownerOnly, ownerAction((req) => B.refund(req.params.id, { amount: req.body.amount || null, reason: req.body.reason || 'Owner refund' })));
app.post('/api/owner/bookings/:id/done', ownerOnly, ownerAction((req) => B.markCompleted(req.params.id)));
app.post('/api/owner/bookings/:id/cancel', ownerOnly, ownerAction((req) => B.businessCancel(req.params.id, req.body.reason || '')));
app.post('/api/owner/bookings/:id/release', ownerOnly, ownerAction((req) => B.releaseHold(req.params.id, 'Released by the owner')));
app.post('/api/owner/bookings/:id/cash', ownerOnly, ownerAction((req) => B.recordOutsidePayment(req.params.id, { amount: Number(req.body.amount), method: req.body.method || 'cash' })));
app.post('/api/owner/rebook', ownerOnly, ownerAction(() => B.sendRebookNudges({ force: true })));

app.post('/api/owner/preset', ownerOnly, (req, res) => {
  if (!B.businessById(req.body.presetId)) return res.status(400).json({ error: 'Unknown business' });
  store.setPreset(req.body.presetId);
  res.json({ ok: true });
});
app.post('/api/owner/seed', ownerOnly, wrap(async (req, res) => res.json({ ok: true, ...(await seedSampleDay(B.currentBusiness())) })));
app.post('/api/owner/reset', ownerOnly, (req, res) => {
  store.resetAll();
  res.json({ ok: true });
});

// Dispute evidence file (printable).
app.get('/evidence/:bookingId', ownerOnly, (req, res) => res.sendFile(path.join(pub, 'evidence.html')));
app.get('/api/evidence/:bookingId', ownerOnly, (req, res) => {
  const e = B.evidence(req.params.bookingId);
  if (!e) return res.status(404).json({ error: 'Not found' });
  res.json(e);
});

// ---------- live updates (Server-Sent Events) ----------
app.get('/api/events', (req, res) => {
  const leadId = req.query.lead ? String(req.query.lead) : null;
  const owner = req.query.owner === '1' && (!config.ownerPasscode || req.query.code === config.ownerPasscode);
  if (!leadId && !owner) return res.status(400).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const send = (evt) => {
    if (owner) return res.write(`data: ${JSON.stringify({ kind: evt.kind })}\n\n`);
    if (evt.kind === 'message' && evt.payload.leadId === leadId) res.write(`data: ${JSON.stringify({ kind: 'message', msg: evt.payload.msg })}\n\n`);
    if (evt.kind === 'booking' && evt.payload.leadId === leadId) res.write(`data: ${JSON.stringify({ kind: 'booking' })}\n\n`);
  };
  store.events.on('change', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    store.events.off('change', send);
  });
});

connect.startPushing();

// ---------- background jobs ----------
setInterval(() => B.releaseStaleHolds().catch((e) => console.error('releaseStaleHolds', e.message)), 60 * 1000).unref();
setInterval(() => B.sendRebookNudges().catch((e) => console.error('rebook', e.message)), 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  console.log(`First Answer Deposits running on ${config.publicUrl}`);
  console.log(`PayPal: ${paypalReady ? config.paypal.env : 'demo mode (no keys)'} | AI: ${modelLabel()}`);
  checkModel().then((s) => s.checked && console.log(`AI check: ${s.ok ? 'working' : `FAILED (${s.error})`}`));
});

export default app;
