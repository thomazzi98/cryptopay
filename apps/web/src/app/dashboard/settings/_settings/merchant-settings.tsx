'use client';

import type { Merchant } from '@cryptopay/shared';
import { useQuery } from '@tanstack/react-query';

import { Amount, Copyable, Field } from '@/components/ui/data';
import { Card, CardBody, CardHeader, ErrorState, Skeleton } from '@/components/ui/surfaces';
import { ApiError, callApi } from '@/lib/api-client';

import { EnvironmentSeparation } from './environment-separation';
import { describeLifetime, formatBasisPoints, workExample } from './settings-arithmetic';

/**
 * Everything on this screen is read-only, and deliberately so: GET /v1/merchants/me is the only
 * endpoint the API exposes for a merchant's own configuration, and there is no counterpart that
 * writes it. A form here would be a form that cannot save, so the values are shown as values and
 * the page says where they are actually changed.
 *
 * Nothing here moves while it is on screen, so the query does not poll.
 */

function ToleranceExplanation({ merchant }: { merchant: Merchant }) {
  const example = workExample(
    merchant.underpaymentToleranceBasisPoints,
    merchant.overpaymentToleranceBasisPoints,
  );

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-surface-sunken p-4">
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
          Underpayment tolerance
        </p>
        <p className="tabular mt-1 text-lg font-semibold text-text">
          {merchant.underpaymentToleranceBasisPoints.toString()} basis points
          <span className="tabular ml-2 text-sm font-normal text-text-subtle">
            {formatBasisPoints(merchant.underpaymentToleranceBasisPoints)}
          </span>
        </p>
        <p className="mt-2 text-sm text-text-muted">
          {merchant.underpaymentToleranceBasisPoints === 0 ? (
            <>
              A payment counts as paid only once the full amount has arrived. On a{' '}
              <Amount display={example.requested} symbol="USDC" /> invoice, anything below{' '}
              <Amount display={example.minimum} symbol="USDC" /> stays partially funded, and settles
              as underpaid when the window closes.
            </>
          ) : (
            <>
              A payment counts as paid even when it lands short, by up to{' '}
              <Amount display={example.underpaymentAllowance} symbol="USDC" /> on a{' '}
              <Amount display={example.requested} symbol="USDC" /> invoice: anything from{' '}
              <Amount display={example.minimum} symbol="USDC" /> upwards completes, and less than
              that stays partially funded, then settles as underpaid when the window closes.
            </>
          )}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-surface-sunken p-4">
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
          Overpayment tolerance
        </p>
        <p className="tabular mt-1 text-lg font-semibold text-text">
          {merchant.overpaymentToleranceBasisPoints.toString()} basis points
          <span className="tabular ml-2 text-sm font-normal text-text-subtle">
            {formatBasisPoints(merchant.overpaymentToleranceBasisPoints)}
          </span>
        </p>
        <p className="mt-2 text-sm text-text-muted">
          {merchant.overpaymentToleranceBasisPoints === 0 ? (
            <>
              Any excess at all is reported. On a{' '}
              <Amount display={example.requested} symbol="USDC" /> invoice, more than{' '}
              <Amount display={example.maximum} symbol="USDC" /> settles as overpaid rather than
              completed, so a surplus is never pocketed quietly.
            </>
          ) : (
            <>
              An excess of up to <Amount display={example.overpaymentAllowance} symbol="USDC" /> on
              a <Amount display={example.requested} symbol="USDC" /> invoice still settles as
              completed. Above <Amount display={example.maximum} symbol="USDC" /> the payment
              settles as overpaid instead, so a surplus is never pocketed quietly.
            </>
          )}
        </p>
      </div>

      <div className="sm:col-span-2">
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
          The accepted band on a <Amount display={example.requested} symbol="USDC" /> invoice
        </p>
        <dl className="mt-2 grid grid-cols-1 gap-2 text-center sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-surface-raised p-3">
            <dt className="text-xs text-text-subtle">Minimum accepted</dt>
            <dd className="mt-1 text-sm">
              <Amount display={example.minimum} symbol="USDC" emphasis="strong" />
            </dd>
          </div>
          <div className="rounded-lg border border-border-strong bg-accent-soft p-3">
            <dt className="text-xs text-text-muted">Requested</dt>
            <dd className="mt-1 text-sm">
              <Amount
                display={example.requested}
                symbol="USDC"
                className="font-semibold text-accent"
              />
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-surface-raised p-3">
            <dt className="text-xs text-text-subtle">Maximum accepted</dt>
            <dd className="mt-1 text-sm">
              <Amount display={example.maximum} symbol="USDC" emphasis="strong" />
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Merchant" />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Acceptance tolerances" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-20 w-full sm:col-span-2" />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Default payment lifetime" />
        <CardBody>
          <Skeleton className="h-20 w-full" />
        </CardBody>
      </Card>
    </div>
  );
}

