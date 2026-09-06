import type { Environment } from '@cryptopay/shared';

import type { WalletSeedRepository } from '../persistence/wallet-seed.repository.js';
import { HierarchicalDeterministicAllocator } from './hierarchical-deterministic-allocator.js';
import { type KeyWrapperRegistry, zeroBuffer } from './key-wrapping.js';
import { openSeed } from './master-seed.js';

/**
 * Opens each environment's seed once, on first use, and keeps only the resulting public-key
 * allocator.
 *
 * Loading lazily rather than at startup means an installation that never touches live keeps its live
 * seed sealed, and an installation with no seed at all fails on the request that needs one with a
 * message naming the command to fix it, rather than refusing to boot.
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

export class WalletAllocatorProvider {
  private readonly walletSeedRepository: WalletSeedRepository;
  private readonly wrappers: KeyWrapperRegistry;
  private readonly allocators = new Map<Environment, HierarchicalDeterministicAllocator>();

  constructor(walletSeedRepository: WalletSeedRepository, wrappers: KeyWrapperRegistry) {
    this.walletSeedRepository = walletSeedRepository;
    this.wrappers = wrappers;
  }

  async allocatorFor(environment: Environment): Promise<HierarchicalDeterministicAllocator> {
    const cached = this.allocators.get(environment);
    if (cached !== undefined) {
      return cached;
    }

    const sealed = await this.walletSeedRepository.find(environment);
    if (sealed === null) {
      throw new MissingWalletSeedError(environment);
    }

    const seed = openSeed(sealed, environment, this.wrappers);
    try {
      const allocator = new HierarchicalDeterministicAllocator(seed);
      this.allocators.set(environment, allocator);
      return allocator;
    } finally {
      // The plaintext seed exists only for the moment it takes to derive the account key.
      zeroBuffer(seed);
    }
  }
}
