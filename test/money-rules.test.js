// Money rules and security checks (cancel windows, payouts, refund amounts, capture ownership, view-only links, safe URLs, setup profiles), all in demo mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-review-${process.pid}.json`);
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');

async function bookPaid(name = 'Sarah', { presetId = 'cleaning', slot = 0 } = {}) {
  const lead = store.createLead({ presetId });
  const biz = B.businessOf(lead);
  const s = B.availableSlots(biz, { limit: slot + 1 })[slot];
  const svc = biz.services[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: svc.id, size: Object.keys(svc.sizes)[0], slotStart: s.start, customerName: name });
  B.completeDemoPayment(booking.payments[0].id);
  return store.getBooking(booking.id);
}

test('customers can only cancel a held or confirmed booking (no refund after the job is paid)', async () => {
  store.resetAll();
  const b = await bookPaid('Pia');
  await B.markCompleted(b.id);
  const bal = store.getBooking(b.id).payments.find((p) => p.kind === 'balance' && p.status === 'pending');
  B.completeDemoPayment(bal.id);
  assert.equal(store.getBooking(b.id).status, 'paid_in_full');
  const paidBefore = B.totals(store.getBooking(b.id)).paid;
  await assert.rejects(B.customerCancel(b.id), /can't be canceled/);
  assert.equal(store.getBooking(b.id).status, 'paid_in_full');
  assert.equal(B.totals(store.getBooking(b.id)).paid, paidBefore);

  // Job done with a balance open: also not cancelable by the customer.
  const c = await bookPaid('Cy', { slot: 1 });
  await B.markCompleted(c.id);
  await assert.rejects(B.customerCancel(c.id), /can't be canceled/);
  assert.equal(store.getBooking(c.id).status, 'completed');

  // A held or confirmed booking still cancels as before.
  const d = await bookPaid('Dot', { slot: 2 });
  const r = await B.customerCancel(d.id);
  assert.ok(['refunded', 'kept_deposit'].includes(r.outcome));
});

test('payouts count only PayPal money; cash is capped at what is owed and must be positive', async () => {
  store.resetAll();
  const b = await bookPaid('Cash'); // $50 deposit through (demo) PayPal
  const total = B.totals(b).total;
  await B.markCompleted(b.id);
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: -500, method: 'cash' }), /amount/);
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: 'abc', method: 'cash' }), /amount/);
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: 0, method: 'cash' }), /amount/);
  const after = B.recordOutsidePayment(b.id, { amount: 1000000, method: 'paypal' });
  const cash = after.payments.at(-1);
  assert.equal(cash.amount, total - 50, 'capped at the balance still due');
  assert.equal(cash.mode, 'outside');
  assert.equal(cash.method, 'other', 'cannot pretend to be a PayPal payment');
  assert.equal(after.status, 'paid_in_full');
  assert.equal(B.totals(after).paid, total);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getBooking(b.id).payout.amount, 50, 'only the PayPal deposit is paid out, never the cash');
  assert.throws(() => B.recordOutsidePayment(b.id, { amount: 10 }), /doesn't owe anything/);
});

test('refund amounts must be a number above zero and no more than was paid', async () => {
  store.resetAll();
  const b = await bookPaid('Ref');
  await assert.rejects(B.refund(b.id, { amount: 'abc' }), /above \$0/);
  await assert.rejects(B.refund(b.id, { amount: NaN }), /above \$0/);
  await assert.rejects(B.refund(b.id, { amount: 0 }), /above \$0/);
  await assert.rejects(B.refund(b.id, { amount: -5 }), /above \$0/);
  await assert.rejects(B.refund(b.id, { amount: 51 }), /most you can refund is \$50/);
  assert.equal(B.totals(store.getBooking(b.id)).refunded, 0, 'nothing moved on a bad amount');
  const part = await B.refund(b.id, { amount: '20' });
  assert.equal(part.refunded, 20);
  const rest = await B.refund(b.id, {});
  assert.equal(rest.refunded, 30);
  assert.equal(store.getBooking(b.id).status, 'refunded');
});

test('capture only accepts an order made for this payment; demo tips are clamped to 0..500', async () => {
  store.resetAll();
  const lead = store.createLead({ presetId: 'cleaning' });
  const s = B.availableSlots(B.currentBusiness(), { limit: 1 })[0];
  const { booking } = await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'standard', size: '3 bedrooms', slotStart: s.start, customerName: 'Ord' });
  const pay = booking.payments[0];
  // Pretend two PayPal orders were made for this payment (tip changed once).
  store.updatePayment(pay.id, { mode: 'paypal', orderId: 'ORDER-2', orders: [{ id: 'ORDER-1', tip: 0 }, { id: 'ORDER-2', tip: 10 }] });
  const p = store.findPayment(pay.id).payment;
  assert.ok(B.orderBelongs(p, 'ORDER-1'));
  assert.ok(B.orderBelongs(p, 'ORDER-2'));
  assert.ok(!B.orderBelongs(p, 'SOMEONE-ELSES-ORDER'));
  await assert.rejects(B.syncPayment(pay.id, { orderId: 'SOMEONE-ELSES-ORDER' }), /not for this payment/);
  assert.equal(store.findPayment(pay.id).payment.status, 'pending');
  assert.equal(B.findPaymentByOrder('ORDER-1').payment.id, pay.id);

  // Demo checkout: a negative or silly tip never lands on the record.
  assert.equal(B.clampTip(-50), 0);
  assert.equal(B.clampTip('abc'), 0);
  assert.equal(B.clampTip(9999), 500);
  assert.equal(B.clampTip('12.345'), 12.35);
  const b2 = await bookPaid('Tip', { slot: 1 });
  await B.markCompleted(b2.id);
  const bal = store.getBooking(b2.id).payments.find((x) => x.kind === 'balance' && x.status === 'pending');
  B.completeDemoPayment(bal.id, { tip: -100 });
  const done = store.getBooking(b2.id);
  assert.equal(B.totals(done).tips, 0);
  assert.equal(done.status, 'paid_in_full');
});

