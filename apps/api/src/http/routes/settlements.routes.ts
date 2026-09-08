import {
  isNetworkIdentifier,
  SetPayoutDestinationRequestSchema,
  type PayoutDestinationList,
  type SettlementList,
  type TreasuryReportList,
} from '@cryptopay/shared';

import { spendCeilingFor, type Configuration } from '../../configuration.js';
import { networkConfigurationFor } from '../../infrastructure/chain/network-configuration.js';
import { explorerTransactionUrl } from '../../infrastructure/chain/network-configuration.js';
import { costOf } from '../../domain/spend-ceiling.js';
import type {
  ChainTransaction,
  Settlement,
  SettlementRepository,
} from '../../infrastructure/persistence/settlement.repository.js';
import { requireMerchant, type AuthenticationHook } from '../authentication.js';
import { ApplicationError } from '../problem-details.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * Where the money went, and what it cost to send it.
 *
 * Everything here is a read except setting a payout destination. The API cannot sign and holds no
 * key material, so it reports settlement rather than performing it: the worker that can sign is a
 * separate process with a separate database role, and the separation only means something if the
 * HTTP tier stays on this side of it.
 *
 * The treasury balance is served as the settlement worker last observed it, with the time it did.
 * Reading the chain on request would turn an operator refreshing a page into RPC load and would
 * still be showing a number from a moment ago.
 */

export interface SettlementRouteDependencies {
  readonly authenticate: AuthenticationHook;
  readonly configuration: Configuration;
  readonly settlementRepository: SettlementRepository;
}

const MAXIMUM_SETTLEMENTS_PER_PAGE = 100;

function presentTransaction(transaction: ChainTransaction) {
  return {
    purpose: transaction.purpose,
    status: transaction.status,
    sourceAccount: transaction.sourceAccount,
    destinationAccount: transaction.destinationAccount,
    transactionReference: transaction.transactionReference,
    sequenceNumber: transaction.sequenceNumber,
    valueInNativeUnits: transaction.valueInNativeUnits.toString(),
    maximumFeeInNativeUnits: transaction.maximumFeeInNativeUnits.toString(),
    feePaidInNativeUnits: transaction.feePaidInNativeUnits?.toString() ?? null,
    computeUsed: transaction.computeUsed?.toString() ?? null,
    feeParameters: transaction.feeParameters,
    blockHeight: transaction.blockHeight?.toString() ?? null,
    explorerUrl: explorerTransactionUrl(
      transaction.networkIdentifier,
      transaction.transactionReference,
    ),
    failureReason: transaction.failureReason,
    submittedAt: transaction.submittedAt.toISOString(),
    confirmedAt: transaction.confirmedAt?.toISOString() ?? null,
  };
}

function presentSettlement(settlement: Settlement, transactions: readonly ChainTransaction[]) {
  const network = networkConfigurationFor(settlement.networkIdentifier);
  const asset = network.assetAllowlist.find(
    (candidate) => candidate.reference === settlement.assetReference,
  );
  const decimals = asset?.decimals ?? 0;

  return {
    identifier: settlement.identifier,
    paymentIdentifier: settlement.paymentId,
    network: settlement.networkIdentifier,
    environment: settlement.environment,
    status: settlement.status,
    sourceAccount: settlement.sourceAccount,
    destinationAccount: settlement.destinationAccount,
    asset: {
      reference: settlement.assetReference,
      symbol: asset?.symbol ?? 'UNKNOWN',
      decimals,
    },
    amount: {
      baseUnits: settlement.amountInBaseUnits.toString(),
      display: formatBaseUnits(settlement.amountInBaseUnits, decimals),
    },
    attemptCount: settlement.attemptCount,
    failureReason: settlement.failureReason,
    transactions: transactions.map((transaction) => presentTransaction(transaction)),
    createdAt: settlement.createdAt.toISOString(),
    settledAt: settlement.settledAt?.toISOString() ?? null,
  };
}

/** Local rather than imported, because the shared helper takes an asset and this takes decimals. */
function formatBaseUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) {
    return amount.toString();
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(decimals, '0');
  return `${whole.toString()}.${fraction}`;
}