export function MerchantSettings() {
  const query = useQuery<Merchant, Error>({
    queryKey: ['merchant', 'me'],
    queryFn: ({ signal }) => callApi<Merchant>('v1/merchants/me', { signal }),
  });

  if (query.isPending) {
    return <SettingsSkeleton />;
  }

  if (query.isError) {
    const failure = query.error;
    const detail =
      failure instanceof ApiError ? failure.detail : 'The dashboard could not reach the API.';
    return (
      <Card>
        <ErrorState title="Your settings could not be loaded" detail={detail} />
      </Card>
    );
  }

  // Pending and failed are both answered above, so the query has resolved and there is no third
  // state to guard against.
  const merchant = query.data;
  const lifetimeSeconds = merchant.defaultPaymentLifetimeSeconds.toString();
  const lifetime = describeLifetime(merchant.defaultPaymentLifetimeSeconds);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Merchant"
          description="Who this session is, and which environment its key puts it in."
        />
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Display name">{merchant.displayName}</Field>
            <Field label="Merchant identifier">
              <Copyable value={merchant.identifier} />
            </Field>
            <Field label="Environment">
              <span
                className={
                  merchant.environment === 'live'
                    ? 'rounded-full border border-environment-live bg-environment-live-soft px-2 py-0.5 text-xs font-medium text-environment-live'
                    : 'rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs font-medium text-text-muted'
                }
              >
                {merchant.environment === 'live' ? 'Live' : 'Test'}
              </span>
              <span className="mt-1 block text-sm text-text-muted">
                {merchant.environment === 'live'
                  ? 'These payments move real money on Polygon mainnet.'
                  : 'These payments move testnet money only.'}
              </span>
            </Field>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Acceptance tolerances"
          description="How far from the requested amount a payment may land and still count as paid."
        />
        <CardBody>
          <ToleranceExplanation merchant={merchant} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Default payment lifetime"
          description="How long a new payment stays open when the request does not say otherwise."
        />
        <CardBody className="space-y-3">
          <p className="tabular text-lg font-semibold text-text">
            {lifetimeSeconds} seconds
            <span className="ml-2 text-sm font-normal text-text-subtle">({lifetime})</span>
          </p>
          <p className="text-sm text-text-muted">
            A payment created without its own window expires {lifetime} after it is created. Money
            that arrived before then is still credited: a payment holding less than the accepted
            minimum settles as underpaid, and one that received nothing settles as expired. A single
            payment can override this by sending expiresInSeconds on POST /v1/payments.
          </p>
        </CardBody>
      </Card>

      <EnvironmentSeparation environment={merchant.environment} />

      <Card>
        <CardHeader title="Changing these values" />
        <CardBody>
          <p className="text-sm text-text-muted">
            The API exposes no endpoint that writes a merchant configuration. GET /v1/merchants/me
            is the whole of the surface, so this screen is read-only and there is nothing here to
            save. The three settings above live on the merchants row in the API database and an
            operator changes them there. The database bounds what they may be set to: each tolerance
            is between 0 and 1000 basis points, and the default lifetime is between 60 and 86400
            seconds.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
