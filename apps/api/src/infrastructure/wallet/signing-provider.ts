import { HDKey } from '@scure/bip32';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { toCanonicalAddress, type Environment } from '@cryptopay/shared';

import type { WalletSeedRepository } from '../persistence/wallet-seed.repository.js';
import { MissingWalletSeedError } from './allocator-provider.js';
import { type KeyWrapperRegistry, zeroBuffer } from './key-wrapping.js';
import { openSeed } from './master-seed.js';

/**
 * The only place in the system that produces a signing key.
 *
 * Everything else that touches the wallet holds public material: the allocator wipes the private
 * half of the account key before it issues a single address, so the payment creation path — the
 * most exposed code in the product — cannot sign even if it is compromised. Signing lives here,
 * behind a callback, so a key cannot be returned to a caller and stored somewhere it outlives its
 * purpose.
 *
 * The treasury sits on a hardened account of its own rather than beside the deposit addresses. A
 * leaked deposit child key plus the account extended public key exposes every sibling in that
 * branch, which is the known limitation of non-hardened derivation; putting the treasury behind a
 * hardened index means that exposure stops at the deposit addresses and never reaches the account
 * that holds the gas.
 *
 * The seed is opened for each signature rather than cached. A settlement signs at most twice, so
 * the cost is a database read and one decryption, and in exchange the plaintext seed is absent from
 * memory for all but a few milliseconds of the process's life.
 */

const DEPOSIT_ACCOUNT_PATH = "m/44'/60'/0'/0";
const TREASURY_PATH = "m/44'/60'/1'/0/0";

export type SigningPath =
  { readonly kind: 'treasury' } | { readonly kind: 'deposit'; readonly derivationIndex: number };

class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

function pathFor(path: SigningPath): string {
  if (path.kind === 'treasury') {
    return TREASURY_PATH;
  }
  return `${DEPOSIT_ACCOUNT_PATH}/${path.derivationIndex.toString()}`;
}

export class WalletSigningProvider {
  private readonly walletSeedRepository: WalletSeedRepository;
  private readonly wrappers: KeyWrapperRegistry;

  constructor(walletSeedRepository: WalletSeedRepository, wrappers: KeyWrapperRegistry) {
    this.walletSeedRepository = walletSeedRepository;
    this.wrappers = wrappers;
  }

  /**
   * Derives the key, hands it to `use`, and drops it. The callback shape is the point: a method
   * returning a key would let a caller keep one, and every such key is one more place a compromise
   * can start.
   */
  async withAccount<T>(
    environment: Environment,
    path: SigningPath,
    use: (account: PrivateKeyAccount) => Promise<T>,
  ): Promise<T> {
    const sealed = await this.walletSeedRepository.find(environment);
    if (sealed === null) {
      throw new MissingWalletSeedError(environment);
    }

    const seed = openSeed(sealed, environment, this.wrappers);
    // Copied because `fromMasterSeed` takes a Uint8Array, and zeroed alongside the original below:
    // clearing only the Buffer would leave the same bytes reachable through the copy.
    const seedBytes = Uint8Array.from(seed);
    let master: HDKey | null = null;
    let child: HDKey | null = null;
    try {
      master = HDKey.fromMasterSeed(seedBytes);
      child = master.derive(pathFor(path));
      const privateKey = child.privateKey;
      if (privateKey === null) {
        throw new SigningKeyError(`No private key could be derived at ${pathFor(path)}`);
      }

      const account = privateKeyToAccount(`0x${Buffer.from(privateKey).toString('hex')}`);
      return await use(account);
    } finally {
      child?.wipePrivateData();
      master?.wipePrivateData();
      seedBytes.fill(0);
      zeroBuffer(seed);
    }
  }

  /**
   * The treasury's address, without signing anything. Needed by readiness reporting and by the
   * operator console, both of which have to show an operator where to send gas.
   */
  async treasuryAccount(environment: Environment): Promise<string> {
    return this.withAccount(environment, { kind: 'treasury' }, (account) =>
      Promise.resolve(toCanonicalAddress(account.address)),
    );
  }
}
