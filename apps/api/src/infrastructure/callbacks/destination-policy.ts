import { BlockList, isIP } from 'node:net';

/**
 * Deciding whether a callback destination may be reached at all.
 *
 * A webhook destination is a URL a stranger chose, and the process delivering it sits inside the
 * network. That is the definition of server-side request forgery, and the defences here are layered
 * because each one alone has a known bypass:
 *
 *  1. Parsing with the WHATWG URL parser and never with a regular expression. The parser normalises
 *     the entire IPv4 encoding family for free: decimal, octal, hexadecimal, and the mixed forms
 *     that defeat every hand-written pattern.
 *  2. `https:` on port 443 only. Plain HTTP would carry a signed payment notification in clear text,
 *     and an arbitrary port turns this into a port scanner for whoever supplies the URL.
 *  3. Refusing userinfo, bare addresses and single-label hosts, none of which a real merchant
 *     endpoint has and all of which are how a parser is confused into disagreeing with a resolver.
 *  4. Resolving every record and refusing if any one of them is denied. A hostname answering with one
 *     public address and one private address is not a misconfiguration.
 *  5. Pinning the address that was checked, so the connection goes where the check looked. Without
 *     this the resolver runs again at connect time and can answer differently, which is the DNS
 *     rebinding hole that most implementations ship.
 *
 * Layer five is completed by the caller: this module returns the address to pin, and the delivery
 * worker hands it to undici. A validated URL passed to a plain `fetch` re-resolves and is unguarded.
 */

export interface DestinationDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** The address the connection must be pinned to. Never reach the host by name after this. */
  readonly pinnedAddress: string | null;
  readonly addressFamily: 4 | 6 | null;
  /** True when an allowlisted private destination is what permitted this, never silently. */
  readonly usedPrivateAllowlist: boolean;
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface DestinationPolicyOptions {
  /**
   * Explicit `host:port` destinations that bypass only the private-address check.
   *
   * There is deliberately no boolean. A flag named something like ALLOW_LOCALHOST_CALLBACKS is one
   * character from a breach and reads as harmless in a diff; a list of exact destinations does not.
   * Two independent conditions, held by different people, must both be true before an entry applies:
   * the deployment must not be production, and the payment must be in the test environment.
   */
  readonly privateDestinationAllowlist: readonly string[];
  readonly allowlistIsPermitted: boolean;
}

/**
 * Every range a callback must never reach, as CIDR blocks rather than as individual addresses.
 *
 * Blocking `169.254.169.254` by value is the version of this that fails: the same metadata service
 * answers on other addresses, on IPv6, and behind hostnames that resolve to it. Blocking the range
 * wholesale covers the address, its neighbours, and the ones added next year.
 */