test('the booking page link is view-only: it never carries the manage key that can cancel', async () => {
  store.resetAll();
  const b = await bookPaid('View');
  const url = B.bookingPageUrl(b);
  assert.ok(b.viewKey && b.viewKey !== b.secret);
  assert.ok(url.endsWith(`?k=${b.viewKey}`));
  assert.ok(!url.includes(b.secret));
  // Older bookings without a view key get one, still not the secret.
  store.updateBooking(b.id, { viewKey: undefined });
  const again = B.bookingPageUrl(store.getBooking(b.id));
  const vk = store.getBooking(b.id).viewKey;
  assert.ok(vk && vk !== b.secret && again.endsWith(`?k=${vk}`));
});

test('owner-entered links are fetched only over https and never to internal addresses', async () => {
  const { checkPublicUrl, safeFetch, isInternalIp } = await import('../src/safe-fetch.js');
  const dnsTable = { 'cal.example': ['93.184.216.34'], 'sneaky.example': ['93.184.216.34', '10.0.0.7'], 'rebind.example': ['127.0.0.1'] };
  const lookup = async (host) => {
    if (!dnsTable[host]) throw new Error('ENOTFOUND');
    return dnsTable[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  for (const bad of [
    'http://cal.example/x.ics',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.1.10/x',
    'https://172.20.0.1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://sneaky.example/x',
    'https://rebind.example/x',
    'file:///etc/passwd',
    'not a url',
  ]) await assert.rejects(checkPublicUrl(bad, { lookup }), Error, bad);
  assert.equal((await checkPublicUrl('https://cal.example/private.ics', { lookup })).hostname, 'cal.example');
  assert.ok(isInternalIp('100.64.0.1'));
  assert.ok(!isInternalIp('8.8.8.8'));

  // A redirect to an internal address is refused too.
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    return { status: 302, headers: { get: (h) => (h === 'location' ? 'https://169.254.169.254/latest' : null) } };
  };
  await assert.rejects(safeFetch('https://cal.example/x.ics', {}, { lookup, fetchImpl }), /private or internal/);
  assert.equal(calls, 1);
});

test('setup profiles are checked on the server: plain-text names, positive prices, sane deposit', async () => {
  const S = await import('../src/setup.js');
  const good = { name: 'Bright Windows', trade: 'window washing', city: 'Nashville, TN', services: [{ id: 'basic', name: 'Basic wash', sizes: { standard: 90 } }], deposit: { type: 'flat', amount: 25 }, payoutEmail: 'pay@bright.example' };
  const xss = S.createBusiness({ ...good, name: '<img src=x onerror=alert(1)>Bright', city: 'Nash<script>ville', services: [{ id: '"><svg onload=alert(1)>', name: '<b>Wash</b>', sizes: { '<i>big</i>': 120 } }] });
  for (const v of [xss.name, xss.city, xss.services[0].name, xss.services[0].id, ...Object.keys(xss.services[0].sizes)]) assert.ok(!/[<>"]/.test(v), v);
  assert.ok(!/[^a-z0-9-]/.test(xss.id), 'id is a plain slug');
  assert.throws(() => S.createBusiness({ ...good, services: [{ name: 'Wash', sizes: { standard: -10 } }] }), /above \$0/);
  assert.throws(() => S.createBusiness({ ...good, services: [{ name: 'Wash', sizes: { standard: 'free' } }] }), /above \$0/);
  assert.throws(() => S.createBusiness({ ...good, deposit: { type: 'flat', amount: -50 } }), /deposit/);
  assert.throws(() => S.createBusiness({ ...good, deposit: { type: 'percent', percent: 500 } }), /percent/);
  assert.throws(() => S.createBusiness({ ...good, payoutEmail: 'not-an-email' }), /payout email/);
  assert.throws(() => S.createBusiness({ ...good, name: 'x'.repeat(1) }), /call your business/);
  const long = S.createBusiness({ ...good, name: 'N'.repeat(500), brand: { color: 'red;background:url(x)', logoUrl: 'javascript:alert(1)' } });
  assert.ok(long.name.length <= 80);
  assert.deepEqual(long.brand, { color: '', logoUrl: '' });
  const none = S.createBusiness({ ...good, deposit: { type: 'flat', amount: 0 } });
  assert.equal(none.deposit.amount, 0, '"no deposit" still works');
});
