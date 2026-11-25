/**
 * The `net` grant constraint (spec/evaluation.md §3.10, todo/network_constraints.md): rules about
 * the connection a request arrives on, rather than the place it comes from.
 *
 * Everything that needs I/O (address lists, DNS answers, relay hops, a timed round trip, a
 * customer webhook) is resolved by the verifier first and handed in through the context, so this
 * stays pure and the conformance vectors stay plain JSON. `net.server` is validated here but not
 * evaluated by verifiers: it binds the device's own SDK or CLI.
 */
import { parseCidr, ipInCidr, sameIp } from './ip.js';

export const NET_KEYS = new Set(['client', 'server']);
const DIRECTION_KEYS = new Set(['addresses', 'route', 'latency']);
const ADDRESS_KEYS = new Set(['of', 'cidrs', 'lists', 'dns', 'webhook']);
const LIST_KEYS = new Set(['id', 'uri']);
const DNS_KEYS = new Set(['names', 'dnssec']);
const ROUTE_KEYS = new Set(['relays', 'min_hops', 'max_hops', 'require_attested']);
const LATENCY_KEYS = new Set(['max_rtt_ms', 'samples', 'reuse_s']);

export const NET_LIMITS = Object.freeze({ cidrs: 64, lists: 8, names: 16, relays: 16, maxHops: 4, maxRttMs: 5000, samples: 5, maxReuse: 300, uriLength: 512 });
export const ADDRESS_LIST_ID = /^adl_[A-Za-z0-9]{8,64}$/;
// An https URL, or http on this machine's loopback for local development (a local issuer's lists).
const LIST_URI = /^(?:https:\/\/[^\s/]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?)\/\S*$/;
const DEVICE_ID = /^dev_[A-Za-z0-9]{8,64}$/;
const GATE_ID = /^gate_[A-Za-z0-9]{8,64}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ROUTE_ERROR = /^[a-z0-9_]{1,64}$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** A lower-case DNS host name with at least two labels and a non-numeric last label. */
export function validHostName(name) {
  if (typeof name !== 'string' || name.length > 253) return false;
  const labels = name.split('.');
  return labels.length >= 2 && labels.every(l => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]);
}

const unknownIn = (value, allowed, path) => isObject(value) ? Object.keys(value).filter(k => !allowed.has(k)).map(k => `${path}.${k}`) : [];

/** Paths of members `net` does not know (each becomes `unknown_constraint:<path>`). */
export function netUnknownKeys(net) {
  if (!isObject(net)) return [];
  const paths = unknownIn(net, NET_KEYS, 'net');
  for (const side of ['client', 'server']) {
    const d = net[side]; const p = `net.${side}`;
    paths.push(...unknownIn(d, DIRECTION_KEYS, p));
    if (!isObject(d)) continue;
    paths.push(...unknownIn(d.addresses, ADDRESS_KEYS, `${p}.addresses`), ...unknownIn(d.route, ROUTE_KEYS, `${p}.route`), ...unknownIn(d.latency, LATENCY_KEYS, `${p}.latency`));
    if (isObject(d.addresses)) {
      paths.push(...unknownIn(d.addresses.dns, DNS_KEYS, `${p}.addresses.dns`));
      if (Array.isArray(d.addresses.lists)) d.addresses.lists.forEach((l, i) => paths.push(...unknownIn(l, LIST_KEYS, `${p}.addresses.lists[${i}]`)));
    }
  }
  return paths;
}

function checkList(value, path, errors, max, test, message) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) { errors.push(`${path} must be a list of 1–${max} entries`); return; }
  if (new Set(value).size !== value.length) errors.push(`${path} has duplicates`);
  value.forEach((v, i) => { if (!test(v)) errors.push(`${path}[${i}] ${message}`); });
}

