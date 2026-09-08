'use client';

import type { Payment } from '@cryptopay/shared';

import { Amount, Copyable, Field } from '@/components/ui/data';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  SkeletonRows,
} from '@/components/ui/surfaces';
import { formatTimestamp } from '@/lib/format';

import { networkLabel, readErrorDetail } from './presentation';

/**
 * Everything needed to pay from somewhere that is not this browser.
 *
 * The hosted checkout is one way; the address and the exact amount are the other, and they are
 * offered together on purpose. A payment that can only be made from the page that created it
 * proves nothing about where the backend gets its truth.
 */
export function PayPane({
  payment,
  isLoading,
  paymentError,
}: {
  payment: Payment | null;
  isLoading: boolean;
  paymentError: Error | null;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader title="2. Pay" description="Where the money is sent, and how." />
        <SkeletonRows rows={5} />
      </Card>
    );
  }

  // A failed read must never fall through to the empty state, which would say the payment does not
  // exist. A read that failed while an address is already on screen keeps the address: the verify
  // pane names the failing source, and hiding the address over one failed poll helps nobody.
  if (payment === null && paymentError !== null) {
    return (
      <Card>
        <CardHeader title="2. Pay" description="Where the money is sent, and how." />
        <ErrorState title="This payment could not be read" detail={readErrorDetail(paymentError)} />
      </Card>
    );
  }

  if (payment === null) {
    return (
      <Card>
        <CardHeader title="2. Pay" description="Where the money is sent, and how." />
        <EmptyState
          title="Nothing to pay yet"
          description="Create a payment in the first pane. The receiving address is allocated by the backend at that moment, so there is nothing to show before then."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="2. Pay" description="Pay from the hosted checkout, or from any wallet." />
      <CardBody className="space-y-4">
        <a
          href={payment.checkoutUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-full items-center justify-center rounded-lg border border-transparent bg-accent px-3.5 py-2 text-sm font-medium text-text-inverted transition-colors hover:bg-accent-hover"
        >
          Open the checkout in a new tab
        </a>

        <dl className="grid grid-cols-2 gap-4">
          <Field label="Amount">
            <Amount
              display={payment.requestedAmount.display}
              symbol={payment.asset.symbol}
              emphasis="strong"
            />
          </Field>
          <Field label="Network">
            <span className="text-sm text-text">{networkLabel(payment.network)}</span>
          </Field>
          <Field label="Receiving address" className="col-span-2">
            <Copyable value={payment.receivingAccount} />
          </Field>
          <Field label="Exact amount to send" className="col-span-2">
            <Copyable
              value={payment.requestedAmount.display}
              display={payment.requestedAmount.display}
            />
          </Field>
          <Field label="Token contract" className="col-span-2">
            <Copyable value={payment.asset.reference} />
          </Field>
          <Field label="Expires">
            <span className="tabular text-sm text-text">{formatTimestamp(payment.expiresAt)}</span>
          </Field>
          <Field label="Payment">
            <Copyable value={payment.identifier} />
          </Field>
        </dl>

        <p className="text-xs text-text-subtle">
          The address belongs to this payment alone. Send the token at that contract address, on
          that network, from any wallet you like: this tab does not need to stay open, and it is not
          what tells the backend the money arrived.
        </p>
      </CardBody>
    </Card>
  );
}
