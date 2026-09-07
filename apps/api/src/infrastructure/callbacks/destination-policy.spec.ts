import { describe, expect, it } from 'vitest';

import {
  addressIsDenied,
  decideDestination,
  DENIED_BLOCK_COUNT,
  type AddressResolver,
  type DestinationPolicyOptions,
} from './destination-policy.js';

/**
 * The SSRF policy, driven case by case.
 *
 * This is the highest-risk surface in the product: a merchant supplies a URL, and a process inside
 * the network fetches it. Every test here is an attack that has worked against a real payment
 * processor, so the assertions are about refusals rather than about the happy path.
 */

const PUBLIC_ADDRESS = '93.184.216.34';
const STRICT: DestinationPolicyOptions = {
  privateDestinationAllowlist: [],
  allowlistIsPermitted: false,
};

function answerWith(addresses: readonly string[]) {
  return Promise.resolve(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
}

function resolvesTo(...addresses: string[]): AddressResolver {
  return () => answerWith(addresses);
}

const RESOLVES_PUBLIC = resolvesTo(PUBLIC_ADDRESS);
const RESOLUTION_FAILS: AddressResolver = () => Promise.reject(new Error('NXDOMAIN'));
const RESOLVES_TO_NONSENSE: AddressResolver = () =>
  Promise.resolve([{ address: 'not-an-address', family: 4 }]);

async function decide(url: string, resolver: AddressResolver = RESOLVES_PUBLIC, options = STRICT) {
  return decideDestination(url, resolver, options);
}

/** Reads better at the call site than unwrapping a promise and reaching into it in one expression. */
async function allows(
  url: string,
  resolver: AddressResolver = RESOLVES_PUBLIC,
  options = STRICT,
): Promise<boolean> {
  const decision = await decideDestination(url, resolver, options);
  return decision.allowed;
}

describe('the shape of the URL', () => {
  it('permits an ordinary https endpoint', async () => {
    const decision = await decide('https://hooks.merchant.example/cryptopay');
    expect(decision.allowed).toBe(true);
  });

  /**
   * Plain HTTP would put a signed payment notification, including the amount and the merchant's
   * reference, on the wire in clear text for anyone on the path.
   */
  it('refuses plain http', async () => {
    const decision = await decide('http://hooks.merchant.example/cryptopay');
    expect(decision.allowed).toBe(false);
  });

  it.each(['file:///etc/passwd', 'gopher://merchant.example/', 'ftp://merchant.example/'])(
    'refuses the %s scheme',
    async (url) => {
      expect(await allows(url)).toBe(false);
    },
  );

  /**
   * An arbitrary port turns a webhook destination into a port scanner operated by whoever supplied
   * the URL, with the response status leaking what is listening.
   */
  it('refuses a port other than 443', async () => {
    expect(await allows('https://merchant.example:8443/hook')).toBe(false);
    expect(await allows('https://merchant.example:22/hook')).toBe(false);
  });

  it('permits the default port written out explicitly', async () => {
    expect(await allows('https://merchant.example:443/hook')).toBe(true);
  });

  /**
   * `https://merchant.example@169.254.169.254/` reads as the merchant's host to a person and
   * resolves to the metadata service.
   */
  it('refuses a URL carrying userinfo', async () => {
    expect(await allows('https://merchant.example@evil.example/hook')).toBe(false);
    expect(await allows('https://user:pass@merchant.example/hook')).toBe(false);
  });

  it('refuses a bare address, in either family', async () => {
    expect(await allows('https://93.184.216.34/hook')).toBe(false);
    expect(await allows('https://[2606:2800:220:1:248:1893:25c8:1946]/hook')).toBe(false);
  });

  it('refuses a single-label host, which is always an internal name', async () => {
    expect(await allows('https://intranet/hook')).toBe(false);
    expect(await allows('https://localhost/hook')).toBe(false);
  });

  it('refuses a loopback name dressed as a subdomain', async () => {
    expect(await allows('https://api.localhost/hook')).toBe(false);
  });

  it('refuses something that is not a URL at all', async () => {
    expect(await allows('not a url')).toBe(false);
  });
});

describe('the address a hostname resolves to', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'the rest of the loopback range'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'the top of the private range'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'the cloud metadata service'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.100.100.200', 'the Alibaba metadata service'],
    ['0.0.0.0', 'this network'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.0.1', 'IETF protocol assignments'],
  ])('refuses a hostname resolving to %s (%s)', async (address) => {
    const decision = await decide('https://merchant.example/hook', resolvesTo(address));
    expect(decision.allowed).toBe(false);
  });

  it.each([
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'unique local'],
    ['fd00:ec2::254', 'the AWS IPv6 metadata service'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:0::1', 'Teredo'],
    ['2002:7f00:1::', '6to4 wrapping loopback'],
    ['64:ff9b::7f00:1', 'NAT64 wrapping loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ])('refuses a hostname resolving to %s (%s)', async (address) => {
    const decision = await decide('https://merchant.example/hook', resolvesTo(address));
    expect(decision.allowed).toBe(false);
  });

  it('permits a public address in either family', async () => {
    expect(await allows('https://merchant.example/hook', resolvesTo(PUBLIC_ADDRESS))).toBe(true);
    expect(await allows('https://merchant.example/hook', resolvesTo('2606:2800:220:1::1'))).toBe(
      true,
    );
  });

  /**
   * The rebinding case. A hostname that answers with one public address and one private address is
   * not a misconfiguration, and an implementation that checks only the first answer walks straight
   * into it.
   */
  it('refuses when any one of several records is denied', async () => {
    const decision = await decide(
      'https://merchant.example/hook',
      resolvesTo(PUBLIC_ADDRESS, '169.254.169.254'),
    );
    expect(decision.allowed).toBe(false);
  });

  it('refuses when the denied record comes first', async () => {
    const decision = await decide(
      'https://merchant.example/hook',
      resolvesTo('10.0.0.5', PUBLIC_ADDRESS),
    );
    expect(decision.allowed).toBe(false);
  });

  it('refuses a hostname that resolves to nothing', async () => {
    expect(await allows('https://merchant.example/hook', resolvesTo())).toBe(false);
  });

  it('refuses a hostname whose resolution fails', async () => {
    expect(await allows('https://merchant.example/hook', RESOLUTION_FAILS)).toBe(false);
  });

  it('refuses whatever a resolver returns that is not an address', async () => {
    expect(await allows('https://merchant.example/hook', RESOLVES_TO_NONSENSE)).toBe(false);
  });
});

