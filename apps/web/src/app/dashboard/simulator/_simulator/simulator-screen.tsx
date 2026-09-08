'use client';

import { isPaymentStatus, isTerminalPaymentStatus, type Payment } from '@cryptopay/shared';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { CreatePane } from './create-pane';
import { PayPane } from './pay-pane';
import { usePaymentQuery } from './queries';
import { VerifyPane } from './verify-pane';

/**
 * The screen keeps one thing: the identifier of the payment being demonstrated. Everything else on
 * it, the address included, is whatever the API currently says about that identifier, so a reload
 * on another device with the same key shows the same run rather than a stale copy of it.
 */

const STORAGE_KEY = 'cryptopay.simulator.payment';
const PAYMENT_IDENTIFIER_PREFIX = 'pay_';

function readStoredIdentifier(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored?.startsWith(PAYMENT_IDENTIFIER_PREFIX) !== true) {
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

function writeStoredIdentifier(identifier: string | null): void {
  try {
    if (identifier === null) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, identifier);
  } catch {
    // A browser refusing storage costs the reader a reload, not the run itself.
  }
}

export function SimulatorScreen() {
  const [identifier, setIdentifier] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // Read after mount rather than during render: a server render has no localStorage, and a value
  // only one of the two passes can see is a hydration mismatch.
  useEffect(() => {
    setIdentifier(readStoredIdentifier());
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) {
      return;
    }
    writeStoredIdentifier(identifier);
  }, [identifier, restored]);

  const paymentQuery = usePaymentQuery(identifier);
  const payment = paymentQuery.data ?? null;
  const isFinal =
    payment !== null && isPaymentStatus(payment.status) && isTerminalPaymentStatus(payment.status);

  function accept(created: Payment): void {
    setIdentifier(created.identifier);
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h1 className="text-lg font-semibold tracking-tight text-text">Simulator</h1>
          <p className="mt-1 text-sm text-text-muted">
            Create a payment, pay it from anywhere, and watch what the backend concluded. The third
            pane never writes: it polls the payment, its timeline, its transfers and its callback
            deliveries, so everything it shows was decided by the API reading the chain, not by this
            page.
          </p>
        </div>
        {identifier !== null && (
          <Button
            variant="ghost"
            onClick={() => {
              setIdentifier(null);
            }}
          >
            Start a new run
          </Button>
        )}
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-4">
        <CreatePane onCreated={accept} />
        <PayPane payment={payment} />
        <VerifyPane
          identifier={identifier}
          payment={payment}
          isFinal={isFinal}
          isLoading={identifier !== null && paymentQuery.isPending}
          paymentError={paymentQuery.error}
          updatedAt={paymentQuery.dataUpdatedAt}
        />
      </div>
    </div>
  );
}
