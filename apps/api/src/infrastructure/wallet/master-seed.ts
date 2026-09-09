import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Environment } from '@cryptopay/shared';

import {
  generateDataKey,
  type KeyWrapper,
  type KeyWrapperRegistry,
  type KeyWrappingScheme,
  KeyWrappingError,
  zeroBuffer,
} from './key-wrapping.js';

/**
 * The master seed, sealed for storage.
 *
 * Each environment has its own seed rather than sharing one under different account indices. The
 * additional authenticated data binds each envelope to the environment it was written for, so a
 * test row copied into the live slot fails to decrypt instead of quietly signing mainnet
 * transactions with a testnet seed. That mistake is otherwise invisible until funds move.
 */

const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';
const SEED_BYTES = 64;

export interface SealedSeed {
  readonly scheme: KeyWrappingScheme;
  readonly keyIdentifier: string;
  readonly wrappedDataKey: Buffer;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authenticationTag: Buffer;
}

export function additionalDataFor(environment: Environment): Buffer {
  return Buffer.from(`cryptopay:wallet-seed:v1:${environment}`, 'utf8');
}

export function generateMasterSeed(): Buffer {
  return randomBytes(SEED_BYTES);
}

export function sealSeed(seed: Buffer, environment: Environment, wrapper: KeyWrapper): SealedSeed {
  if (seed.length !== SEED_BYTES) {
    throw new KeyWrappingError(`A master seed must be exactly ${SEED_BYTES} bytes`);
  }

  const additionalData = additionalDataFor(environment);
  const dataKey = generateDataKey();

  try {
    const wrapped = wrapper.wrapDataKey(dataKey, additionalData);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, dataKey, nonce, {
      authTagLength: AUTHENTICATION_TAG_BYTES,
    });
    cipher.setAAD(additionalData);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);

    return {
      scheme: wrapped.scheme,
      keyIdentifier: wrapped.keyIdentifier,
      wrappedDataKey: wrapped.wrappedDataKey,
      nonce,
      ciphertext,
      authenticationTag: cipher.getAuthTag(),
    };
  } finally {
    zeroBuffer(dataKey);
  }
}

/**
 * Opens using the scheme recorded alongside the envelope rather than whichever scheme is current.
 * That is what makes introducing a hosted key manager possible later: rows written under the old
 * scheme keep opening under it, and only new rows use the new one. With one scheme registered the
 * lookup cannot miss, so there is no unreachable branch guarding it.
 */
export function openSeed(
  sealed: SealedSeed,
  environment: Environment,
  wrappers: KeyWrapperRegistry,
): Buffer {
  const wrapper = wrappers[sealed.scheme];

  const additionalData = additionalDataFor(environment);
  const dataKey = wrapper.unwrapDataKey(
    {
      scheme: sealed.scheme,
      keyIdentifier: sealed.keyIdentifier,
      wrappedDataKey: sealed.wrappedDataKey,
    },
    additionalData,
  );

  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, sealed.nonce, {
      authTagLength: AUTHENTICATION_TAG_BYTES,
    });
    decipher.setAAD(additionalData);
    decipher.setAuthTag(sealed.authenticationTag);
    // Bound rather than inlined into `Buffer.concat`, because concat copies and the buffer that
    // `update` returns already holds the whole plaintext seed. Leaving it unbound left one un-zeroed
    // copy of the master seed on the heap for every seed that was ever opened.
    const head = decipher.update(sealed.ciphertext);
    const tail = decipher.final();
    try {
      return Buffer.concat([head, tail]);
    } finally {
      zeroBuffer(head);
      zeroBuffer(tail);
    }
  } catch (error) {
    if (error instanceof KeyWrappingError) {
      throw error;
    }
    throw new KeyWrappingError('Could not open the master seed');
  } finally {
    zeroBuffer(dataKey);
  }
}
