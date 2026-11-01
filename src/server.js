import express from 'express';
import { visitorMiddleware } from './visitor.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paypalReady, aiReady } from './config.js';
import * as store from './store.js';
import * as B from './bookings.js';
import * as paypal from './paypal.js';
import { presets, defaultPresetId } from './business.js';
import { replyToCustomer } from './agent/customer.js';
import { ownerCommand } from './agent/owner.js';
import { modelLabel, checkModel, aiStatus } from './agent/model.js';
import * as setup from './setup.js';
import * as connect from './connect.js';
import { seedSampleDay, seedIfEmpty, resetBusinessDemo } from './seed.js';
import { mountAgentic } from './agentic/index.js';
import { checkPublicUrl } from './safe-fetch.js';
import { newOwnerKey, hashKey, ownerKeyOk, credsFrom, resetAllowed, maskSecret } from './owner-auth.js';
import { makeRateLimiter } from './client-ip.js';
import { cleanLogoUrl } from './setup.js';

const app = express();
// Render (and most hosts) sit behind one proxy: trust it. On Render that proxy is Cloudflare, so rate limits
// key on Cloudflare's visitor header instead (see client-ip.js).
app.set('trust proxy', 1);
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
app.use(visitorMiddleware);
mountAgentic(app);
app.use(express.static(pub, { extensions: ['html'] }));

// ---------- small helpers ----------
const rateLimit = makeRateLimiter();
const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
const ownerOnly = (req, res, next) => {
  if (!config.ownerPasscode) return next();
  if (req.get('x-owner-passcode') === config.ownerPasscode || req.query.code === config.ownerPasscode) return next();
  res.status(401).json({ error: 'Owner passcode required.' });
};
// A business set up at /setup is managed only with its owner key (see owner-auth.js); demo businesses stay open.
const denyOwner = (res) => res.status(403).json({ error: 'This business belongs to its owner. Open the owner page with the owner link from setup.' });
// Each owner page names the business it is showing on every request (x-biz header or ?biz=), so one visitor
// picking a business in the dropdown never changes anyone else's page. Nothing names one: the default demo
// business. A set-up business is used only with its owner key; without it the request gets the default demo one.
const ownerScope = (req, res, next) => {
  const named = B.businessById(String(req.get('x-biz') || req.query.biz || '').trim().slice(0, 80));
  const business = named && ownerKeyOk(named, credsFrom(req)) ? named : presets[defaultPresetId];
  return B.withBusiness(business, next);
};
// Owner action results never carry a booking's manage key.
const noSecrets = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x, (k, v) => (k === 'secret' ? undefined : v))));
const ownerOfCurrent = (req, res, next) => (ownerKeyOk(B.currentBusiness(), credsFrom(req)) ? next() : denyOwner(res));
const ownerOfBooking = (req, res, next) => {
  const b = store.getBooking(String(req.params.id || req.params.bookingId || ''));
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  return ownerKeyOk(B.businessOf(b), credsFrom(req)) ? next() : denyOwner(res);
};
// What the owner page may show: everything from demo businesses, and a set-up business only to its owner.
const canSee = (req) => {
  const creds = credsFrom(req);
  return (x) => {
    const presetId = x?.presetId || (x?.bookingId && store.getBooking(x.bookingId)?.presetId) || (x?.leadId && store.getLead(x.leadId)?.presetId);
    const biz = presetId ? B.businessById(presetId) : null;
    return !biz || ownerKeyOk(biz, creds);
  };
};
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// What customer pages need to look like the business: its color and logo, plus the "powered by" line.
function brandOf(business) {
  return { color: business.brand?.color || '', logoUrl: business.brand?.logoUrl || '', poweredBy: 'First Answer' };
}

