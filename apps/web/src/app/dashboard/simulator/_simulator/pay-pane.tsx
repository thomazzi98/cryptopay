'use client';

import type { Payment } from '@cryptopay/shared';

import { Amount, Copyable, Field } from '@/components/ui/data';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/surfaces';
import { formatTimestamp } from '@/lib/format';

import { networkLabel } from './presentation';

/**
 * Everything needed to pay from somewhere that is not this browser.
 *
 * The hosted checkout is one way; the address and the exact amount are the other, and they are
 * offered together on purpose. A payment that can only be made from the page that created it
 * proves nothing about where the backend gets its truth.
 */
export function PayPane({ payment }: { payment: Payment | null }) {
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
