import { randomBytes, randomInt } from 'node:crypto';

import type { Pool } from 'pg';

import { CancelPaymentUseCase } from './application/cancel-payment.use-case.js';
import { CreatePaymentUseCase } from './application/create-payment.use-case.js';
import { DeliverCallbacksUseCase } from './application/deliver-callbacks.use-case.js';
import { EvaluatePaymentsUseCase } from './application/evaluate-payments.use-case.js';
import { ScanNetworkUseCase } from './application/scan-network.use-case.js';
import { LIVE_RETRY_POLICY, TEST_RETRY_POLICY } from './domain/webhook-retry.js';
import { sendCallback } from './infrastructure/callbacks/callback-transport.js';
import { resolveSystemAddresses } from './infrastructure/callbacks/address-resolver.js';
import { type Configuration, loadConfiguration, rpcUrlsFor } from './configuration.js';
import { buildServer } from './http/build-server.js';
import type { ApplicationServer } from './http/server-types.js';
import { EvmChainGateway } from './infrastructure/chain/evm-chain-gateway.js';
import {
  NETWORK_CONFIGURATIONS,
  registerLocalDevelopmentAsset,
} from './infrastructure/chain/network-configuration.js';
import { BlockCursorRepository } from './infrastructure/persistence/block-cursor.repository.js';
import { ChainScanStore } from './infrastructure/persistence/chain-scan.store.js';
import { createDatabasePool } from './infrastructure/persistence/database.js';
import { EvaluationQueueRepository } from './infrastructure/persistence/evaluation-queue.repository.js';
import { IdempotencyRepository } from './infrastructure/persistence/idempotency.repository.js';
import { LeaderLeaseRepository } from './infrastructure/persistence/leader-lease.repository.js';
import { MerchantRepository } from './infrastructure/persistence/merchant.repository.js';
import { ObservedBlockRepository } from './infrastructure/persistence/observed-block.repository.js';
import { PaymentRepository } from './infrastructure/persistence/payment.repository.js';
import { PaymentTransferRepository } from './infrastructure/persistence/payment-transfer.repository.js';
import { WalletSeedRepository } from './infrastructure/persistence/wallet-seed.repository.js';
import { WebhookDeliveryRepository } from './infrastructure/persistence/webhook-delivery.repository.js';
import { WebhookSecretRepository } from './infrastructure/persistence/webhook-secret.repository.js';
import { UlidFactory } from './infrastructure/system/ulid.js';
import { WalletAllocatorProvider } from './infrastructure/wallet/allocator-provider.js';
import { createKeyWrapperRegistry } from './infrastructure/wallet/key-wrapping.js';
import { createLogger, type StructuredLogger } from './observability/logger.js';
import { CallbackWorker } from './workers/callback-worker.js';
import { NetworkWorker } from './workers/network-worker.js';

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
  const paymentTransferRepository = new PaymentTransferRepository(databasePool);
  const webhookDeliveryRepository = new WebhookDeliveryRepository(databasePool);
  const webhookSecretRepository = new WebhookSecretRepository(databasePool);
  const evaluationQueueRepository = new EvaluationQueueRepository(databasePool);

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
    // The same rules the delivery worker applies, so a merchant is refused at creation for exactly
    // the reason a delivery would have been refused later.
    callbackDestinationPolicy: {
      privateDestinationAllowlist: configuration.callbackPrivateDestinationAllowlist,
      allowlistIsPermitted: configuration.nodeEnvironment !== 'production',
    },
  });
  const paymentCanceler = new CancelPaymentUseCase({
    paymentRepository,
    ulidFactory,
    checkoutBaseUrl: configuration.publicCheckoutBaseUrl,
    now: () => new Date(),
  });

  return buildServer({
    configuration,
    logger,
    merchantRepository,
    paymentRepository,
    idempotencyRepository,
    paymentCreator,
    paymentCanceler,
    paymentTransferRepository,
    webhookDeliveryRepository,
    webhookSecretRepository,
    blockCursorRepository,
    ulidFactory,
    evaluationQueueRepository,
  });
}

