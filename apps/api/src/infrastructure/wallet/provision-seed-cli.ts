import { isEnvironment } from '@cryptopay/shared';
import { Pool } from 'pg';

import { loadConfiguration } from '../../configuration.js';
import { WalletSeedRepository } from '../persistence/wallet-seed.repository.js';
import { UlidFactory } from '../system/ulid.js';
import { createLocalKeyWrapper, zeroBuffer } from './key-wrapping.js';
import { generateMasterSeed, sealSeed } from './master-seed.js';

/**
 * Provisions the master seed for one environment.
 *
 * The seed is generated, sealed and stored without ever being printed. A seed that appears on a
 * terminal is a seed in a scrollback buffer, a screenshot and a shell history file.
 *
 * Run once per environment. A second run is refused rather than overwriting, because replacing a
 * seed strands every address already issued from the previous one.
 */

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (requested === undefined || !isEnvironment(requested)) {
    process.stderr.write(
      'Usage: npm run wallet:provision --workspace @cryptopay/api -- <test|live>\n',
    );
    process.exit(64);
  }

  const configuration = loadConfiguration(process.env);
  const pool = new Pool({ connectionString: configuration.databaseUrl });
  const seed = generateMasterSeed();

  try {
    const wrapper = createLocalKeyWrapper(
      Buffer.from(configuration.walletKeyEncryptionKey, 'base64'),
      'local-key-1',
    );
    const repository = new WalletSeedRepository(pool);
    const stored = await repository.storeIfAbsent(
      `sed_${new UlidFactory().create(Date.now())}`,
      requested,
      sealSeed(seed, requested, wrapper),
    );

    if (!stored) {
      process.stderr.write(
        `The ${requested} environment already has a master seed. Replacing it would strand every address already issued.\n`,
      );
      process.exit(1);
    }

    process.stdout.write(`Sealed a new master seed for the ${requested} environment.\n`);
    process.stdout.write(
      'Back up WALLET_KEY_ENCRYPTION_KEY: without it the seed cannot be opened and the funds at every issued address are unreachable.\n',
    );
  } finally {
    zeroBuffer(seed);
    await pool.end();
  }
}

await main();