function validateAddresses(a, side, hasRoute, path, errors) {
  if (!isObject(a)) { errors.push(`${path} must be an object`); return; }
  if (a.of !== undefined && a.of !== 'peer' && a.of !== 'origin') errors.push(`${path}.of must be "peer" or "origin"`);
  if (a.of === 'origin' && side === 'server') errors.push(`${path}.of "origin" is only for net.client (a device sees the server's address directly)`);
  if (a.of === 'origin' && !hasRoute) errors.push(`${path}.of "origin" needs a route: the first relay records the device's address`);
  if (a.cidrs !== undefined) checkList(a.cidrs, `${path}.cidrs`, errors, NET_LIMITS.cidrs, c => !!parseCidr(c), 'must be a CIDR range like "203.0.113.0/24"');
  if (a.lists !== undefined) {
    checkList(a.lists, `${path}.lists`, errors, NET_LIMITS.lists, l => isObject(l) && typeof l.id === 'string' && ADDRESS_LIST_ID.test(l.id)
      && typeof l.uri === 'string' && l.uri.length <= NET_LIMITS.uriLength && LIST_URI.test(l.uri), 'must be { id: "adl_…", uri: "https://…" }');
    if (Array.isArray(a.lists) && new Set(a.lists.map(l => l?.id)).size !== a.lists.length) errors.push(`${path}.lists names a list twice`);
  }
  if (a.dns !== undefined) {
    if (!isObject(a.dns)) errors.push(`${path}.dns must be an object`);
    else {
      checkList(a.dns.names, `${path}.dns.names`, errors, NET_LIMITS.names, validHostName, 'must be a lower-case host name like "vpn.example.com"');
      if (a.dns.dnssec !== undefined && typeof a.dns.dnssec !== 'boolean') errors.push(`${path}.dns.dnssec must be true or false`);
    }
  }
  if (a.webhook !== undefined) {
    if (side === 'server') errors.push(`${path}.webhook is only for net.client (devicebasedauth.org asks the webhook during online authorization)`);
    else if (typeof a.webhook !== 'string' || !GATE_ID.test(a.webhook)) errors.push(`${path}.webhook must be a webhook gate id like "gate_…"`);
  }
  if (a.cidrs === undefined && a.lists === undefined && a.dns === undefined && a.webhook === undefined) errors.push(`${path} needs at least one of cidrs, lists, dns or webhook`);
}

function validateRoute(r, path, errors) {
  if (!isObject(r)) { errors.push(`${path} must be an object`); return; }
  checkList(r.relays, `${path}.relays`, errors, NET_LIMITS.relays, id => typeof id === 'string' && DEVICE_ID.test(id), 'must be a relay device id like "dev_…"');
  const min = r.min_hops ?? 1; const max = r.max_hops ?? NET_LIMITS.maxHops;
  if (!isInt(min, 1, NET_LIMITS.maxHops)) errors.push(`${path}.min_hops must be an integer 1–${NET_LIMITS.maxHops}`);
  if (!isInt(max, 1, NET_LIMITS.maxHops)) errors.push(`${path}.max_hops must be an integer 1–${NET_LIMITS.maxHops}`);
  else if (isInt(min, 1, NET_LIMITS.maxHops) && min > max) errors.push(`${path}.min_hops must not exceed max_hops`);
  if (r.require_attested !== undefined && typeof r.require_attested !== 'boolean') errors.push(`${path}.require_attested must be true or false`);
}

function validateLatency(l, path, errors) {
  if (!isObject(l)) { errors.push(`${path} must be an object`); return; }
  if (!isInt(l.max_rtt_ms, 1, NET_LIMITS.maxRttMs)) errors.push(`${path}.max_rtt_ms must be an integer 1–${NET_LIMITS.maxRttMs}`);
  if (l.samples !== undefined && !isInt(l.samples, 1, NET_LIMITS.samples)) errors.push(`${path}.samples must be an integer 1–${NET_LIMITS.samples}`);
  if (l.reuse_s !== undefined && !isInt(l.reuse_s, 0, NET_LIMITS.maxReuse)) errors.push(`${path}.reuse_s must be an integer 0–${NET_LIMITS.maxReuse}`);
}

/** Validation errors for a grant's `net` member (unknown members are reported by netUnknownKeys). */
export function validateNet(net, path = 'grant.net') {
  const errors = [];
  if (!isObject(net)) return [`${path} must be an object`];
  if (net.client === undefined && net.server === undefined) errors.push(`${path} needs client or server`);
  for (const side of ['client', 'server']) {
    const d = net[side]; const p = `${path}.${side}`;
    if (d === undefined) continue;
    if (!isObject(d)) { errors.push(`${p} must be an object`); continue; }
    if (d.addresses === undefined && d.route === undefined && d.latency === undefined) errors.push(`${p} needs at least one of addresses, route or latency`);
    if (d.addresses !== undefined) validateAddresses(d.addresses, side, d.route !== undefined, `${p}.addresses`, errors);
    if (d.route !== undefined) validateRoute(d.route, `${p}.route`, errors);
    if (d.latency !== undefined) validateLatency(d.latency, `${p}.latency`, errors);
  }
  return errors;
}

/**
 * Check `net.client` of a valid grant, pushing reasons in the order of spec/evaluation.md §3.10.
 * Sets `online.address_webhook` when only the webhook could still allow the address.
 */
