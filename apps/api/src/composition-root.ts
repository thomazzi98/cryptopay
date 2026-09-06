import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import { CancelPaymentUseCase } from './application/cancel-payment.use-case.js';
import { CreatePaymentUseCase } from './application/create-payment.use-case.js';
import { type Configuration, loadConfiguration } from './configuration.js';
import { buildServer } from './http/build-server.js';
import type { ApplicationServer } from './http/server-types.js';
import { BlockCursorRepository } from './infrastructure/persistence/block-cursor.repository.js';
import { createDatabasePool } from './infrastructure/persistence/database.js';
import { IdempotencyRepository } from './infrastructure/persistence/idempotency.repository.js';
import { MerchantRepository } from './infrastructure/persistence/merchant.repository.js';
import { PaymentRepository } from './infrastructure/persistence/payment.repository.js';
import { WalletSeedRepository } from './infrastructure/persistence/wallet-seed.repository.js';
import { UlidFactory } from './infrastructure/system/ulid.js';
import { WalletAllocatorProvider } from './infrastructure/wallet/allocator-provider.js';
import { createKeyWrapperRegistry } from './infrastructure/wallet/key-wrapping.js';
import { createLogger } from './observability/logger.js';

/**
 * Explicit construction, in one place, in dependency order.
 *
 * This is what a dependency-injection container would do, written out. The wiring is greppable, the
 * order is visible, and there is no runtime resolution step that can fail on a name that was only
 * ever a string.
 */

const CHECKOUT_TOKEN_BYTES = 32;

export interface Application {
  readonly configuration: Configuration;
  readonly server: ApplicationServer;
  readonly databasePool: Pool;
}

export function composeApplication(source: NodeJS.ProcessEnv): Application {
  const configuration = loadConfiguration(source);
  const logger = createLogger(configuration);
  const databasePool = createDatabasePool(configuration);

  return {
    configuration,
    server: buildApplicationServer(configuration, logger, databasePool),
    databasePool,
  };
}

export function buildApplicationServer(
  configuration: Configuration,
  logger: ReturnType<typeof createLogger>,
  databasePool: Pool,
): ApplicationServer {
  const merchantRepository = new MerchantRepository(databasePool);
  const paymentRepository = new PaymentRepository(databasePool);
  const idempotencyRepository = new IdempotencyRepository(databasePool);
  const walletSeedRepository = new WalletSeedRepository(databasePool);
  const blockCursorRepository = new BlockCursorRepository(databasePool);

  const walletAllocators = new WalletAllocatorProvider(
    walletSeedRepository,
    createKeyWrapperRegistry(
      Buffer.from(configuration.walletKeyEncryptionKey, 'base64'),
      'local-key-1',
    ),
  );

  const ulidFactory = new UlidFactory();
  const paymentCreator = new CreatePaymentUseCase({
    paymentRepository,
    walletSeedRepository,
    blockCursorRepository,
    allocatorFor: (environment) => walletAllocators.allocatorFor(environment),
    ulidFactory,
    now: () => new Date(),
    randomToken: () => randomBytes(CHECKOUT_TOKEN_BYTES).toString('base64url'),
  });
  const paymentCanceler = new CancelPaymentUseCase(paymentRepository);

  return buildServer({
    configuration,
    logger,
    merchantRepository,
    paymentRepository,
    idempotencyRepository,
    paymentCreator,
    paymentCanceler,
  });
}
