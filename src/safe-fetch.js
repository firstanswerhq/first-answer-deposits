// Fetching links an owner typed in (their busy calendar, their CRM webhook) without letting those links
// reach this server's own network: https only, and never localhost, private, link-local or other internal
// addresses. The host name is resolved first and every address it resolves to is checked, and each redirect
// is checked again the same way.
import dns from 'node:dns/promises';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 3], // multicast and reserved
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) blocked.addSubnet(addr, bits, 'ipv6');

export function isInternalIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) {
    const lower = ip.toLowerCase();
    // IPv4 written inside IPv6 (::ffff:10.0.0.1, ::ffff:a00:1, 64:ff9b::10.0.0.1): check the IPv4 part.
    const tail = lower.match(/^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (tail) return isInternalIp(tail[1]);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isInternalIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

// Throws a plain-words error unless the link is https and points only at public internet addresses.
export async function checkPublicUrl(raw, { lookup = dns.lookup } = {}) {
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
  return url;
}

// fetch() for owner-entered links. Follows up to 3 redirects, checking each hop.
export async function safeFetch(raw, opts = {}, { lookup, fetchImpl = fetch, maxRedirects = 3 } = {}) {
  let url = await checkPublicUrl(raw, { lookup });
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url.toString(), { ...opts, redirect: 'manual' });
    const to = res.status >= 300 && res.status < 400 && res.headers?.get?.('location');
    // Only plain GETs follow redirects; a webhook POST that gets redirected is simply not delivered.
    if (!to || (opts.method && opts.method !== 'GET')) return res;
    if (hop >= maxRedirects) throw new Error('Too many redirects.');
    url = await checkPublicUrl(new URL(to, url).toString(), { lookup });
  }
}
