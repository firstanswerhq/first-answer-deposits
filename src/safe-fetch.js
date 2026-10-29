// Fetching links an owner typed in (their busy calendar, their CRM webhook) without letting those links
// reach this server's own network: https only, and never localhost, private, link-local or other internal
// addresses. The host name is resolved first and every address it resolves to is checked, and each redirect
// is checked again the same way. The request then connects to the exact address that was checked, so a DNS
// answer that changes between the check and the request (DNS rebinding) cannot point it somewhere else.
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

// Two lists: a BlockList also matches IPv4 addresses against IPv6 rules like ::ffff:0:0/96, so they stay apart.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // old 6to4 relay
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 3], // multicast and reserved
]) blocked4.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ['::ffff:0:0', 96], // IPv4-mapped (::ffff:a.b.c.d)
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64 (reaches any IPv4 address, internal ones too)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (carries an IPv4 address)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (carries an IPv4 address)
  ['fec0::', 10], // old site-local
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) blocked6.addSubnet(addr, bits, 'ipv6');

export function isInternalIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return blocked4.check(ip, 'ipv4');
  if (v === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:10.0.0.1, ::ffff:a00:1): check the IPv4 part. Every other way of carrying an IPv4
    // address inside IPv6 (NAT64, IPv4-compatible, 6to4, Teredo) is refused outright by the list above.
    const tail = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (tail) return isInternalIp(tail[1]);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isInternalIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return blocked6.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

// Throws a plain-words error unless the link is https and points only at public internet addresses.
// Returns the URL and the checked address to connect to.
export async function resolvePublicUrl(raw, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw new Error('That is not a valid link.');
  }
  if (url.protocol !== 'https:') throw new Error('Use an https:// link.');
  if (url.username || url.password) throw new Error('Links with a user name or password in them are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || /(^|\.)localhost$/i.test(host)) throw new Error('That link points inside this server, which is not allowed.');
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new Error(`Could not find ${host}. Check the link.`);
    }
  }
  if (!addresses.length || addresses.some(isInternalIp)) throw new Error('That link points to a private or internal address, which is not allowed.');
  return { url, address: addresses[0], family: net.isIP(addresses[0]) };
}

export async function checkPublicUrl(raw, opts) {
  return (await resolvePublicUrl(raw, opts)).url;
}

// A small fetch() over node:https that connects only to the given (already checked) address. TLS still checks
// the certificate against the link's host name. The body is capped so a huge answer can't fill memory.
const MAX_BODY = 2 * 1024 * 1024;
export function pinnedFetch(url, { method = 'GET', headers = {}, body, signal } = {}, { address, family }) {
  return new Promise((resolve, reject) => {
    const lookup = (host, o, cb) => (o && o.all ? cb(null, [{ address, family }]) : cb(null, address, family));
    // A body is sent with its length up front, not chunked: some webhook receivers refuse chunked POSTs.
    const hasBody = body !== undefined && body !== null;
    if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) headers = { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const req = https.request(url, { method, headers, signal, lookup }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy(new Error('The response was too large.'));
        else chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (h) => [res.headers[String(h).toLowerCase()]].flat().filter((v) => v !== undefined).join(', ') || null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    if (hasBody) req.write(body);
    req.end();
  });
}

// fetch() for owner-entered links. Follows up to 3 redirects, checking each hop.
// fetchImpl(url, opts, { address, family }) must connect to that address (tests pass their own).
export async function safeFetch(raw, opts = {}, { lookup, fetchImpl = pinnedFetch, maxRedirects = 3 } = {}) {
  let { url, ...pin } = await resolvePublicUrl(raw, { lookup });
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url.toString(), { ...opts, redirect: 'manual' }, pin);
    const to = res.status >= 300 && res.status < 400 && res.headers?.get?.('location');
    // Only plain GETs follow redirects; a webhook POST that gets redirected is simply not delivered.
    if (!to || (opts.method && opts.method !== 'GET')) return res;
    if (hop >= maxRedirects) throw new Error('Too many redirects.');
    ({ url, ...pin } = await resolvePublicUrl(new URL(to, url).toString(), { lookup }));
  }
}
