// Who is using the demo, so one visitor's "Reset demo" only clears what that visitor made (plus the sample day).
// Every browser gets a random visitor id in a cookie. The demo page's own assistant calls this server's MCP
// endpoint over HTTP on the visitor's behalf: it sends a per-process internal secret (random at startup, never
// sent to a browser) with the visitor's id, so those calls keep the visitor's id and skip the public MCP rate
// limit. A request from outside can never pass for internal: it would need the secret.
import crypto from 'node:crypto';

const INTERNAL_SECRET = crypto.randomBytes(32).toString('hex');
const VID = /^[a-f0-9]{24}$/;
const COOKIE = 'fad_vid';

// `publicBase`: the demo assistant calls MCP over loopback for speed, so it tells the server which public address
// the links it returns (approval_url) should carry. Only an internal caller is believed (see baseFor in mcp.js).
export function internalHeaders(visitorId, { publicBase = '' } = {}) {
  return { 'x-fad-internal': INTERNAL_SECRET, ...(visitorId && VID.test(visitorId) ? { 'x-fad-visitor': visitorId } : {}), ...(publicBase ? { 'x-fad-public-base': publicBase } : {}) };
}

export function isInternal(req) {
  const got = Buffer.from(String(req.get?.('x-fad-internal') || req.headers?.['x-fad-internal'] || ''));
  const want = Buffer.from(INTERNAL_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function cookieValue(req, name) {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function visitorMiddleware(req, res, next) {
  if (isInternal(req)) {
    const v = String(req.get('x-fad-visitor') || '');
    req.visitorId = VID.test(v) ? v : null;
    return next();
  }
  let vid = cookieValue(req, COOKIE);
  if (!VID.test(vid)) {
    vid = crypto.randomBytes(12).toString('hex');
    res.append('Set-Cookie', `${COOKIE}=${vid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${req.secure ? '; Secure' : ''}`);
  }
  req.visitorId = vid;
  next();
}
