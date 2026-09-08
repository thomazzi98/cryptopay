import {
  isNetworkIdentifier,
  parseAmountToBaseUnits,
  type CreatePaymentRequest,
  type Environment,
  type NetworkIdentifier,
} from '@cryptopay/shared';
import type { PoolClient } from 'pg';

import { createPayment, type Payment } from '../domain/payment.js';
import {
  checkDestinationShape,
  type DestinationPolicyOptions,
} from '../infrastructure/callbacks/destination-policy.js';
import {
  findAllowedAsset,
  networkConfigurationFor,
} from '../infrastructure/chain/network-configuration.js';
import type { BlockCursorRepository } from '../infrastructure/persistence/block-cursor.repository.js';
import type { Merchant } from '../infrastructure/persistence/merchant.repository.js';
import {
  DuplicateMerchantReferenceError,
  type PaymentRepository,
} from '../infrastructure/persistence/payment.repository.js';
import type { WalletSeedRepository } from '../infrastructure/persistence/wallet-seed.repository.js';
import type { HierarchicalDeterministicAllocator } from '../infrastructure/wallet/hierarchical-deterministic-allocator.js';
import type { UlidFactory } from '../infrastructure/system/ulid.js';

/**
 * Creating a payment: validate against what this environment can actually settle, issue an address
 * nobody else will ever be given, and write both in one transaction.
 */

export type CreatePaymentFailure =
  | { readonly reason: 'unknown_network'; readonly detail: string }
  | { readonly reason: 'environment_mismatch'; readonly detail: string }
  | { readonly reason: 'unknown_asset'; readonly detail: string }
  | { readonly reason: 'invalid_amount'; readonly detail: string }
  | { readonly reason: 'network_not_watched'; readonly detail: string }
  | { readonly reason: 'unreachable_callback'; readonly detail: string }
  | { readonly reason: 'duplicate_external_reference'; readonly detail: string };

export type CreatePaymentResult =
  | { readonly kind: 'created'; readonly payment: Payment }
  | { readonly kind: 'failed'; readonly failure: CreatePaymentFailure };

export interface CreatePaymentDependencies {
  readonly paymentRepository: PaymentRepository;
  readonly walletSeedRepository: WalletSeedRepository;
  readonly blockCursorRepository: BlockCursorRepository;
  readonly allocatorFor: (environment: Environment) => Promise<HierarchicalDeterministicAllocator>;
  readonly ulidFactory: UlidFactory;
  readonly now: () => Date;
  readonly randomToken: () => string;
  /**
   * The deployment's callback destination rules, so a merchant registering an unreachable URL is
   * told now rather than after a delivery is refused. The same function decides at delivery time.
   */
  readonly callbackDestinationPolicy: DestinationPolicyOptions;
}

export interface CreatePaymentCommand {
  readonly merchant: Merchant;
  readonly environment: Environment;
  readonly request: CreatePaymentRequest;
  /**
   * Runs inside the payment's transaction, with the payment that is being written. Used to store
   * the idempotent response beside the payment it describes, so neither can exist without the other.
   */
  readonly onPersist?: (client: PoolClient, payment: Payment) => Promise<void>;
}

function failed(failure: CreatePaymentFailure): CreatePaymentResult {
  return { kind: 'failed', failure };
}

export class CreatePaymentUseCase {
  private readonly dependencies: CreatePaymentDependencies;

  constructor(dependencies: CreatePaymentDependencies) {
    this.dependencies = dependencies;
  }

