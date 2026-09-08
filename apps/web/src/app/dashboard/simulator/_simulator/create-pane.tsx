'use client';

import type { CreatePaymentRequest, Payment } from '@cryptopay/shared';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Copyable } from '@/components/ui/data';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { callApi } from '@/lib/api-client';

import { readErrorDetail } from './presentation';
import { useMerchantQuery, useNetworksQuery } from './queries';

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

export function CreatePane({ onCreated }: { onCreated: (payment: Payment) => void }) {
  const merchant = useMerchantQuery();
  // Asked rather than assumed. A list kept in this bundle would offer a network the deployment is
  // not scanning, and payment creation answers 503 from behind the primary button of this screen.
  const availableNetworks = useNetworksQuery();
  const [amount, setAmount] = useState('25.00');
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [merchantReference, setMerchantReference] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attemptFailed, setAttemptFailed] = useState(false);

  const environment = merchant.data?.environment ?? null;
  const networks = availableNetworks.data?.data ?? [];
  const chosen =
    networks.find((candidate) => candidate.network === selectedNetwork) ?? networks[0] ?? null;
  const network = chosen?.network ?? null;
  // The assets this network actually credits. Typing a symbol it does not is a validation error a
  // merchant cannot see coming, and the symbol is display only in any case: identity is the address.
  const assets = chosen?.assets ?? [];
  const asset = assets.find((candidate) => candidate.symbol === selectedAsset) ?? assets[0] ?? null;
  const assetSymbol = asset?.symbol ?? '';

  async function create(key: string, chosenNetwork: string): Promise<void> {
    const trimmedReference = merchantReference.trim();
    const trimmedCallbackUrl = callbackUrl.trim();
    const body: CreatePaymentRequest = {
      network: chosenNetwork,
      assetSymbol,
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
    if (submitting || network === null || assetSymbol === '') {
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
                {networks.map((descriptor) => (
                  <option key={descriptor.network} value={descriptor.network}>
                    {descriptor.displayName}
                  </option>
                ))}
              </select>
              {availableNetworks.isPending && (
                <p className="mt-1 text-xs text-text-subtle">
                  Reading which networks this key can settle on.
                </p>
              )}
              {availableNetworks.error !== null && (
                <p role="alert" className="mt-1 text-xs text-health-failed">
                  The networks this key can settle on could not be read.{' '}
                  {readErrorDetail(availableNetworks.error)}
                </p>
              )}
              {availableNetworks.error === null &&
                !availableNetworks.isPending &&
                networks.length === 0 && (
                  <p role="alert" className="mt-1 text-xs text-health-failed">
                    No network is being scanned for this environment, so a payment created now could
                    never be detected. Configure an RPC endpoint first.
                  </p>
                )}
              {environment !== null && networks.length > 0 && (
                <p className="mt-1 text-xs text-text-subtle">
                  This key is a {environment} key, and {chosen?.displayName ?? 'this network'} takes{' '}
                  {chosen?.requiredConfirmations ?? 0} confirmations.
                </p>
              )}
            </div>

            <div>
              <label className={FIELD_LABEL} htmlFor="simulator-asset">
                Asset
              </label>
              <select
                id="simulator-asset"
                className={FIELD_CONTROL}
                value={assetSymbol}
                disabled={assets.length === 0}
                onChange={(event) => {
                  setSelectedAsset(event.target.value);
                }}
              >
                {assets.map((candidate) => (
                  <option key={candidate.reference} value={candidate.symbol}>
                    {candidate.symbol}
                  </option>
                ))}
              </select>
              {asset !== null && (
                <p className="mt-1 text-xs text-text-subtle tabular">
                  {asset.decimals} decimals, at {asset.reference.slice(0, 10)}...
                </p>
              )}
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
