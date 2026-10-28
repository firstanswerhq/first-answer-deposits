// Who may run the owner side of a business.
//  - The built-in demo businesses (cleaning, detailing, hvac) stay open so anyone can try the owner page.
//  - A business set up at /setup gets an owner key, shown once in its owner link. Only that key (or the
//    server's OWNER_PASSCODE) can refund, change payout email or connections, or run its owner AI.
//  - Wiping the demo data (reset) is off unless ALLOW_RESET=1 or an OWNER_PASSCODE is set.
import crypto from 'node:crypto';
import { config } from './config.js';

export const newOwnerKey = () => crypto.randomBytes(18).toString('base64url');
export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// keys: the owner keys the browser holds (a page may hold several, one per business it set up).
export function ownerKeyOk(business, { keys = [], passcode = '' } = {}) {
  if (!business?.custom) return true;
  if (config.ownerPasscode && passcode === config.ownerPasscode) return true;
  if (!business.ownerKeyHash) return false; // set up before owner keys existed: only the passcode opens it
  return keys.some((k) => k && sameHash(hashKey(k), business.ownerKeyHash));
}

// Owner keys arrive in the x-owner-key header (comma separated) or ?key=; the passcode as before.
export function credsFrom(req) {
  const raw = [req.get('x-owner-key') || '', String(req.query.key || '')].join(',');
  return {
    keys: raw.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 10),
    passcode: req.get('x-owner-passcode') || String(req.query.code || ''),
  };
}

export function resetAllowed() {
  return process.env.ALLOW_RESET === '1' || Boolean(config.ownerPasscode);
}

// Enough to recognize a secret, never enough to use it.
export function maskSecret(s) {
  return s ? `${String(s).slice(0, 6)}…${String(s).slice(-4)}` : '';
}
