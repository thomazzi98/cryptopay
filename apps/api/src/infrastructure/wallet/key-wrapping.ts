import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for the wallet seed.
 *
 * The scheme is dispatched from a value stored alongside the data it protects, rather than through
 * an interface with one implementation and a test fake. Adding a hosted key manager later is one
 * entry in this record and one new value in the `scheme` column; existing rows keep decrypting under
 * the scheme they were written with, which is what makes migration possible at all.
 *
 * There is deliberately no `KeyVault` port. An interface whose only alternative implementation is a
 * mock is ceremony, and the seam that actually matters here is the stored scheme value.
 */

export type KeyWrappingScheme = 'AESGCM256_LOCALKEY_V1';

interface WrappedDataKey {
  readonly scheme: KeyWrappingScheme;
  readonly keyIdentifier: string;
  readonly wrappedDataKey: Buffer;
}

export interface KeyWrapper {
  readonly scheme: KeyWrappingScheme;
  wrapDataKey(dataKey: Buffer, additionalAuthenticatedData: Buffer): WrappedDataKey;
  unwrapDataKey(wrapped: WrappedDataKey, additionalAuthenticatedData: Buffer): Buffer;
}

export const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export class KeyWrappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyWrappingError';
  }
}

export function generateDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

/**
 * Wraps with a key held in the process environment. This is the honest limitation of the current
 * design: whoever can read the environment of the API or chain-worker process can unwrap every
 * unswept deposit key. It is documented rather than disguised.
 */
export function createLocalKeyWrapper(keyEncryptionKey: Buffer, keyIdentifier: string): KeyWrapper {
  if (keyEncryptionKey.length !== DATA_KEY_BYTES) {
    throw new KeyWrappingError(
      `A key-encryption key must be exactly ${DATA_KEY_BYTES} bytes, received ${keyEncryptionKey.length}`,
    );
  }

  return {
    scheme: 'AESGCM256_LOCALKEY_V1',

    wrapDataKey(dataKey, additionalAuthenticatedData) {
      if (dataKey.length !== DATA_KEY_BYTES) {
        throw new KeyWrappingError(`A data key must be exactly ${DATA_KEY_BYTES} bytes`);
      }

      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyEncryptionKey, nonce, {
        authTagLength: AUTHENTICATION_TAG_BYTES,
      });
      cipher.setAAD(additionalAuthenticatedData);
      const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);

      // Nonce, tag and ciphertext travel as one opaque value so a caller cannot store them apart
      // and reassemble them wrongly.
      return {
        scheme: 'AESGCM256_LOCALKEY_V1',
        keyIdentifier,
        wrappedDataKey: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
      };
    },

    unwrapDataKey(wrapped, additionalAuthenticatedData) {
      if (
        wrapped.wrappedDataKey.length !==
        NONCE_BYTES + AUTHENTICATION_TAG_BYTES + DATA_KEY_BYTES
      ) {
        throw new KeyWrappingError('Wrapped data key has an unexpected length');
      }

      const nonce = wrapped.wrappedDataKey.subarray(0, NONCE_BYTES);
      const authenticationTag = wrapped.wrappedDataKey.subarray(
        NONCE_BYTES,
        NONCE_BYTES + AUTHENTICATION_TAG_BYTES,
      );
      const ciphertext = wrapped.wrappedDataKey.subarray(NONCE_BYTES + AUTHENTICATION_TAG_BYTES);

      const decipher = createDecipheriv(ALGORITHM, keyEncryptionKey, nonce, {
        authTagLength: AUTHENTICATION_TAG_BYTES,
      });
      decipher.setAAD(additionalAuthenticatedData);
      decipher.setAuthTag(authenticationTag);

      try {
        // Bound for the same reason the seed is: concat copies, and what `update` returns already
        // holds the whole unwrapped data key.
        const head = decipher.update(ciphertext);
        const tail = decipher.final();
        try {
          return Buffer.concat([head, tail]);
        } finally {
          zeroBuffer(head);
          zeroBuffer(tail);
        }
      } catch {
        // The message is deliberately uninformative: distinguishing a wrong key from wrong
        // additional data tells an attacker which half of the guess was right.
        throw new KeyWrappingError('Could not unwrap the data key');
      }
    },
  };
}

export type KeyWrapperRegistry = Readonly<Record<KeyWrappingScheme, KeyWrapper>>;

export function createKeyWrapperRegistry(
  keyEncryptionKey: Buffer,
  keyIdentifier: string,
): KeyWrapperRegistry {
  return Object.freeze({
    AESGCM256_LOCALKEY_V1: createLocalKeyWrapper(keyEncryptionKey, keyIdentifier),
  });
}

/**
 * Overwrites key material once it is no longer needed. This does not make recovery impossible — a
 * garbage collector may already have copied the buffer — but it shortens the window in which a heap
 * dump contains a usable key, and it costs nothing.
 */
export function zeroBuffer(buffer: Buffer): void {
  buffer.fill(0);
}