function publicBooking(b) {
  if (!b) return null;
  const business = B.businessOf(b);
  return {
    id: b.id,
    business: { name: business.name, trade: business.trade, city: business.city, brand: brandOf(business) },
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
    // What is owed right now: the deposit while a booking is held, the balance after that.
    owedNow: B.owedNow(b),
    hold: B.totals(b).onHold > 0 ? `${B.usd(B.totals(b).onHold)} held in PayPal` : '',
    bookedBy: b.bookedBy || null,
    assistantLimit: b.mandate ? { limit: b.mandate.limit, spent: b.mandate.spent || 0, status: b.mandate.status, simulated: Boolean(b.mandate.demo) } : null,
    disputes: (b.disputes || []).map((d) => ({ id: d.id, status: d.status, detail: d.detail, at: d.at })),
    freeCancelUntil: B.freeCancelLabel(b),
    changes: b.changes,
    payments: b.payments.map((p) => ({ id: p.id, label: p.label, kind: p.kind, amount: p.amount, tip: p.tip || 0, status: p.status, via: p.via || p.mode || null, refund: p.refund || null, at: p.completedAt || p.createdAt })),
    // Customer-visible: never a PayPal vault id (older records named it in the timeline).
    timeline: b.timeline.map((t) => ({ ...t, text: String(t.text).replace(/\s*\(vault [^)]*\)/gi, '').replace(/\b(?:DEMO-)?VAULT-[A-Za-z0-9-]+/g, 'saved wallet') })),
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
  // No business named: the default demo one, never whichever business someone opened last.
  const presetId = B.businessById(req.body.presetId) ? req.body.presetId : defaultPresetId;
  const lead = store.createLead({ channel: req.body.channel || 'text', presetId, phone: req.body.phone || '' });
  if (req.visitorId) store.updateLead(lead.id, { visitorId: req.visitorId });
  res.json({ leadId: lead.id, business: B.businessById(presetId).name, brand: brandOf(B.businessById(presetId)) });
}));

app.get('/api/text/:leadId', (req, res) => {
  const lead = store.getLead(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json({ leadId: lead.id, business: B.businessOf(lead).name, brand: brandOf(B.businessOf(lead)), messages: lead.messages });
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
    payment: { id: payment.id, label: payment.label, kind: payment.kind, amount: payment.amount, status: payment.status, tip: payment.tip || 0, expectedPayer: payment.expectedPayer || null, intent: payment.status === 'pending' ? B.intentFor(booking, payment) : payment.intent || 'capture', held: payment.hold?.status || null },
    // A deposit on a booking an AI assistant made: the customer may also let that assistant pay the final bill,
    // up to a limit they choose (PayPal saves their wallet with consent).
    mandateOffer: payment.status === 'pending' && payment.kind === 'deposit' && booking.source === 'agent' ? { agent: booking.bookedBy || 'your AI assistant', suggested: Math.max(10, Math.ceil((B.totals(booking).total - booking.deposit) * 1.2 / 10) * 10), max: B.MANDATE_MAX } : null,
    booking: publicBooking(booking),
    leadId: booking.leadId,
    bookingUrl: B.bookingPageUrl(booking),
    paypal: paypalReady ? { clientId: config.paypal.clientId, env: config.paypal.env } : null,
  });
});

app.post('/api/pay/:paymentId/order', rateLimit(30, 10 * 60 * 1000), wrap(async (req, res) => {
  // checkoutFor drops any tip on a deposit: tips go on the final bill only.
  const r = await B.checkoutFor(req.params.paymentId, { tip: B.clampTip(req.body.tip), redirect: Boolean(req.body.redirect), mandate: req.body.mandate || null });
  if (r.paid) return res.json({ paid: true });
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.demo) return res.json({ demo: true });
  res.json({ orderId: r.orderId, url: r.url });
}));

