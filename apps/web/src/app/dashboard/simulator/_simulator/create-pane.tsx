'use client';

import { NETWORK_IDENTIFIERS, type CreatePaymentRequest, type Payment } from '@cryptopay/shared';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Copyable } from '@/components/ui/data';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { callApi } from '@/lib/api-client';

import { networkLabel, readErrorDetail } from './presentation';

/**
 * The only pane that writes.
 *
 * The idempotency key is minted once per attempt and kept across a failure, because that is what
 * the header is for: a retry of a request whose answer was lost must return the first payment
 * rather than open a second address. It is shown, so the behaviour can be checked rather than
 * believed.
 */

const FIELD_LABEL = 'text-xs font-medium tracking-wide text-text-subtle uppercase';
const FIELD_CONTROL =
  'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle';

const DEFAULT_NETWORK = NETWORK_IDENTIFIERS[0] ?? 'local-anvil';

export function CreatePane({ onCreated }: { onCreated: (payment: Payment) => void }) {
  const [amount, setAmount] = useState('25.00');
  const [network, setNetwork] = useState<string>(DEFAULT_NETWORK);
  const [assetSymbol, setAssetSymbol] = useState('USDC');
  const [merchantReference, setMerchantReference] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function create(key: string): Promise<void> {
    const trimmedReference = merchantReference.trim();
    const trimmedCallbackUrl = callbackUrl.trim();
    const body: CreatePaymentRequest = {
      network,
      assetSymbol: assetSymbol.trim(),
      amount: amount.trim(),
      ...(trimmedReference !== '' && { merchantReference: trimmedReference }),
      ...(trimmedCallbackUrl !== '' && { callbackUrl: trimmedCallbackUrl }),
    };

    const payment = await callApi<Payment>('v1/payments', {
      method: 'POST',
      body,
      idempotencyKey: key,
    });
    setIdempotencyKey(null);
    onCreated(payment);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key);
    setFailure(null);
    setSubmitting(true);

    void create(key)
      .catch((error: unknown) => {
        setFailure(readErrorDetail(error));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  return (
    <Card>
      <CardHeader
        title="1. Create"
        description="POST /v1/payments, through the dashboard proxy, with an Idempotency-Key."
      />
      <CardBody>
        <p className="mb-4 rounded-lg border border-status-underpaid bg-status-underpaid-soft px-3 py-2 text-xs text-status-underpaid">
          This creates a real payment on the environment your API key belongs to. It allocates a
          real receiving address and any money sent to it is really received.
        </p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className={FIELD_LABEL} htmlFor="simulator-amount">
              Amount
            </label>
            <input
              id="simulator-amount"
              className={`${FIELD_CONTROL} tabular`}
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              placeholder="25.00"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FIELD_LABEL} htmlFor="simulator-network">
                Network
              </label>
              <select
                id="simulator-network"
                className={FIELD_CONTROL}
                value={network}
                onChange={(event) => {
                  setNetwork(event.target.value);
                }}
              >
                {NETWORK_IDENTIFIERS.map((identifier) => (
                  <option key={identifier} value={identifier}>
                    {networkLabel(identifier)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={FIELD_LABEL} htmlFor="simulator-asset">
                Asset
              </label>
              <input
                id="simulator-asset"
                className={FIELD_CONTROL}
                value={assetSymbol}
                onChange={(event) => {
                  setAssetSymbol(event.target.value);
                }}
                placeholder="USDC"
                required
              />
            </div>
          </div>

          <div>
            <label className={FIELD_LABEL} htmlFor="simulator-reference">
              Merchant reference
            </label>
            <input
              id="simulator-reference"
              className={FIELD_CONTROL}
              value={merchantReference}
              onChange={(event) => {
                setMerchantReference(event.target.value);
              }}
              placeholder="order-10422"
            />
          </div>

          <div>
            <label className={FIELD_LABEL} htmlFor="simulator-callback">
              Callback URL
            </label>
            <input
              id="simulator-callback"
              className={FIELD_CONTROL}
              value={callbackUrl}
              onChange={(event) => {
                setCallbackUrl(event.target.value);
              }}
              placeholder="https://merchant.example.com/webhooks/cryptopay"
            />
            <p className="mt-1 text-xs text-text-subtle">
              Optional. Leave it empty and the verify pane still shows the status changes; fill it
              in and it shows the delivery attempts too.
            </p>
          </div>

          {failure !== null && (
            <p
              role="alert"
              className="rounded-lg border border-status-canceled bg-status-canceled-soft px-3 py-2 text-xs text-status-canceled"
            >
              {failure}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <Button type="submit" variant="primary" loading={submitting}>
              Create payment
            </Button>
            {idempotencyKey !== null && (
              <span className="flex min-w-0 items-center gap-1 text-xs text-text-subtle">
                Retrying with
                <Copyable value={idempotencyKey} />
              </span>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