export function registerSettlementRoutes(
  server: ApplicationServer,
  dependencies: SettlementRouteDependencies,
): void {
  server.get(
    '/v1/settlements',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const settlements = await dependencies.settlementRepository.listForMerchant(
        authenticated.merchantId,
        authenticated.environment,
        MAXIMUM_SETTLEMENTS_PER_PAGE,
      );

      const withTransactions = await Promise.all(
        settlements.map(async (settlement) => ({
          settlement,
          transactions: await dependencies.settlementRepository.transactionsFor(
            settlement.identifier,
          ),
        })),
      );

      const body: SettlementList = {
        data: withTransactions.map((entry) =>
          presentSettlement(entry.settlement, entry.transactions),
        ),
        hasMore: settlements.length === MAXIMUM_SETTLEMENTS_PER_PAGE,
        nextCursor: null,
      };
      await reply.code(200).send(body);
    },
  );

  server.get<{ Params: { paymentId: string } }>(
    '/v1/payments/:paymentId/settlement',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const settlement = await dependencies.settlementRepository.findByPayment(
        request.params.paymentId,
      );

      // Scoped by merchant and environment for the same reason every other single-resource read is:
      // a resource belonging to someone else must be indistinguishable from one that does not exist.
      if (
        settlement?.merchantId !== authenticated.merchantId ||
        settlement.environment !== authenticated.environment
      ) {
        throw new ApplicationError('resource_not_found', 'No settlement exists for that payment.');
      }

      const transactions = await dependencies.settlementRepository.transactionsFor(
        settlement.identifier,
      );
      await reply.code(200).send(presentSettlement(settlement, transactions));
    },
  );

  /**
   * What this deployment can still spend, per network.
   *
   * The ceiling is enforced in the settlement worker before anything is signed; this endpoint only
   * reports it. An operator watching a mainnet rehearsal needs to see the committed figure move, and
   * needs it to be the same figure the worker refuses on.
   */
  server.get('/v1/treasury', { preHandler: dependencies.authenticate }, async (request, reply) => {
    const authenticated = requireMerchant(request);
    const treasuries = await dependencies.settlementRepository.findTreasuries();

    const reports = await Promise.all(
      treasuries
        .filter((treasury) => treasury.environment === authenticated.environment)
        .map(async (treasury) => {
          const network = networkConfigurationFor(treasury.networkIdentifier);
          const spends = await dependencies.settlementRepository.treasurySpends(
            treasury.networkIdentifier,
            treasury.account,
          );
          const committed = spends.reduce((running, spend) => running + costOf(spend), 0n);
          const ceiling = spendCeilingFor(dependencies.configuration, treasury.networkIdentifier);

          return {
            network: treasury.networkIdentifier,
            displayName: network.displayName,
            environment: treasury.environment,
            account: treasury.account,
            nativeCurrency: network.nativeCurrency,
            balanceInNativeUnits: treasury.balanceInNativeUnits?.toString() ?? null,
            ceilingInNativeUnits: ceiling?.toString() ?? null,
            committedInNativeUnits: committed.toString(),
            remainingInNativeUnits:
              ceiling === null ? null : (ceiling > committed ? ceiling - committed : 0n).toString(),
            settlementEnabled: dependencies.configuration.settlementEnabled,
          };
        }),
    );

    const body: TreasuryReportList = { data: reports };
    await reply.code(200).send(body);
  });

  server.get(
    '/v1/payout-destinations',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const destinations = await dependencies.settlementRepository.findPayoutDestinations(
        authenticated.merchantId,
        authenticated.environment,
      );

      const body: PayoutDestinationList = {
        data: destinations.map((destination) => ({
          network: destination.networkIdentifier,
          environment: authenticated.environment,
          account: destination.account,
          updatedAt: destination.updatedAt.toISOString(),
        })),
      };
      await reply.code(200).send(body);
    },
  );

  /**
   * Sets where settled funds are sent.
   *
   * Per network as well as per environment. An address a merchant controls on Polygon is not
   * necessarily theirs on another chain — a contract wallet at the same address may not exist, or
   * may belong to someone else — and defaulting one network's destination from another is how funds
   * are sent somewhere nobody can reach.
   */
  server.put<{ Params: { network: string } }>(
    '/v1/payout-destinations/:network',
    { preHandler: dependencies.authenticate },
    async (request, reply) => {
      const authenticated = requireMerchant(request);
      const network = request.params.network;
      if (!isNetworkIdentifier(network)) {
        throw new ApplicationError('validation_failed', 'No such network.');
      }

      const configuration = networkConfigurationFor(network);
      if (configuration.environment !== authenticated.environment) {
        throw new ApplicationError(
          'validation_failed',
          `${network} belongs to the ${configuration.environment} environment and this key does not.`,
        );
      }

      const parsed = SetPayoutDestinationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApplicationError(
          'validation_failed',
          'A payout destination must be a lowercase account address.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }

      await dependencies.settlementRepository.setPayoutDestination(
        authenticated.merchantId,
        authenticated.environment,
        network,
        parsed.data.account,
      );

      request.log.info(
        {
          event: 'settlement.payout_destination_set',
          network,
          environment: authenticated.environment,
        },
        'A merchant set where settled funds are sent',
      );

      await reply.code(200).send({
        network,
        environment: authenticated.environment,
        account: parsed.data.account,
        updatedAt: new Date().toISOString(),
      });
    },
  );
}