app.post('/api/pay/:paymentId/capture', wrap(async (req, res) => {
  const found = store.findPayment(req.params.paymentId);
  if (!found) return res.status(404).json({ error: 'Not found' });
  // A canceled or refunded booking's link takes no money.
  if (found.payment.status !== 'completed') {
    const why = B.notPayable(found.booking, found.payment);
    if (why) return res.status(400).json({ error: why });
  }
  if (!paypalReady) {
    // Demo checkout only exists when the host has no PayPal keys. Same 0 to $500 tip rule as the order route,
    // and only on the final bill: a deposit takes no tip.
    if (found.payment.status === 'pending') B.completeDemoPayment(found.payment.id, { tip: B.tipFor(found.payment, req.body.tip), mandate: req.body.mandate || null });
  } else {
    // Capture the order the buyer approved, and only if this payment made it.
    const orderId = req.body.orderID ? String(req.body.orderID) : null;
    if (orderId && !B.orderBelongs(found.payment, orderId)) return res.status(400).json({ error: 'That PayPal order is not for this payment.' });
    await B.syncPayment(found.payment.id, { orderId });
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
  const found = store.findPayment(id);
  // PayPal puts the approved order ID in ?token=. Use it only if it belongs to this payment.
  const token = String(req.query.token || '');
  if (found) await B.syncPayment(id, { orderId: B.orderBelongs(found.payment, token) ? token : null }).catch((e) => console.error(e.message));
  res.redirect(`/p/${encodeURIComponent(id)}?done=1`);
}));
app.get('/pay/cancel', (req, res) => res.redirect(`/p/${encodeURIComponent(String(req.query.payment || ''))}?canceled=1`));

// ---------- customer booking page (receipt, record) ----------
app.get('/b/:bookingId', (req, res) => res.sendFile(path.join(pub, 'booking.html')));
app.get('/api/booking/:bookingId', (req, res) => {
  const b = store.getBooking(req.params.bookingId);
  // The view key opens the page; links texted before view keys existed carried the manage key, so it still works here.
  const k = String(req.query.k || '');
  if (!b || !k || (k !== B.viewKeyOf(b) && k !== b.secret)) return res.status(404).json({ error: 'Not found' });
  const open = b.payments.find((p) => p.status === 'pending');
  res.json({ booking: publicBooking(b), payLink: open ? B.payPageUrl(open) : null });
});

// ---------- setup by text (any business, in a minute) ----------
app.get('/api/setup/steps', (req, res) => res.json({ steps: setup.STEPS, intro: setup.introLine(), ai: Boolean(modelLabel() && aiReady) }));
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
  // The owner key is shown once, here, inside the owner link. Only its hash is stored.
  const ownerKey = newOwnerKey();
  const b = setup.createBusiness(req.body.profile || {}, { ownerKeyHash: hashKey(ownerKey) });
  res.json({
    business: { id: b.id, name: b.name, trade: b.trade, city: b.city, services: b.services, deposit: b.deposit, payoutEmail: b.payoutEmail },
    ownerKey,
    links: {
      text: `${config.publicUrl}/text?biz=${b.id}`,
      owner: `${config.publicUrl}/owner?biz=${b.id}&key=${ownerKey}`,
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
app.use(['/api/owner', '/api/evidence'], ownerScope);
app.get('/api/owner/connections', ownerOnly, (req, res) => {
  const business = B.currentBusiness();
  // A set-up business's private links and payout email are shown only to its owner. The webhook signing
  // secret is never sent in full after it is first made (see the POST below).
  const mine = ownerKeyOk(business, credsFrom(req));
  res.json({
    business: { id: business.id, name: business.name, custom: Boolean(business.custom) },
    locked: !mine,
    leadInUrl: connect.leadInUrl(business),
    calendarUrl: connect.calendarUrl(business),
    busyCalendarUrl: mine ? business.busyCalendarUrl || '' : '',
    webhookUrl: mine ? business.webhookUrl || '' : '',
    webhookSecret: mine ? maskSecret(business.webhookSecret) : '',
    payoutEmail: mine ? business.payoutEmail || '' : '',
    brand: brandOf(business),
    mcpUrl: `${config.publicUrl}/mcp/${business.id}`,
  });
});
app.post('/api/owner/connections', ownerOnly, ownerOfCurrent, wrap(async (req, res) => {
  const business = B.currentBusiness();
  if (!business.custom) return res.status(400).json({ error: 'The demo businesses are read-only. Set up your own at /setup to connect apps.' });
  // These two links are fetched by the server, so they must be https and point at the public internet.
  const fetched = {};
  for (const [field, label] of [['busyCalendarUrl', 'busy calendar'], ['webhookUrl', 'webhook']]) {
    const v = String(req.body[field] || '').trim().slice(0, 500);
    if (!v) {
      fetched[field] = '';
      continue;
    }
    try {
      fetched[field] = (await checkPublicUrl(v)).toString();
    } catch (err) {
      return res.status(400).json({ error: `The ${label} link: ${err.message}` });
    }
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(req.body.brandColor || '')) ? String(req.body.brandColor).toLowerCase() : '';
  const patch = {
    busyCalendarUrl: fetched.busyCalendarUrl,
    webhookUrl: fetched.webhookUrl,
    payoutEmail: String(req.body.payoutEmail || '').trim().slice(0, 120),
    brand: { color, logoUrl: cleanLogoUrl(req.body.logoUrl) },
  };
  // A new webhook address gets a new signing secret, shown in full this one time.
  const freshSecret = patch.webhookUrl && (!business.webhookSecret || patch.webhookUrl !== business.webhookUrl);
  if (freshSecret) patch.webhookSecret = store.newId('whsec');
  store.saveBusiness({ ...business, ...patch });
  res.json({ ok: true, ...(freshSecret ? { webhookSecret: patch.webhookSecret } : {}) });
}));

// ---------- owner ----------
app.get('/api/owner/state', ownerOnly, (req, res) => {
  const business = B.currentBusiness();
  const visible = canSee(req);
  // Lists show only the business this page is on, like the KPIs. Items tied to no business (none today) still show.
  const shown = (x) => {
    const presetId = x?.presetId || (x?.bookingId && store.getBooking(x.bookingId)?.presetId) || (x?.leadId && store.getLead(x.leadId)?.presetId);
    return !presetId || presetId === business.id;
  };
  res.json({
    business: { id: business.id, name: business.name, trade: business.trade },
    presets: B.listAllBusinesses().map((p) => ({ id: p.id, name: p.name, trade: p.trade, custom: !presets[p.id] })),
    summary: B.summary({ presetId: business.id }),
    resetAllowed: resetAllowed(),
    bookings: store.listBookings().filter((b) => B.businessOf(b).id === business.id).filter(visible).slice(0, 50).map(publicBooking),
    leads: store.listLeads().filter((l) => B.businessOf(l).id === business.id).filter(visible).slice(0, 50).map((l) => ({ id: l.id, name: l.name, status: l.status, presetId: l.presetId, needsOwner: Boolean(l.needsOwner), lastMessage: l.messages.at(-1) || null, firstReplyMs: l.firstReplyMs })),
    ownerThread: store.listOwnerMessages(business.id).filter(visible),
    activity: store.listActivity().filter(shown).filter(visible).slice(0, 40),
    waitlist: store.listWaitlist().filter((w) => w.status !== 'done').filter(shown).filter(visible),
    health: { paypal: paypalReady ? config.paypal.env : 'demo mode', ai: modelLabel() },
  });
});

app.post('/api/owner/text', ownerOnly, ownerOfCurrent, rateLimit(40, 10 * 60 * 1000), wrap(async (req, res) => {
  const text = cleanText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const reply = await ownerCommand(text, { visitorId: req.visitorId || null });
  res.json({ reply });
}));

// Owner actions throw plain-words errors (nothing owed, bad amount...): those are the owner's to fix, so 400.
const ownerAction = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, result: noSecrets(await fn(req)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
app.post('/api/owner/bookings/:id/remind', ownerOnly, ownerOfBooking, ownerAction((req) => B.remind(req.params.id)));
app.post('/api/owner/bookings/:id/refund', ownerOnly, ownerOfBooking, ownerAction((req) => B.refund(req.params.id, { amount: req.body.amount ?? null, reason: String(req.body.reason || 'Owner refund').slice(0, 200) })));
app.post('/api/owner/bookings/:id/done', ownerOnly, ownerOfBooking, ownerAction((req) => B.markCompleted(req.params.id)));
app.post('/api/owner/bookings/:id/cancel', ownerOnly, ownerOfBooking, ownerAction((req) => B.businessCancel(req.params.id, req.body.reason || '')));
app.post('/api/owner/bookings/:id/release', ownerOnly, ownerOfBooking, ownerAction((req) => B.releaseHold(req.params.id, 'Released by the owner')));
app.post('/api/owner/bookings/:id/cash', ownerOnly, ownerOfBooking, ownerAction((req) => B.recordOutsidePayment(req.params.id, { amount: Number(req.body.amount), method: String(req.body.method || 'cash') })));
// Demo servers only (no PayPal keys): play a PayPal dispute on a paid booking so the owner can watch the AI send
// the evidence file. With keys, disputes arrive from PayPal's CUSTOMER.DISPUTE.CREATED webhook instead.
app.post('/api/owner/bookings/:id/demo-dispute', ownerOnly, ownerOfBooking, ownerAction(async (req) => {
  if (paypalReady) throw new Error('This server has PayPal keys: real disputes come in from PayPal, so there is no practice dispute here.');
  const b = store.getBooking(req.params.id);
  // Disputes happen on captured money only: a deposit still on hold was never charged.
  const t = B.totals(b);
  const captured = Math.round((t.paid - t.onHold) * 100) / 100;
  if (!(captured > 0)) throw new Error(t.onHold > 0 ? `${b.customerName}'s deposit is a hold on their PayPal, not a charge, so there is nothing to dispute yet.` : `${b.customerName} hasn't paid anything, so there is nothing to dispute.`);
  return B.defendDispute(b.id, { disputeId: `DEMO-DISPUTE-${b.id.slice(-5).toUpperCase()}`, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amount: captured, demo: true });
}));
app.post('/api/owner/rebook', ownerOnly, ownerOfCurrent, ownerAction(() => B.sendRebookNudges({ force: true, presetId: B.currentBusiness().id })));

// Kept for older pages: checks that this browser may open the business. It no longer changes a saved setting;
// the page sends the business it shows on every request instead (see ownerScope).
app.post('/api/owner/preset', ownerOnly, (req, res) => {
  const target = B.businessById(req.body.presetId);
  if (!target) return res.status(400).json({ error: 'Unknown business' });
  if (!ownerKeyOk(target, credsFrom(req))) return denyOwner(res);
  res.json({ ok: true, business: { id: target.id, name: target.name } });
});
app.post('/api/owner/seed', ownerOnly, ownerOfCurrent, wrap(async (req, res) => res.json({ ok: true, ...(await seedSampleDay(B.currentBusiness())) })));
// Clears only this business's demo data (and reloads its sample day). Demo businesses are open to try; a set-up
// business only to its owner. Wiping every business at once stays behind resetAllowed() below.
app.post('/api/owner/reset-business', ownerOnly, ownerOfCurrent, rateLimit(20, 10 * 60 * 1000), wrap(async (req, res) => res.json({ ok: true, ...(await resetBusinessDemo(B.currentBusiness(), { visitorId: req.visitorId })) })));
app.post('/api/owner/reset', ownerOnly, (req, res) => {
  // Anyone can open the hosted demo, so wiping everyone's demo data is off unless the host turns it on.
  if (!resetAllowed()) return res.status(403).json({ error: 'Starting over is turned off on this server. (The host can set ALLOW_RESET=1.)' });
  store.resetAll();
  res.json({ ok: true });
});

// Dispute evidence file (printable).
app.get('/evidence/:bookingId', ownerOnly, (req, res) => res.sendFile(path.join(pub, 'evidence.html')));
app.get('/api/evidence/:bookingId', ownerOnly, ownerOfBooking, (req, res) => {
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
setInterval(() => B.settleExpiringHolds().catch((e) => console.error('settleExpiringHolds', e.message)), 10 * 60 * 1000).unref();
setInterval(() => B.reconcileInvoices().catch((e) => console.error('reconcileInvoices', e.message)), 5 * 60 * 1000).unref();
setInterval(() => B.sendRebookNudges().catch((e) => console.error('rebook', e.message)), 60 * 60 * 1000).unref();

// Tests import the app and listen on their own port (FAD_NO_LISTEN=1).
if (process.env.FAD_NO_LISTEN !== '1') {
  app.listen(config.port, () => {
    console.log(`First Answer Deposits running on ${config.publicUrl}`);
    seedIfEmpty(presets[defaultPresetId])
      .then((r) => r.bookings && console.log(`Loaded the sample day for ${presets[defaultPresetId].name} (empty data store).`))
      .catch((e) => console.error('sample day', e.message));
    console.log(`PayPal: ${paypalReady ? config.paypal.env : 'demo mode (no keys)'} | AI: ${modelLabel()}`);
    checkModel().then((s) => s.checked && console.log(`AI check: ${s.ok ? 'working' : `FAILED (${s.error})`}`));
  });
}

export default app;