export interface BackgroundWorker {
  readonly logger: StructuredLogger;
  readonly databasePool: Pool;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The callback worker, composed separately because it is deployed separately.
 *
 * It is the only part of the system that makes outbound requests to addresses a stranger chose, so
 * it runs in its own container with its own database role and its own network policy. Composing it
 * here rather than folding it into the API is what keeps that separation real rather than aspirational.
 */
export function composeCallbackWorker(
  source: NodeJS.ProcessEnv,
  workerIdentity: string,
): BackgroundWorker {
  const configuration = loadConfiguration(source);
  const logger = createLogger(configuration);
  const databasePool = createDatabasePool(configuration);

  const deliverer = new DeliverCallbacksUseCase({
    webhookDeliveryRepository: new WebhookDeliveryRepository(databasePool),
    webhookSecretRepository: new WebhookSecretRepository(databasePool),
    transport: sendCallback,
    resolveAddresses: resolveSystemAddresses,
    // The test schedule finishes inside half an hour, which is what a developer watching a failing
    // endpoint needs; the live one spans two days, which is what a merchant who was down needs.
    retryPolicy:
      configuration.nodeEnvironment === 'production' ? LIVE_RETRY_POLICY : TEST_RETRY_POLICY,
    privateDestinationAllowlist: configuration.callbackPrivateDestinationAllowlist,
    // Operations holds this condition. The merchant's choice of API key holds the other one, and the
    // use case requires both.
    allowlistIsPermittedByDeployment: configuration.nodeEnvironment !== 'production',
    workerIdentity,
    now: () => new Date(),
    randomFraction: () => randomInt(0, 1_000_000) / 1_000_000,
  });

  const worker = new CallbackWorker({ deliverer, logger });

  return {
    logger,
    databasePool,
    start: () => worker.start(),
    stop: () => {
      worker.stop();
      return Promise.resolve();
    },
  };
}

/**
 * The chain worker watches every network that has an RPC endpoint configured, and no others.
 *
 * Deriving the list from configuration rather than from a separate setting removes a whole class of
 * mistake: there is no way to name a network to watch and forget to give it an endpoint, and no way
 * to configure an endpoint that silently goes unwatched.
 */
export function composeChainWorker(
  source: NodeJS.ProcessEnv,
  holderIdentity: string,
): BackgroundWorker {
  const configuration = loadConfiguration(source);
  const logger = createLogger(configuration);
  const databasePool = createDatabasePool(configuration);

  if (configuration.localAnvilUsdcAddress !== undefined) {
    registerLocalDevelopmentAsset({
      reference: configuration.localAnvilUsdcAddress,
      symbol: 'USDC',
      decimals: 6,
    });
  }

  const paymentRepository = new PaymentRepository(databasePool);
  const paymentTransferRepository = new PaymentTransferRepository(databasePool);
  const blockCursorRepository = new BlockCursorRepository(databasePool);
  const observedBlockRepository = new ObservedBlockRepository(databasePool);
  const chainScanStore = new ChainScanStore(databasePool);
  const leaseRepository = new LeaderLeaseRepository(databasePool);
  const evaluationQueueRepository = new EvaluationQueueRepository(databasePool);
  const ulidFactory = new UlidFactory();

  const workers = Object.values(NETWORK_CONFIGURATIONS)
    .filter((network) => rpcUrlsFor(configuration, network.networkIdentifier).length > 0)
    .map((network) => {
      const rpcUrls = rpcUrlsFor(configuration, network.networkIdentifier);
      const gateway = new EvmChainGateway({
        networkIdentifier: network.networkIdentifier,
        chainIdentifier: network.chainIdentifier,
        rpcUrls,
        supportsFinalityTag: network.requiresFinalityTag,
        // The endpoints after the first, so the second opinion never comes from the endpoint that
        // gave the first one. With a single endpoint configured there is no quorum, and a payment
        // requiring the finality tag holds rather than completing on one provider's word.
        finalityQuorumRpcUrls: rpcUrls.slice(1),
      });

      return new NetworkWorker({
        gateway,
        scanner: new ScanNetworkUseCase({
          gateway,
          paymentRepository,
          paymentTransferRepository,
          blockCursorRepository,
          observedBlockRepository,
          chainScanStore,
          ulidFactory,
          now: () => new Date(),
        }),
        evaluator: new EvaluatePaymentsUseCase({
          gateway,
          paymentRepository,
          paymentTransferRepository,
          evaluationQueueRepository,
          now: () => new Date(),
          workerIdentity: holderIdentity,
          ulidFactory,
          checkoutBaseUrl: configuration.publicCheckoutBaseUrl,
        }),
        leaseRepository,
        blockCursorRepository,
        logger,
        holderIdentity,
        options: {
          leaseSeconds: configuration.scannerLeaseSeconds,
          pollIntervalMilliseconds: configuration.scannerPollIntervalMilliseconds,
          errorBackoffMilliseconds: configuration.scannerPollIntervalMilliseconds * 3,
          initialScanRange: 20,
        },
      });
    });

  return {
    logger,
    databasePool,
    start: async () => {
      if (workers.length === 0) {
        throw new Error(
          'The chain worker has no network to watch. Configure at least one of ' +
            'POLYGON_MAINNET_RPC_URLS, POLYGON_AMOY_RPC_URLS or LOCAL_ANVIL_RPC_URLS.',
        );
      }
      // Identity is asserted before any scanning starts, so an endpoint quietly serving a different
      // chain stops the process rather than producing payments that can never be confirmed.
      await Promise.all(workers.map((worker) => worker.prepare()));
      await Promise.all(workers.map((worker) => worker.start()));
    },
    stop: async () => {
      await Promise.all(workers.map((worker) => worker.stop()));
    },
  };
}
