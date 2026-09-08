'use client';

import type { Payment } from '@cryptopay/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { cancelPayment, describeFailure } from './queries';

/**
 * Cancelling is terminal and has no undo, so it asks once before it acts.
 *
 * The API is the authority on whether a cancellation is legal, not this component: the control is
 * hidden when the state machine has no edge to `canceled`, and when the API refuses anyway, because
 * money arrived between the render and the click, its own sentence is what gets shown. A generic
 * "could not cancel" would hide the only fact that matters, which is that the payment is funded.
 */
export function CancelControl({
  paymentIdentifier,
  onCanceled,
}: {
  paymentIdentifier: string;
  onCanceled: (payment: Payment) => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);

  const mutation = useMutation({
    mutationFn: () => cancelPayment(paymentIdentifier),
    onSuccess: (payment) => {
      setIsConfirming(false);
      onCanceled(payment);
    },
  });

  return (
    <div className="flex max-w-sm flex-col items-end gap-2">
      {isConfirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted">Cancel this payment?</span>
          <Button
            variant="ghost"
            size="small"
            onClick={() => {
              setIsConfirming(false);
            }}
          >
            Keep it
          </Button>
          <Button
            variant="danger"
            size="small"
            loading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Cancel it
          </Button>
        </div>
      ) : (
        <Button
          variant="danger"
          size="small"
          onClick={() => {
            setIsConfirming(true);
          }}
        >
          Cancel payment
        </Button>
      )}

      {mutation.error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-border bg-status-canceled-soft px-3 py-2 text-left text-xs text-status-canceled"
        >
          {describeFailure(mutation.error)}
        </p>
      )}
    </div>
  );
}
