import {
  formatBaseUnits,
  toPublicPaymentState,
  type GatewayPayment,
  type GatewayPaymentStatus,
  type GatewayTransaction,
} from '@cryptopay/shared';

import type { Payment } from '../../domain/payment.js';
import {
  explorerAccountUrl,
  explorerTransactionUrl,
  networkConfigurationFor,
} from '../../infrastructure/chain/network-configuration.js';
import { buildPaymentUri } from '../../infrastructure/chain/payment-uri.js';
import { renderPaymentQrCode } from '../../infrastructure/qr/qr-code.js';
import type { StoredTransfer } from '../../infrastructure/persistence/payment-transfer.repository.js';

/**
 * Turns the payment aggregate into the body an external gateway receives.
 *
 * Every field is named here rather than spread from the aggregate, so adding a column or a domain
 * field can never publish it by accident. There is no derivation index, no checkout token, no
 * internal status, no status version and no acceptance band: an orchestrator does not need them,
 * and a field nobody needs is a field that leaks.
 *
 * The payment URI and the QR code are produced here from the network's own builder, which is the
 * whole point of the contract. A caller integrating with CryptoPay never learns that Polygon uses
 * EIP-681, that Solana uses Solana Pay, or that TRON has ratified nothing.
 */

export interface GatewayPresentationContext {
  /**
   * Whether the network's scanner has advanced far enough to be watching this payment yet, which is
   * the difference between CREATED and WAITING_FOR_PAYMENT.
   */
  readonly monitoringHasReachedCreation: boolean;
}

function decimal(baseUnits: bigint, decimals: number): string {
  return formatBaseUnits(baseUnits, decimals);
}

/**
 * The public failure reason. Only an underpayment produces one today; the enum has a single member
 * because inventing a taxonomy for a set of size one produces an enum nobody can act on.
 */
function failureReasonFor(payment: Payment): 'insufficient_amount' | null {
  return payment.status === 'underpaid' ? 'insufficient_amount' : null;
}

function paymentUriFor(payment: Payment): string | null {
  const configuration = networkConfigurationFor(payment.networkIdentifier);
  if (!configuration.capabilities.supportsPaymentUri) {
    return null;
  }
  return buildPaymentUri({
    networkFamily: configuration.networkFamily,
    evmChainId: configuration.evmChainId,
    destinationAccount: payment.receivingAccount,
    assetReference: payment.asset.reference,
    assetDecimals: payment.asset.decimals,
    amountInBaseUnits: payment.requestedAmountInBaseUnits.toString(),
    memo: null,
  });
}

/**
 * How a chain transaction looks from outside. The internal classification and observation columns
 * are collapsed into one word, because a merchant acts on "is this money real yet", not on the two
 * orthogonal axes the engine needs to answer that.
 */
function transactionStatusOf(
  transfer: StoredTransfer,
  isPaid: boolean,
): GatewayTransaction['status'] {
  if (transfer.observation === 'orphaned') {
    return 'ORPHANED';
  }
  if (transfer.classification !== 'credited') {
    return 'REJECTED';
  }
  if (isPaid || transfer.observation === 'finalized') {
    return 'CONFIRMED';
  }
  return 'DETECTED';
}

function presentTransaction(
  payment: Payment,
  transfer: StoredTransfer,
  confirmations: number,
  isPaid: boolean,
): GatewayTransaction {
  return {
    reference: transfer.transactionReference,
    amount: decimal(transfer.amountInBaseUnits, payment.asset.decimals),
    status: transactionStatusOf(transfer, isPaid),
    // A transfer that is no longer on the canonical chain has no confirmations, whatever the
    // payment as a whole has counted.
    confirmations: transfer.observation === 'orphaned' ? 0 : confirmations,
    explorerUrl: explorerTransactionUrl(payment.networkIdentifier, transfer.transactionReference),
    observedAt: transfer.observedAt.toISOString(),
  };
}

export function presentGatewayPayment(
  payment: Payment,
  transfers: readonly StoredTransfer[],
  context: GatewayPresentationContext,
): GatewayPayment {
  const configuration = networkConfigurationFor(payment.networkIdentifier);
  const status = toPublicPaymentState({
    status: payment.status,
    monitoringHasReachedCreation: context.monitoringHasReachedCreation,
  });
  const isPaid = status === 'PAID';
  const paymentUri = paymentUriFor(payment);
  const firstTransfer = transfers.find((transfer) => transfer.observation !== 'orphaned');

  return {
    id: payment.identifier,
    externalReference: payment.merchantReference,
    status,
    network: configuration.networkFamily,
    chainId: configuration.evmChainId,
    currency: payment.asset.symbol,
    amount: decimal(payment.requestedAmountInBaseUnits, payment.asset.decimals),
    amountReceived: decimal(payment.creditedAmountInBaseUnits, payment.asset.decimals),
    paymentDestination: {
      address: payment.receivingAccount,
      // A memo is part of the destination on a family that has one. None of the shipped networks
      // does, so this is null rather than an empty string that would look like a value.
      memo: null,
    },
    paymentUri,
    qrCode: paymentUri === null ? null : renderPaymentQrCode(paymentUri).dataUri,
    failureReason: failureReasonFor(payment),
    explorer: {
      address: explorerAccountUrl(payment.networkIdentifier, payment.receivingAccount),
      transaction:
        firstTransfer === undefined
          ? null
          : explorerTransactionUrl(payment.networkIdentifier, firstTransfer.transactionReference),
    },
    transactions: transfers.map((transfer) =>
      presentTransaction(payment, transfer, payment.confirmationsObserved, isPaid),
    ),
    metadata: payment.metadata,
    createdAt: payment.createdAt.toISOString(),
    expiresAt: payment.expiresAt.toISOString(),
    paidAt: payment.completedAt?.toISOString() ?? null,
  };
}

/** The narrow answer a poller wants, without the payload it already has. */
export function presentGatewayPaymentStatus(
  payment: Payment,
  context: GatewayPresentationContext,
): GatewayPaymentStatus {
  return {
    id: payment.identifier,
    status: toPublicPaymentState({
      status: payment.status,
      monitoringHasReachedCreation: context.monitoringHasReachedCreation,
    }),
    amount: decimal(payment.requestedAmountInBaseUnits, payment.asset.decimals),
    amountReceived: decimal(payment.creditedAmountInBaseUnits, payment.asset.decimals),
    confirmations: payment.confirmationsObserved,
    requiredConfirmations: payment.requiredConfirmations,
    failureReason: failureReasonFor(payment),
    expiresAt: payment.expiresAt.toISOString(),
    paidAt: payment.completedAt?.toISOString() ?? null,
  };
}