describe('pinning the address that was checked', () => {
  /**
   * The check and the connection must look at the same address. Handing a validated URL to a plain
   * fetch lets the resolver answer again at connect time, and answer differently, which is the DNS
   * rebinding hole most implementations ship.
   */
  it('returns the address the connection must use', async () => {
    const decision = await decide('https://merchant.example/hook');
    expect(decision.pinnedAddress).toBe(PUBLIC_ADDRESS);
    expect(decision.addressFamily).toBe(4);
  });

  it('reports the family, so the caller connects over the right one', async () => {
    const decision = await decide(
      'https://merchant.example/hook',
      resolvesTo('2606:2800:220:1::1'),
    );
    expect(decision.addressFamily).toBe(6);
  });

  it('never returns an address to pin when it refused', async () => {
    const decision = await decide('https://merchant.example/hook', resolvesTo('127.0.0.1'));
    expect(decision.pinnedAddress).toBeNull();
  });
});

describe('the private destination allowlist', () => {
  const permitted: DestinationPolicyOptions = {
    privateDestinationAllowlist: ['receiver.internal.example:443'],
    allowlistIsPermitted: true,
  };

  it('permits exactly the destination that was named', async () => {
    const decision = await decideDestination(
      'https://receiver.internal.example/hook',
      resolvesTo('127.0.0.1'),
      permitted,
    );
    expect(decision.allowed).toBe(true);
  });

  /**
   * Surfaced on every attempt row rather than silently applied, so a development convenience can
   * never be quietly in effect somewhere it should not be.
   */
  it('records that it was what permitted the attempt', async () => {
    const decision = await decideDestination(
      'https://receiver.internal.example/hook',
      resolvesTo('127.0.0.1'),
      permitted,
    );
    expect(decision.usedPrivateAllowlist).toBe(true);
  });

  it('does not extend to a host that merely looks similar', async () => {
    const decision = await decideDestination(
      'https://receiver.internal.example.evil.test/hook',
      resolvesTo('127.0.0.1'),
      permitted,
    );
    expect(decision.allowed).toBe(false);
  });

  /**
   * Two independent conditions, held by different people. Operations decides whether the deployment
   * is production; the merchant decides which API key, and therefore which environment, is in use.
   * Either one alone closes this.
   */
  it('does nothing at all when the deployment has not permitted it', async () => {
    const decision = await decideDestination(
      'https://receiver.internal.example/hook',
      resolvesTo('127.0.0.1'),
      {
        privateDestinationAllowlist: ['receiver.internal.example:443'],
        allowlistIsPermitted: false,
      },
    );
    expect(decision.allowed).toBe(false);
  });

  /**
   * An entry is matched on host and port together. Listing `receiver.internal.example:443` does not
   * open every port on that host, which is what makes an entry a destination rather than a hole.
   */
  it('matches on host and port together, never on host alone', async () => {
    expect(
      await allows('http://receiver.internal.example/hook', resolvesTo('127.0.0.1'), permitted),
    ).toBe(false);
    expect(
      await allows(
        'https://receiver.internal.example:9000/hook',
        resolvesTo('127.0.0.1'),
        permitted,
      ),
    ).toBe(false);
  });

  /**
   * The bundled demo receiver is a container on a private network serving plain HTTP on its own
   * port, so an entry has to relax the scheme, the port and the address check together to be of any
   * use. It relaxes exactly those, and each relaxation applies only to the exact host and port named.
   */
  it('permits the exact plain-HTTP destination a development receiver listens on', async () => {
    const withReceiver: DestinationPolicyOptions = {
      privateDestinationAllowlist: ['demo-receiver:8080'],
      allowlistIsPermitted: true,
    };
    const decision = await decideDestination(
      'http://demo-receiver:8080/callbacks',
      resolvesTo('172.20.0.7'),
      withReceiver,
    );
    expect(decision).toMatchObject({ allowed: true, usedPrivateAllowlist: true });
  });

  /**
   * Never relaxed. A URL carrying userinfo, or one written as a bare address, is a URL that lies
   * about where it points, which is a different problem from reaching a development machine.
   */
  it('never relaxes the refusals that are about a URL lying', async () => {
    const withReceiver: DestinationPolicyOptions = {
      privateDestinationAllowlist: ['demo-receiver:8080', '172.20.0.7:8080'],
      allowlistIsPermitted: true,
    };
    expect(
      await allows(
        'http://someone@demo-receiver:8080/callbacks',
        resolvesTo('172.20.0.7'),
        withReceiver,
      ),
    ).toBe(false);
    expect(
      await allows('http://172.20.0.7:8080/callbacks', resolvesTo('172.20.0.7'), withReceiver),
    ).toBe(false);
  });

  it('does not mark a public destination as having used the allowlist', async () => {
    const decision = await decideDestination(
      'https://merchant.example/hook',
      RESOLVES_PUBLIC,
      permitted,
    );
    expect(decision.usedPrivateAllowlist).toBe(false);
  });
});

