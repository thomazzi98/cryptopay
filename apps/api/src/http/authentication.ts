import type { ApiKeyScope, Environment } from '@cryptopay/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { apiKeySecretMatches, parseApiKey } from '../infrastructure/crypto/api-key.js';
import type { MerchantRepository } from '../infrastructure/persistence/merchant.repository.js';
import { ApplicationError } from './problem-details.js';

/**
 * Bearer authentication against a merchant API key.
 *
 * The environment travels in the key itself and is authoritative: it is written onto every payment
 * the request creates, and a database CHECK makes a test-mode key incapable of producing a mainnet
 * row even if this guard were bypassed entirely.
 *
 * Every failure returns the same 401 with the same body. Distinguishing "no such key" from "wrong
 * secret" would let an unauthenticated caller confirm which key identifiers exist.
 */

export interface AuthenticatedMerchant {
  readonly merchantId: string;
  readonly environment: Environment;
  readonly apiKeyIdentifier: string;
  readonly scopes: readonly string[];
}

/**
 * The authenticated merchant is held beside the request rather than assigned onto it. Mutating a
 * framework object is the usual approach and makes the value invisible to the type system; a
 * WeakMap keyed on the request is explicit and is collected with the request itself.
 */
const authenticatedMerchants = new WeakMap<FastifyRequest, AuthenticatedMerchant>();

export type AuthenticationHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AuthenticationDependencies {
  readonly merchantRepository: MerchantRepository;
  readonly apiKeyPepper: string;
}

const BEARER_PREFIX = 'Bearer ';

function readPresentedKey(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

const UNAUTHORIZED_DETAIL =
  'Provide a valid API key as "Authorization: Bearer cp_test_..." or "cp_live_...".';

export function createAuthenticationHook(
  dependencies: AuthenticationDependencies,
): AuthenticationHook {
  const { merchantRepository, apiKeyPepper } = dependencies;

  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const presented = readPresentedKey(request);
    if (presented === null) {
      throw new ApplicationError('unauthorized', UNAUTHORIZED_DETAIL);
    }

    // Parsing first means a malformed key never reaches the database, so the authentication path
    // cannot be used to generate load.
    const parsed = parseApiKey(presented);
    if (parsed === null) {
      throw new ApplicationError('unauthorized', UNAUTHORIZED_DETAIL);
    }

    const record = await merchantRepository.findApiKey(parsed.keyIdentifier);
    if (record === null) {
      throw new ApplicationError('unauthorized', UNAUTHORIZED_DETAIL);
    }
    if (record.revokedAt !== null) {
      throw new ApplicationError('unauthorized', UNAUTHORIZED_DETAIL);
    }

    // The environment named in the presented key must be the one the key was issued for. Without
    // this, editing the prefix of a test key would present it as a live key.
    if (record.environment !== parsed.environment) {
      throw new ApplicationError('unauthorized', UNAUTHORIZED_DETAIL);
    }
    if (!apiKeySecretMatches(parsed.secret, record.secretDigest, apiKeyPepper)) {
      throw new ApplicationError('unauthorized', UNAUTHORIZED_DETAIL);
    }

    authenticatedMerchants.set(
      request,
      Object.freeze({
        merchantId: record.merchantId,
        environment: record.environment,
        apiKeyIdentifier: record.id,
        scopes: record.scopes,
      }),
    );

    reply.header('cryptopay-environment', record.environment);

    // Recording usage must never fail a request, so it is fired without awaiting the result.
    void merchantRepository.recordKeyUsage(record.id).catch((error: unknown) => {
      request.log.warn(
        { event: 'api_key.usage_not_recorded', error },
        'could not record key usage',
      );
    });
  };
}

/**
 * Reads the authenticated merchant off a request inside a handler that is registered behind the
 * authentication hook. Throwing rather than returning null keeps every handler free of a branch
 * that cannot happen.
 */
export function requireMerchant(request: FastifyRequest): AuthenticatedMerchant {
  const merchant = authenticatedMerchants.get(request);
  if (merchant === undefined) {
    throw new ApplicationError('unauthorized', UNAUTHORIZED_DETAIL);
  }
  return merchant;
}

/**
 * Refuses a request whose key was not granted the power it is trying to use.
 *
 * Answered as 403 rather than 404, which is the opposite of how a payment belonging to another
 * merchant is treated, and deliberately so. Hiding another merchant's payment behind a 404 denies
 * an attacker the knowledge that an identifier is real. Here the caller already holds a valid key
 * and is asking about their own account; telling them their key lacks a scope reveals nothing they
 * could not learn by looking at it, and saying 404 instead would send an integrator hunting for a
 * missing resource that exists.
 */
export function requireScope(request: FastifyRequest, scope: ApiKeyScope): AuthenticatedMerchant {
  const merchant = requireMerchant(request);
  if (!merchant.scopes.includes(scope)) {
    throw new ApplicationError(
      'forbidden',
      `This API key does not have the ${scope} scope.`,
      [],
      'INSUFFICIENT_SCOPE',
    );
  }
  return merchant;
}
