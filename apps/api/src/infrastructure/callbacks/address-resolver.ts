import { lookup } from 'node:dns/promises';

import type { AddressResolver } from './destination-policy.js';

/**
 * Resolving a callback hostname to every address it answers with.
 *
 * `all: true` is the load-bearing option. Taking a single answer is what makes a DNS rebinding
 * attack work: a hostname returns one public address and one private one, the check sees the public
 * one, and the connection later takes the private one. Every record is returned here so the policy
 * can refuse if any of them is denied.
 *
 * `verbatim: true` keeps the resolver's own ordering rather than reordering by family, so the
 * address that gets pinned is the one the operating system would actually have chosen.
 */
export const resolveSystemAddresses: AddressResolver = async (hostname: string) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((entry) => ({ address: entry.address, family: entry.family }));
};
