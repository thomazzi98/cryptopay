import { formatBaseUnits, type Checkout } from '@cryptopay/shared';

import type { Payment } from '../../domain/payment.js';
import {
  explorerAccountUrl,
  networkConfigurationFor,
} from '../../infrastructure/chain/network-configuration.js';
import type { StoredTransfer } from '../../infrastructure/persistence/payment-transfer.repository.js';
import { presentTransfer } from './payment.presenter.js';

/**
 * What a customer is shown.
 *
 * Every field is named explicitly rather than spread from the aggregate, which is what makes the
 * omissions durable: adding a field to the domain cannot publish it here by accident. The merchant
 * identifier, the callback URL, the metadata and the payment identifier are all deliberately absent,
 * because the person on this page needs the amount, the address and the progress, and the rest is a
 * detail of someone else's business.
 */
export function presentCheckout(
  payment: Payment,
  transfers: readonly StoredTransfer[],
  merchantDisplayName: string,
): Checkout {
  const configuration = networkConfigurationFor(payment.networkIdentifier);
  const decimals = payment.asset.decimals;

  return {
    status: payment.status,
    network: payment.networkIdentifier,
    chainIdentifier: configuration.chainIdentifier,
    networkDisplayName: configuration.displayName,
    environment: payment.environment,
    asset: {
      reference: payment.asset.reference,
      symbol: payment.asset.symbol,
      decimals,
    },
    requestedAmount: {
      baseUnits: payment.requestedAmountInBaseUnits.toString(),
      display: formatBaseUnits(payment.requestedAmountInBaseUnits, decimals),
    },
    creditedAmount: {
      baseUnits: payment.creditedAmountInBaseUnits.toString(),
      display: formatBaseUnits(payment.creditedAmountInBaseUnits, decimals),
    },
    receivingAccount: payment.receivingAccount,
    confirmations: payment.confirmationsObserved,
    requiredConfirmations: payment.requiredConfirmations,
    // Reported separately from the count on purpose. They are two different guarantees, and a
    // customer watching a full confirmation bar on a block that is not yet final is being misled.
    finalityConfirmed: payment.finalityConfirmed,
    merchantDisplayName,
    expiresAt: payment.expiresAt.toISOString(),
    explorerAccountUrl: explorerAccountUrl(payment.networkIdentifier, payment.receivingAccount),
    transfers: transfers.map((transfer) =>
      presentTransfer(transfer, payment.networkIdentifier, decimals),
    ),
  };
}