describe('the deny list itself', () => {
  it('covers both families with a meaningful number of ranges', () => {
    expect(DENIED_BLOCK_COUNT).toBeGreaterThanOrEqual(30);
  });

  it('treats anything that is not an address as denied', () => {
    expect(addressIsDenied('')).toBe(true);
    expect(addressIsDenied('example.com')).toBe(true);
    expect(addressIsDenied('999.999.999.999')).toBe(true);
  });

  it('permits ordinary public addresses', () => {
    expect(addressIsDenied('93.184.216.34')).toBe(false);
    expect(addressIsDenied('8.8.8.8')).toBe(false);
    expect(addressIsDenied('2606:2800:220:1::1')).toBe(false);
  });

  /**
   * An IPv4-mapped address has two spellings and they look nothing like each other. Denying the
   * mapped prefix as a block is not the answer: Node maps every IPv4 address into it when checking
   * against an IPv6 subnet, so that entry denies the whole of IPv4 including every real endpoint.
   */
  it('sees through both spellings of an IPv4-mapped private address', () => {
    expect(addressIsDenied('::ffff:10.0.0.1')).toBe(true);
    expect(addressIsDenied('::ffff:a00:1')).toBe(true);
    expect(addressIsDenied('::ffff:7f00:1')).toBe(true);
  });

  it('does not deny the whole of IPv4 as a side effect of covering the mapped range', () => {
    expect(addressIsDenied('::ffff:93.184.216.34')).toBe(false);
    expect(addressIsDenied('::ffff:5db8:d822')).toBe(false);
  });
});
