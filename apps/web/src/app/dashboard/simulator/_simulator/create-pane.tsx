'use client';

import type { CreatePaymentRequest, Merchant, Payment } from '@cryptopay/shared';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Copyable } from '@/components/ui/data';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { callApi } from '@/lib/api-client';

import { networkLabel, readErrorDetail } from './presentation';
import { useMerchantQuery } from './queries';

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

/**
 * The same split the payments table enforces as a check constraint. Offering a network this key's
 * environment cannot settle would put a guaranteed database rejection behind the primary button.
 */
const NETWORKS_BY_ENVIRONMENT: Readonly<Record<Merchant['environment'], readonly string[]>> =
  Object.freeze({
    live: ['polygon-mainnet'],
    test: ['polygon-amoy', 'local-anvil'],
  });

export function CreatePane({ onCreated }: { onCreated: (payment: Payment) => void }) {
  const merchant = useMerchantQuery();
  const [amount, setAmount] = useState('25.00');
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null);
  const [assetSymbol, setAssetSymbol] = useState('USDC');
  const [merchantReference, setMerchantReference] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attemptFailed, setAttemptFailed] = useState(false);

  const environment = merchant.data?.environment ?? null;
  const networks = environment === null ? [] : NETWORKS_BY_ENVIRONMENT[environment];
  const network =
    selectedNetwork !== null && networks.includes(selectedNetwork)
      ? selectedNetwork
      : (networks[0] ?? null);

  async function create(key: string, chosenNetwork: string): Promise<void> {
    const trimmedReference = merchantReference.trim();
    const trimmedCallbackUrl = callbackUrl.trim();
    const body: CreatePaymentRequest = {
      network: chosenNetwork,
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
    setAttemptFailed(false);
    onCreated(payment);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (submitting || network === null) {
      return;
    }

    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key);
    setFailure(null);
    setSubmitting(true);

    void create(key, network)
      .catch((error: unknown) => {
        setFailure(readErrorDetail(error));
        setAttemptFailed(true);
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
                value={network ?? ''}
                disabled={network === null}
                onChange={(event) => {
                  setSelectedNetwork(event.target.value);
                }}
              >
                {networks.map((identifier) => (
                  <option key={identifier} value={identifier}>
                    {networkLabel(identifier)}
                  </option>
                ))}
              </select>
              {environment !== null && (
                <p className="mt-1 text-xs text-text-subtle">
                  This key is a {environment} key, so these are the networks it can settle on.
                </p>
              )}
              {merchant.isPending && (
                <p className="mt-1 text-xs text-text-subtle">
                  Reading which environment this key belongs to.
                </p>
              )}
              {merchant.error !== null && (
                <p role="alert" className="mt-1 text-xs text-health-failed">
                  The networks this key can settle on could not be read.{' '}
                  {readErrorDetail(merchant.error)}
                </p>
              )}
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
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              disabled={network === null}
            >
              Create payment
            </Button>
            {idempotencyKey !== null && attemptFailed && (
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
