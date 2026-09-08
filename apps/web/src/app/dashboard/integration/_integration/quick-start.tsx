import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';

import { CodeBlock } from './code-block';
import { CREATED_PAYMENT_SAMPLE, CREATE_PAYMENT_SAMPLE, POLL_PAYMENT_SAMPLE } from './samples';

export function QuickStart() {
  return (
    <Card>
      <CardHeader
        title="Quick start"
        description="Create a payment, send the customer to its checkout URL, then read the payment back until it is final."
      />
      <CardBody className="space-y-5">
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">1. Create the payment</h3>
          <p className="max-w-3xl text-sm text-text-muted">
            An <code className="font-mono text-xs">Idempotency-Key</code> header is required, not
            optional. A retry carrying the same key returns the payment the first call created; the
            same key with a different body is rejected rather than silently creating a second
            payment. The amount is a decimal string, and it is refused rather than rounded if it
            carries more precision than the asset holds.
          </p>
          <CodeBlock label="POST /v1/payments" code={CREATE_PAYMENT_SAMPLE} />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">2. The payment that comes back</h3>
          <p className="max-w-3xl text-sm text-text-muted">
            Every monetary value is two decimal strings,{' '}
            <code className="font-mono text-xs">baseUnits</code> and{' '}
            <code className="font-mono text-xs">display</code>, and never a JSON number. Send the
            customer to <code className="font-mono text-xs">checkoutUrl</code>; the address in{' '}
            <code className="font-mono text-xs">receivingAccount</code> belongs to this payment
            alone and is stored lowercase, so compare it lowercase and checksum it only for display.
          </p>
          <CodeBlock label="201 Created" code={CREATED_PAYMENT_SAMPLE} />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">3. Read it back</h3>
          <p className="max-w-3xl text-sm text-text-muted">
            Poll while the payment is live, or register a{' '}
            <code className="font-mono text-xs">callbackUrl</code> and let the callback tell you.
            Fulfil on <code className="font-mono text-xs">status</code>, never on a confirmation
            count you interpret yourself: <code className="font-mono text-xs">completed</code>{' '}
            already means paid in full, past the required confirmations and covered by the chain
            finality tag. <code className="font-mono text-xs">statusVersion</code> only increases,
            so it is what discards an out-of-order update.
          </p>
          <CodeBlock label="GET /v1/payments/{paymentId}" code={POLL_PAYMENT_SAMPLE} />
        </div>
      </CardBody>
    </Card>
  );
}
