// Who is calling, for rate limits. Render sits behind Cloudflare, so req.ip (with trust proxy 1) is a
// Cloudflare edge address shared by many visitors. Cloudflare sets cf-connecting-ip / true-client-ip to the real
// visitor and overwrites any value the visitor sends. x-forwarded-for's first entry is the fallback.
// Those headers are believed only when the connection came from Cloudflare or from the host's own internal
// network; a visitor who connects directly keeps being limited by their own address, exactly as before.
import net from 'node:net';
import { isInternalIp } from './safe-fetch.js';

const header = (req, name) => String(req.get?.(name) || req.headers?.[name] || '').trim();

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/).
const cloudflare = new net.BlockList();
for (const c of ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']) {
  const [a, b] = c.split('/');
  cloudflare.addSubnet(a, Number(b), 'ipv4');
}
const cloudflare6 = new net.BlockList();
for (const c of ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']) {
  const [a, b] = c.split('/');
  cloudflare6.addSubnet(a, Number(b), 'ipv6');
}
const plain = (ip) => String(ip || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
export function fromTrustedProxy(ip) {
  const a = plain(ip);
  const v = net.isIP(a);
  if (!v) return false;
  return (v === 4 ? cloudflare.check(a, 'ipv4') : cloudflare6.check(a, 'ipv6')) || isInternalIp(a);
}

export function clientIp(req) {
  const conn = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!fromTrustedProxy(conn)) return conn;
  for (const v of [header(req, 'cf-connecting-ip'), header(req, 'true-client-ip'), header(req, 'x-forwarded-for').split(',')[0].trim()]) {
    // Only a real IP counts: junk values can't make endless new keys.
    if (v && net.isIP(v)) return v;
  }
  return conn;
}

// A limiter keyed on the visitor. Those headers can be faked where no Cloudflare sits in front, so a second,
// much looser bucket keyed on the connecting address (req.ip) caps what one source can do by rotating fake IPs:
// at most `backstop` times the normal limit, per route, per window.
// The visitor's own bucket is checked first, and the shared backstop is charged only for requests that pass it.
// So one visitor hammering a route is stopped by their own limit and never uses up the bucket that everyone
// coming through the same proxy address shares. The backstop is sized so ordinary visitors never reach it.
export function makeRateLimiter({ backstop = 50, onLimit } = {}) {
  const hits = new Map();
  const take = (key, max, windowMs, now) => {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  };
  const limit = (max, windowMs, scope = (req) => `${req.baseUrl}${req.route?.path || ''}`) => (req, res, next) => {
    const now = Date.now();
    if (hits.size > 20000) hits.clear();
    const where = scope(req);
    const visitor = clientIp(req);
    const conn = req.ip || req.socket?.remoteAddress || 'unknown';
    const refuse = () => (onLimit ? onLimit(req, res) : res.status(429).json({ error: 'Too many messages, give it a minute.' }));
    if (!take(`ip:${visitor}:${where}`, max, windowMs, now)) return refuse();
    if (visitor !== conn && !take(`conn:${conn}:${where}`, max * backstop, windowMs, now)) return refuse();
    next();
  };
  limit._hits = hits;
  return limit;
}