export function checkNetClient(client, context, reasons, online) {
  if (!client) return;
  const network = isObject(context.location?.network) ? context.location.network : {};
  const route = isObject(context.route) && Array.isArray(context.route.relays) ? context.route : null;
  if (client.addresses) checkAddresses(client.addresses, client.addresses.of === 'origin' ? route?.origin : network.ip, context, reasons, online);
  if (client.route) {
    const r = client.route;
    // Any route error at all denies (null means none): a verifier that reports one in the wrong
    // type has still not accepted the hops.
    if (context.route_error !== undefined && context.route_error !== null) reasons.push(`route_invalid:${typeof context.route_error === 'string' && ROUTE_ERROR.test(context.route_error) ? context.route_error : 'malformed'}`);
    else if (!route) reasons.push('route_required');
    else {
      const hops = route.relays.length;
      if (hops < (r.min_hops ?? 1) || hops > (r.max_hops ?? NET_LIMITS.maxHops)) reasons.push('route_invalid:hop_count');
      if (r.require_attested && !(Array.isArray(route.attested) && route.attested.length === hops && route.attested.every(a => a === true))) reasons.push('route_invalid:relay_not_attested');
      if (!route.relays.every(id => r.relays.includes(id))) reasons.push('route_relay_not_allowed');
    }
  }
  if (client.latency) {
    const rtt = network.rtt_ms;
    if (typeof rtt !== 'number' || !Number.isFinite(rtt) || rtt < 0) reasons.push('rtt_required');
    else if (rtt > client.latency.max_rtt_ms) reasons.push('rtt_exceeded');
  }
}

function checkAddresses(a, address, context, reasons, online) {
  if (typeof address !== 'string' || address === '') { reasons.push('address_unavailable'); return; }
  const lists = isObject(context.address_lists) ? context.address_lists : {};
  const dns = isObject(context.dns) ? context.dns : {};
  const listOf = id => Object.hasOwn(lists, id) && isObject(lists[id]) && Array.isArray(lists[id].cidrs) ? lists[id] : null;
  const answerOf = name => Object.hasOwn(dns, name) && isObject(dns[name]) && Array.isArray(dns[name].addrs) ? dns[name] : null;
  const dnsOk = answer => answer && (a.dns.dnssec !== true || answer.dnssec === true);
  const allowed = (a.cidrs || []).some(c => ipInCidr(address, c))
    || (a.lists || []).some(l => listOf(l.id)?.cidrs.some(c => ipInCidr(address, c)))
    || (a.dns?.names || []).some(n => { const answer = answerOf(n); return dnsOk(answer) && answer.addrs.some(x => sameIp(address, x)); });
  if (allowed) return;
  if (a.webhook) {
    // Only devicebasedauth.org can ask the webhook, so offline the grant becomes online-only.
    if (!context.online) { online.address_webhook = a.webhook; return; }
    const answers = isObject(context.address_webhook) ? context.address_webhook : {};
    if (Object.hasOwn(answers, a.webhook) && answers[a.webhook] === true) return;
  }
  reasons.push('address_not_allowed');
  for (const l of a.lists || []) if (!listOf(l.id)) reasons.push(`address_list_unavailable:${l.id}`);
  for (const n of a.dns?.names || []) {
    const answer = answerOf(n);
    if (!answer) reasons.push(`dns_unresolved:${n}`);
    else if (!dnsOk(answer)) reasons.push(`dns_unvalidated:${n}`);
  }
}

function joinOr(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function describeAddresses(a) {
  const sources = [...(a.cidrs || [])];
  for (const l of a.lists || []) sources.push(`the addresses in list ${l.id}`);
  for (const n of a.dns?.names || []) sources.push(`the addresses of ${n}${a.dns.dnssec ? ' (DNSSEC-validated)' : ''}`);
  if (a.webhook) sources.push(`addresses webhook ${a.webhook} allows`);
  return joinOr(sources);
}

function describeRoute(r) {
  const min = r.min_hops ?? 1; const max = r.max_hops ?? NET_LIMITS.maxHops;
  const hops = min === max ? `${min} hop${min === 1 ? '' : 's'}` : `${min}–${max} hops`;
  return `through relay${r.relays.length > 1 ? 's' : ''} ${joinOr(r.relays)} (${hops}${r.require_attested ? ', attested relays only' : ''})`;
}

/** Plain-English phrases for a grant's `net`, for describeGrant. */
export function describeNet(net) {
  const parts = [];
  const c = net?.client;
  if (c?.addresses) parts.push(`only from ${c.addresses.of === 'origin' ? 'devices at ' : ''}${describeAddresses(c.addresses)}`);
  if (c?.route) parts.push(`only ${describeRoute(c.route)}`);
  if (c?.latency) parts.push(`only from a device answering within ${c.latency.max_rtt_ms} ms`);
  const s = net?.server;
  if (s?.addresses) parts.push(`sending only to servers at ${describeAddresses(s.addresses)}`);
  if (s?.route) parts.push(`sending only ${describeRoute(s.route)}`);
  if (s?.latency) parts.push(`sending only to a server answering within ${s.latency.max_rtt_ms} ms`);
  return parts;
}
