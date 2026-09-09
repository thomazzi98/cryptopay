import type { Environment, NetworkFamily } from '@cryptopay/shared';

import type { WalletSeedRepository } from '../persistence/wallet-seed.repository.js';
import { allocateSolanaDestination } from './ed25519-allocator.js';
import { HierarchicalDeterministicAllocator } from './hierarchical-deterministic-allocator.js';
import { type KeyWrapperRegistry, zeroBuffer } from './key-wrapping.js';
import { openSeed } from './master-seed.js';
import type {
  AddressStrategy,
  PaymentDestination,
  PublicKeyAllocator,
} from './payment-destination.js';

/**
 * The one place a master seed is opened to issue a payment destination.
 *
 * Two families are served without the creation path ever holding a private key: secp256k1 supports
 * non-hardened derivation, so their seed is opened once, converted to an account-level public key,
 * and zeroed. The resulting allocator is cached because it is public material and cannot sign.
 *
 * Solana cannot be served that way. Ed25519 derivation is hardened-only, so a seed is required for
 * every address. That seed is opened per allocation and zeroed in a `finally`, deliberately not
 * cached: a cached seed would sit in process memory for the life of the deployment, which is a
 * strictly worse exposure than a decryption per payment creation. The same trade is already made,
 * for the same reason, in the signing provider.
 */

export class MissingWalletSeedError extends Error {
  constructor(environment: Environment) {
    super(
      `No master seed has been provisioned for the ${environment} environment. ` +
        `Run: npm run wallet:provision --workspace @cryptopay/api -- ${environment}`,
    );
    this.name = 'MissingWalletSeedError';
  }
}

const STRATEGIES: Readonly<Record<NetworkFamily, AddressStrategy>> = Object.freeze({
  polygon: Object.freeze({
    kind: 'public-key-only',
    fromSeed: (seed: Buffer) => new HierarchicalDeterministicAllocator(seed, 'polygon'),
  }),
  tron: Object.freeze({
    kind: 'public-key-only',
    fromSeed: (seed: Buffer) => new HierarchicalDeterministicAllocator(seed, 'tron'),
  }),
  solana: Object.freeze({
    kind: 'requires-seed',
    deriveWithSeed: allocateSolanaDestination,
  }),
});

export class WalletAllocatorProvider {
  private readonly walletSeedRepository: WalletSeedRepository;
  private readonly wrappers: KeyWrapperRegistry;
  private readonly allocators = new Map<string, PublicKeyAllocator>();

  constructor(walletSeedRepository: WalletSeedRepository, wrappers: KeyWrapperRegistry) {
    this.walletSeedRepository = walletSeedRepository;
    this.wrappers = wrappers;
  }

  async destinationFor(
    environment: Environment,
    family: NetworkFamily,
    derivationIndex: number,
  ): Promise<PaymentDestination> {
    const strategy = STRATEGIES[family];
    if (strategy.kind === 'requires-seed') {
      return this.withSeed(environment, (seed) => strategy.deriveWithSeed(seed, derivationIndex));
    }

    const cacheKey = `${environment}:${family}`;
    const cached = this.allocators.get(cacheKey);
    if (cached !== undefined) {
      return cached.allocate(derivationIndex);
    }

    const allocator = await this.withSeed(environment, (seed) => strategy.fromSeed(seed));
    this.allocators.set(cacheKey, allocator);
    return allocator.allocate(derivationIndex);
  }

  /**
   * Opens the environment's seed, runs one function against it, and zeroes it. Loading lazily
   * rather than at startup means an installation that never touches live keeps its live seed
   * sealed, and an installation with no seed at all fails on the request that needs one with a
   * message naming the command to fix it, rather than refusing to boot.
   */
  private async withSeed<T>(environment: Environment, use: (seed: Buffer) => T): Promise<T> {
    const sealed = await this.walletSeedRepository.find(environment);
    if (sealed === null) {
      throw new MissingWalletSeedError(environment);
    }

    const seed = openSeed(sealed, environment, this.wrappers);
    try {
      return use(seed);
    } finally {
      zeroBuffer(seed);
    }
  }
}
