import {
  formatBaseUnits,
  type NetworkIdentifier,
  type Payment as PaymentContract,
  type PaymentTransfer as PaymentTransferContract,
} from '@cryptopay/shared';

import type { Payment } from '../../domain/payment.js';
import {
  explorerAccountUrl,
  explorerTransactionUrl,
  networkConfigurationFor,
} from '../../infrastructure/chain/network-configuration.js';
import type { StoredTransfer } from '../../infrastructure/persistence/payment-transfer.repository.js';

/**
 * Turns the aggregate into the response body.
 *
 * The presenter names every field it emits rather than spreading the aggregate, which is why adding
 * a field to the domain can never accidentally publish it. There is no field here for a derivation
 * path or index, and the API contract declares none either.
 *
 * There is also no settlement field. Nothing sweeps yet, and a field that always answers the same
 * thing promises a capability that does not exist: it reads as "the sweep has not started" rather
 * than "there is no sweep", so a merchant waits for something that is never coming. It returns when
 * there is something true to put in it.
 */

export interface PaymentPresentationContext {
  readonly checkoutBaseUrl: string;
}

function amount(baseUnits: bigint, decimals: number) {
  return { baseUnits: baseUnits.toString(), display: formatBaseUnits(baseUnits, decimals) };
}

export function presentPayment(
  payment: Payment,
  context: PaymentPresentationContext,
): PaymentContract {
  const configuration = networkConfigurationFor(payment.networkIdentifier);

  return {
    identifier: payment.identifier,
    status: payment.status,
    statusVersion: payment.statusVersion,
    environment: payment.environment,
    network: payment.networkIdentifier,
    chainIdentifier: configuration.evmChainId,
    asset: {
      reference: payment.asset.reference,
      symbol: payment.asset.symbol,
      decimals: payment.asset.decimals,
    },
    requestedAmount: amount(payment.requestedAmountInBaseUnits, payment.asset.decimals),
    creditedAmount: amount(payment.creditedAmountInBaseUnits, payment.asset.decimals),
    acceptanceBand: {
      minimumBaseUnits: payment.acceptanceBand.minimumInBaseUnits.toString(),
      maximumBaseUnits: payment.acceptanceBand.maximumInBaseUnits.toString(),
    },
    receivingAccount: payment.receivingAccount,
    confirmations: payment.confirmationsObserved,
    requiredConfirmations: payment.requiredConfirmations,
    finalityConfirmed: payment.finalityConfirmed,
    settlingBlockHeight: payment.settlingBlockHeight?.toString() ?? null,
    merchantReference: payment.merchantReference,
    callbackUrl: payment.callbackUrl,
    metadata: payment.metadata,
    checkoutUrl: `${context.checkoutBaseUrl}/${payment.checkoutToken}`,
    explorerAccountUrl: explorerAccountUrl(payment.networkIdentifier, payment.receivingAccount),
    createdAt: payment.createdAt.toISOString(),
    expiresAt: payment.expiresAt.toISOString(),
    completedAt: payment.completedAt?.toISOString() ?? null,
    transfers: [],
  };
}

/**
 * A transfer as the merchant sees it. Orphaned rows are presented rather than filtered, with the
 * observation carried through so the interface can strike them out instead of hiding them.
 */
export function presentTransfer(
  transfer: StoredTransfer,
  network: NetworkIdentifier,
  decimals: number,
): PaymentTransferContract {
  return {
    transactionReference: transfer.transactionReference,
    eventIndex: transfer.eventIndex,
    blockHeight: transfer.blockHeight.toString(),
    blockReference: transfer.blockReference,
    sourceAccount: transfer.sourceAccount,
    amount: {
      baseUnits: transfer.amountInBaseUnits.toString(),
      display: formatBaseUnits(transfer.amountInBaseUnits, decimals),
    },
    classification: transfer.classification,
    observation: transfer.observation,
    explorerUrl: explorerTransactionUrl(network, transfer.transactionReference),
    observedAt: transfer.observedAt.toISOString(),
  };
}