const DENIED_IPV4_BLOCKS: readonly (readonly [string, number, string])[] = Object.freeze([
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT, and Alibaba metadata'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local, and the cloud metadata service'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.31.196.0', 24, 'AS112 anycast'],
  ['192.52.193.0', 24, 'AMT'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['192.175.48.0', 24, 'AS112 direct delegation'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved, including the broadcast address'],
]);

const DENIED_IPV6_BLOCKS: readonly (readonly [string, number, string])[] = Object.freeze([
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  // The deprecated IPv4-compatible form, `::a.b.c.d`. Denied wholesale because nothing legitimate
  // uses it, and because it is another way to write an address that resolves back to IPv4.
  ['::', 96, 'IPv4-compatible, deprecated'],
  ['64:ff9b::', 96, 'NAT64, which translates straight back to IPv4'],
  ['64:ff9b:1::', 48, 'local-use NAT64'],
  ['100::', 64, 'discard-only'],
  // Covers Teredo (2001::/32) and every other protocol assignment in the range, so a new tunnelling
  // mechanism does not need this list to be updated before it is blocked.
  ['2001::', 23, 'IETF protocol assignments, including Teredo'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, '6to4, which encodes an IPv4 address'],
  ['5f00::', 16, 'segment routing'],
  ['fc00::', 7, 'unique local, including AWS IPv6 metadata'],
  ['fe80::', 10, 'link-local'],
  ['ff00::', 8, 'multicast'],
]);

function buildDenyList(): BlockList {
  const denied = new BlockList();
  for (const [address, prefix] of DENIED_IPV4_BLOCKS) {
    denied.addSubnet(address, prefix, 'ipv4');
  }
  for (const [address, prefix] of DENIED_IPV6_BLOCKS) {
    denied.addSubnet(address, prefix, 'ipv6');
  }
  return denied;
}

const DENIED = buildDenyList();

const MAPPED_DOTTED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const MAPPED_HEX = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/;

/**
 * Resolves an IPv4-mapped address to the IPv4 address it actually reaches.
 *
 * `::ffff:127.0.0.1` is loopback wearing an IPv6 costume, and it has a second spelling,
 * `::ffff:7f00:1`, that looks nothing like it. Both are reduced to the dotted form here so that one
 * IPv4 deny list covers every way of writing an IPv4 destination.
 *
 * The mapped prefix cannot simply be denied as a block: Node's BlockList maps every IPv4 address
 * into it when checking against an IPv6 subnet, so a `::ffff:0:0/96` entry silently denies the whole
 * of IPv4 including every legitimate merchant endpoint. That mistake is why this function exists.
 */
function unwrapMappedIpv4(address: string): string | null {
  const dotted = MAPPED_DOTTED.exec(address);
  if (dotted?.[1] !== undefined) {
    return dotted[1];
  }
  const hex = MAPPED_HEX.exec(address);
  if (hex?.[1] === undefined || hex[2] === undefined) {
    return null;
  }
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${(high >> 8).toString()}.${(high & 0xff).toString()}.${(low >> 8).toString()}.${(low & 0xff).toString()}`;
}

/** Exported so a test can assert the ranges are what they claim to be, one address at a time. */
export function addressIsDenied(address: string): boolean {
  const mapped = unwrapMappedIpv4(address.toLowerCase());
  const subject = mapped ?? address;
  const family = isIP(subject);
  if (family === 0) {
    return true;
  }
  return DENIED.check(subject, family === 4 ? 'ipv4' : 'ipv6');
}

export const DENIED_BLOCK_COUNT = DENIED_IPV4_BLOCKS.length + DENIED_IPV6_BLOCKS.length;

function refuse(reason: string): DestinationDecision {
  return {
    allowed: false,
    reason,
    pinnedAddress: null,
    addressFamily: null,
    usedPrivateAllowlist: false,
  };
}

interface ParsedDestination {
  readonly hostname: string;
  readonly hostAndPort: string;
  readonly allowlisted: boolean;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = Object.freeze({
  'https:': '443',
  'http:': '80',
});

/**
 * Exactly what an allowlist entry relaxes, written out so nobody has to infer it: the scheme, the
 * port, the fully-qualified-hostname requirement, and the private-address check. It never relaxes
 * the userinfo or bare-address refusals, because those are about a URL that lies about where it
 * points rather than about reaching a development machine.
 *
 * Both gates must already hold before any of this applies, and they are held by different people:
 * the deployment must not be production, and the payment must be in the test environment.
 */
function parseDestination(
  destinationUrl: string,
  options: DestinationPolicyOptions,
): ParsedDestination | DestinationDecision {
  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    return refuse('the destination is not a URL');
  }

  // Userinfo is how a URL is made to read as one host to a person and resolve as another to a
  // parser, and no legitimate webhook endpoint carries credentials in its URL.
  if (url.username !== '' || url.password !== '') {
    return refuse('a callback destination must not carry credentials');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === '') {
    return refuse('the destination has no host');
  }
  // A bracketed literal arrives from the parser without its brackets, so this catches both forms.
  if (isIP(hostname) !== 0) {
    return refuse('a callback destination must be a hostname, not an address');
  }

  const port = url.port === '' ? (DEFAULT_PORTS[url.protocol] ?? '') : url.port;
  const hostAndPort = `${hostname}:${port}`;
  const allowlisted =
    options.allowlistIsPermitted && options.privateDestinationAllowlist.includes(hostAndPort);

  if (!allowlisted) {
    if (url.protocol !== 'https:') {
      return refuse('a callback destination must use https');
    }
    if (port !== '443') {
      return refuse('a callback destination must use port 443');
    }
    // `https://intranet/` and similar internal names. A public endpoint always has a dot in it.
    if (!hostname.includes('.')) {
      return refuse('a callback destination must be a fully qualified hostname');
    }
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return refuse('a callback destination must not be a loopback name');
    }
  }

  return { hostname, hostAndPort, allowlisted };
}

export async function decideDestination(
  destinationUrl: string,
  resolve: AddressResolver,
  options: DestinationPolicyOptions,
): Promise<DestinationDecision> {
  const parsed = parseDestination(destinationUrl, options);
  if ('allowed' in parsed) {
    return parsed;
  }

  let resolved: readonly ResolvedAddress[];
  try {
    resolved = await resolve(parsed.hostname);
  } catch {
    return refuse('the destination hostname could not be resolved');
  }
  if (resolved.length === 0) {
    return refuse('the destination hostname resolved to no address');
  }

  // Every record is checked, not just the first. A hostname answering with one public address and
  // one private address is not a misconfiguration, and taking the first answer is what makes that
  // attack work.
  const denied = resolved.filter((entry) => addressIsDenied(entry.address));
  if (denied.length > 0 && !parsed.allowlisted) {
    return refuse('the destination resolves to an address this system must not reach');
  }

  const chosen = resolved[0];
  if (chosen === undefined) {
    return refuse('the destination hostname resolved to no address');
  }
  const family = isIP(chosen.address);
  if (family === 0) {
    return refuse('the resolver returned something that is not an address');
  }

  return {
    allowed: true,
    reason: parsed.allowlisted ? 'permitted by the private destination allowlist' : 'permitted',
    pinnedAddress: chosen.address,
    addressFamily: family === 4 ? 4 : 6,
    usedPrivateAllowlist: parsed.allowlisted,
  };
}
