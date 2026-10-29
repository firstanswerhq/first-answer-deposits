// The two-step gate in front of every owner action that moves money or closes a job early (refunds, no-shows,
// marking a job done before its time). Shared by the AI office manager and its scripted fallback.
//
// The question names the exact amount, and the pending question keeps that amount plus a fingerprint of the
// booking (status, money, payments). A YES runs the action only if the booking is still exactly what the owner
// was asked about; if anything changed in between (the customer paid, another refund went out), the owner is asked
// again with the new numbers. The AI path also needs the YES to be its own owner message, sent after the question.
import * as store from '../store.js';
import * as B from '../bookings.js';

// Loose YES for the scripted desk (the reply to the question it just asked); strict YES for the AI gate.
export const YES = /^\s*(yes|y|yep|yeah|yup|confirm|confirmed|do it|go ahead|ok|okay|sure)\b/i;
export const STRICT_YES = /^\s*(yes|y|yes please|yes,? do it|yes,? go ahead|confirm|confirmed)\s*[.!]*\s*$/i;

// What the booking looks like for money purposes. Any change here means the question is out of date.
export function fingerprint(b) {
  const t = B.totals(b);
  return [b.status, b.slotStart, t.total, t.paid, t.tips, t.onHold, ...b.payments.map((p) => `${p.id}:${p.status}:${p.amount}:${p.tip || 0}:${p.refund?.amount || 0}:${p.refund?.tip || 0}:${p.hold?.status || ''}`)].join('|');
}

// The exact question (and the exact amount it names) for an action, or null when no question is needed.
export function questionFor(action, b, amount = null) {
  if (action === 'refund') {
    const t = B.totals(b);
    const full = amount === null || amount === undefined;
    const exact = full ? Math.round((t.paid + t.tips) * 100) / 100 : amount;
    const what = full && t.tips > 0 ? ` (${B.usd(t.paid)} paid plus the ${B.usd(t.tips)} tip)` : full ? '' : ` of the ${B.usd(t.paid)} paid`;
    return { exact, text: `Refund ${B.usd(exact)}${what} to ${b.customerName}? Reply YES to send it back the way they paid, or NO.` };
  }
  if (action === 'no_show') {
    const kept = B.totals(b).depositPaid;
    return { exact: kept, text: `Mark ${b.customerName} as a no-show for ${b.slotLabel}? Per the terms they agreed to, the ${B.usd(kept)} deposit is kept. Reply YES or NO.` };
  }
  if (action === 'done' && Date.parse(b.slotStart) > Date.now()) {
    return { exact: null, text: `${b.customerName}'s appointment is ${b.slotLabel}, which hasn't happened yet. Mark it done now and text the final bill anyway? Reply YES or NO.` };
  }
  return null;
}

// Saves the question as this business's pending one and returns its text.
export function ask(businessId, action, b, amount = null, q = questionFor(action, b, amount)) {
  store.setOwnerPending(businessId, { kind: 'confirm', action, bookingId: b.id, amount: amount ?? null, exact: q?.exact ?? null, question: q?.text || '', fingerprint: fingerprint(b) });
  return q?.text || '';
}

// After a YES: 'go' when the booking is unchanged; otherwise the new question (already saved as pending).
export function recheck(businessId, pending, b) {
  const q = questionFor(pending.action, b, pending.amount);
  const sameMoney = (q?.exact ?? null) === (pending.exact ?? null);
  if (pending.fingerprint === fingerprint(b) && sameMoney) return { go: true };
  if (!q) return { go: true }; // e.g. the appointment time has now passed, so marking it done needs no question
  const text = ask(businessId, pending.action, b, pending.amount, q);
  return { go: false, question: `Heads up: ${b.customerName}'s booking changed since I asked (it's now ${B.STATUS_WORDS[b.status].toLowerCase()}, ${B.usd(B.totals(b).paid)} paid). ${text}` };
}

// True when the owner's latest message came after the pending question and is a plain YES.
export function ownerSaidYesAfter(businessId, pending) {
  const last = store.listOwnerMessages(businessId).filter((m) => m.role === 'owner').at(-1);
  return Boolean(last && (last.seq || 0) > (pending.afterSeq || 0) && STRICT_YES.test(last.text || ''));
}
