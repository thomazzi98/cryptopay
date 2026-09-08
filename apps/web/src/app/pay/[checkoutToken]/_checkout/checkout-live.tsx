'use client';

import {
  isTerminalPaymentStatus,
  type PaymentStatus,
  type PaymentTransfer,
} from '@cryptopay/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';

import { QueryProvider } from '@/components/query-provider';
import { Button } from '@/components/ui/button';
import { Amount, Copyable } from '@/components/ui/data';
import { StatusBadge } from '@/components/ui/status-badge';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { classNames } from '@/lib/class-names';
import { formatExactAmount, formatShortTimestamp, truncateReference } from '@/lib/format';
import { describeStatus } from '@/lib/payment-status';

import { CheckoutReadError, type CheckoutView } from './checkout-view';
import { ConfirmationMeter } from './confirmation-meter';
import { ExpiryCountdown } from './expiry-countdown';
import { readCheckout } from './read-checkout';
import { walletConfiguration } from './wallet-configuration';
import { WalletPanel } from './wallet-panel';

/**
 * Everything on this page that moves, under one query.
 *
 * The server already fetched the checkout, so the poll starts from that value rather than from a
 * loading state: a customer must never watch the amount they are about to send appear. When a poll
 * fails the last good checkout stays on screen and the failure is reported beside it, because
 * blanking a payment page over one dropped request is worse than showing a value four seconds old.
 *
 * Polling stops the moment the status is terminal. Nothing after that changes.
 */

const LIVE_INTERVAL_MILLISECONDS = 4000;
const RECOVERY_INTERVAL_MILLISECONDS = 8000;

/**
 * The status descriptors are written for a merchant reading their own dashboard. A customer needs to
 * be told what to do next instead, so this page states it in their words.
 */
const CUSTOMER_MESSAGE: Readonly<Record<PaymentStatus, string>> = {
  pending: 'Nothing has arrived yet. Send the exact amount to the address below.',
  partially_funded:
    'Part of the amount arrived. Send the rest before the window closes, or the payment settles short.',
  confirming: 'Your transfer was seen on chain. Waiting for the network to confirm it.',
  completed: 'Paid in full and confirmed on chain. You are done here.',
  overpaid:
    'More than the requested amount arrived. The merchant has been told, and the difference is theirs to return.',
  underpaid:
    'The window closed with less than the requested amount received. The merchant has the details of what did arrive.',
  expired: 'The payment window closed before anything arrived. Ask the merchant for a new link.',
  canceled: 'The merchant cancelled this payment. Nothing was taken.',
};

const CLASSIFICATION_LABEL: Readonly<Record<PaymentTransfer['classification'], string>> = {
  credited: 'Credited',
  late: 'Arrived after the window closed',
  unexpected: 'Not expected against this payment',
  wrong_asset: 'Wrong token',
};

const OBSERVATION_LABEL: Readonly<Record<PaymentTransfer['observation'], string>> = {
  observed: 'Seen on chain',
  finalized: 'Final',
  orphaned: 'Withdrawn by a chain reorganisation',
};

export function CheckoutLive({
  checkoutToken,
  initialCheckout,
  scanPanel,
}: {
  checkoutToken: string;
  initialCheckout: CheckoutView;
  scanPanel: ReactNode;
}) {
  return (
    <WagmiProvider config={walletConfiguration}>
      <QueryProvider>
        <CheckoutScreen
          checkoutToken={checkoutToken}
          initialCheckout={initialCheckout}
          scanPanel={scanPanel}
        />
      </QueryProvider>
    </WagmiProvider>
  );
}