  async execute(command: CreatePaymentCommand): Promise<CreatePaymentResult> {
    const { merchant, environment, request } = command;

    if (!isNetworkIdentifier(request.network)) {
      return failed({ reason: 'unknown_network', detail: `Unknown network ${request.network}` });
    }
    const network: NetworkIdentifier = request.network;
    const configuration = networkConfigurationFor(network);

    // The environment carried by the API key decides which networks are reachable. The database
    // CHECK enforces the same rule, so this is the friendly error rather than the safety net.
    if (configuration.environment !== environment) {
      return failed({
        reason: 'environment_mismatch',
        detail: `A ${environment} API key cannot create payments on ${configuration.displayName}.`,
      });
    }

    const asset = findAllowedAsset(network, request.assetSymbol);
    if (asset === null) {
      return failed({
        reason: 'unknown_asset',
        detail: `${request.assetSymbol} is not settled on ${configuration.displayName}.`,
      });
    }

    let requestedAmountInBaseUnits: bigint;
    try {
      requestedAmountInBaseUnits = parseAmountToBaseUnits(request.amount, asset.decimals);
    } catch (error) {
      return failed({
        reason: 'invalid_amount',
        detail: error instanceof Error ? error.message : 'The amount could not be read.',
      });
    }
    if (requestedAmountInBaseUnits <= 0n) {
      return failed({ reason: 'invalid_amount', detail: 'The amount must be greater than zero.' });
    }

    // Checked now, with the same function the delivery worker uses, so a merchant learns their
    // callback is unreachable while they are looking at the response rather than from a delivery log
    // hours later. DNS is deliberately left to delivery time: resolving here would make payment
    // creation depend on a name server, and the answer can change before the first attempt anyway.
    const callbackUrl = request.callbackUrl;
    if (callbackUrl !== undefined && callbackUrl !== null) {
      const destination = checkDestinationShape(
        callbackUrl,
        this.dependencies.callbackDestinationPolicy,
      );
      if (!destination.allowed) {
        return failed({
          reason: 'unreachable_callback',
          detail: `The callback URL cannot be used: ${destination.reason}.`,
        });
      }
    }

    // Refusing here is deliberate. A payment created for a network no scanner is watching would
    // take the customer's money and never observe it.
    const cursor = await this.dependencies.blockCursorRepository.find(network);
    if (cursor === null) {
      return failed({
        reason: 'network_not_watched',
        detail: `${configuration.displayName} is not being scanned yet. Try again shortly.`,
      });
    }

    const derivationIndex =
      await this.dependencies.walletSeedRepository.nextDerivationIndex(environment);
    const allocator = await this.dependencies.allocatorFor(environment);
    const address = allocator.allocate(derivationIndex);

    const createdAt = this.dependencies.now();
    const identifier = `pay_${this.dependencies.ulidFactory.create(createdAt.getTime())}`;
    const payment = createPayment({
      identifier,
      merchantId: merchant.id,
      environment,
      networkIdentifier: network,
      checkoutToken: this.dependencies.randomToken(),
      asset: {
        networkIdentifier: network,
        reference: asset.reference,
        symbol: asset.symbol,
        decimals: asset.decimals,
      },
      requestedAmountInBaseUnits,
      underpaymentToleranceBasisPoints: merchant.underpaymentToleranceBasisPoints,
      overpaymentToleranceBasisPoints: merchant.overpaymentToleranceBasisPoints,
      receivingAccount: address.account,
      requiredConfirmations: configuration.requiredConfirmations,
      requiresFinalityTag: configuration.requiresFinalityTag,
      // The floor a cold start rewinds to. Recorded so a fresh install, a restored backup and a
      // three-day outage all resume from a provably correct block rather than a magic lookback.
      createdAtBlockHeight: cursor.lastScannedHeight,
      merchantReference: request.merchantReference ?? null,
      callbackUrl: request.callbackUrl ?? null,
      metadata: request.metadata ?? {},
      createdAt,
      lifetimeSeconds: request.expiresInSeconds ?? merchant.defaultPaymentLifetimeSeconds,
    });

    const onPersist = command.onPersist;
    const withinTransaction =
      onPersist === undefined
        ? undefined
        : async (client: PoolClient): Promise<void> => {
            await onPersist(client, payment);
          };

    try {
      await this.dependencies.paymentRepository.create({
        payment,
        address,
        addressIdentifier: `adr_${this.dependencies.ulidFactory.create(createdAt.getTime())}`,
        derivationIndex,
        ...(withinTransaction !== undefined && { withinTransaction }),
      });
    } catch (error) {
      // One external reference identifies one payment for a merchant in an environment. Letting the
      // constraint escape as a driver error answered 500 and told the caller nothing about what to
      // change; the rule itself is worth keeping, because it is what stops a retried order becoming
      // two payments for the same goods.
      if (error instanceof DuplicateMerchantReferenceError) {
        return failed({
          reason: 'duplicate_external_reference',
          detail:
            'A payment already exists for this external reference. Use the existing payment, or a different reference.',
        });
      }
      throw error;
    }

    return { kind: 'created', payment };
  }
}