function CheckoutScreen({
  checkoutToken,
  initialCheckout,
  scanPanel,
}: {
  checkoutToken: string;
  initialCheckout: CheckoutView;
  scanPanel: ReactNode;
}) {
  const checkoutQuery = useQuery({
    queryKey: ['checkout', checkoutToken],
    queryFn: async (): Promise<CheckoutView> => {
      const result = await readCheckout(checkoutToken);
      if (!result.ok) {
        throw new CheckoutReadError(result.status, result.detail);
      }
      return result.checkout;
    },
    initialData: initialCheckout,
    refetchInterval: (current) => {
      const latest = current.state.data;
      if (latest === undefined) {
        return RECOVERY_INTERVAL_MILLISECONDS;
      }
      return isTerminalPaymentStatus(latest.status) ? false : LIVE_INTERVAL_MILLISECONDS;
    },
  });

  const checkout = checkoutQuery.data;
  const descriptor = describeStatus(checkout.status);
  const readFailure = checkoutQuery.error;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
                Payment to
              </p>
              <p className="mt-1 text-base font-semibold break-words text-text">
                {checkout.merchantDisplayName}
              </p>
            </div>
            {checkout.environment === 'test' && (
              <span
                title="A test payment. No real money moves."
                className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs font-medium text-text-muted"
              >
                Test mode
              </span>
            )}
          </div>

          <div>
            <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Amount due
            </p>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="tabular text-3xl font-semibold break-all text-text sm:text-4xl">
                {formatExactAmount(checkout.requestedAmount.display)}
              </span>
              <span className="text-lg font-medium text-text-subtle">{checkout.asset.symbol}</span>
            </p>
            <p className="mt-1 text-sm text-text-muted">on {checkout.networkDisplayName}</p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <StatusBadge status={checkout.status} size="large" />
            {descriptor.isFinal ? (
              <span className="text-sm text-text-muted">This payment is closed.</span>
            ) : (
              <ExpiryCountdown expiresAt={checkout.expiresAt} />
            )}
          </div>

          <p className="text-sm text-text-muted">{CUSTOMER_MESSAGE[checkout.status]}</p>

          {readFailure !== null && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-canceled bg-status-canceled-soft px-3 py-2"
            >
              <p className="min-w-0 text-xs text-status-canceled">
                This page has stopped updating: {readFailure.message} The figures below are the last
                ones it read.
              </p>
              <Button
                size="small"
                variant="secondary"
                loading={checkoutQuery.isFetching}
                onClick={() => {
                  void checkoutQuery.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {scanPanel}

      <WalletPanel checkout={checkout} />

      <Card>
        <CardHeader
          title="What the chain has shown so far"
          description="Read from the network by CryptoPay, not reported by this page."
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">Received</p>
            <p className="tabular text-sm text-text">
              <Amount
                display={checkout.creditedAmount.display}
                symbol={checkout.asset.symbol}
                emphasis={descriptor.holdsFunds ? 'strong' : 'muted'}
              />
              <span className="text-text-subtle">
                {' '}
                of {formatExactAmount(checkout.requestedAmount.display)}
              </span>
            </p>
          </div>

          <ConfirmationMeter
            status={checkout.status}
            confirmations={checkout.confirmations}
            requiredConfirmations={checkout.requiredConfirmations}
            finalityConfirmed={checkout.finalityConfirmed}
          />

          {checkout.transfers.length === 0 ? (
            <p className="text-sm text-text-muted">
              No transfer to this address has been seen yet. One appears here within seconds of
              landing in a block.
            </p>
          ) : (
            <ul className="space-y-2">
              {checkout.transfers.map((transfer) => (
                <li
                  key={`${transfer.transactionReference}:${transfer.eventIndex}`}
                  className="rounded-lg border border-border bg-surface-sunken px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Amount
                      display={transfer.amount.display}
                      symbol={checkout.asset.symbol}
                      emphasis="strong"
                    />
                    <span className="tabular text-xs text-text-subtle">
                      {formatShortTimestamp(transfer.observedAt)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-text-muted">
                      {CLASSIFICATION_LABEL[transfer.classification]}
                    </span>
                    <span
                      className={classNames(
                        transfer.observation === 'orphaned'
                          ? 'text-status-canceled'
                          : 'text-text-muted',
                      )}
                    >
                      {OBSERVATION_LABEL[transfer.observation]}
                    </span>
                    {transfer.explorerUrl === null ? (
                      <Copyable value={transfer.transactionReference} />
                    ) : (
                      <a
                        href={transfer.explorerUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="tabular font-mono text-accent underline underline-offset-2"
                      >
                        {truncateReference(transfer.transactionReference)}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <p className="px-1 pb-2 text-xs text-text-muted">
        CryptoPay decides when this payment is complete by reading the chain itself. Nothing this
        page reports can change that, and nothing is lost by closing it the moment after you sign.
      </p>
    </div>
  );
}
