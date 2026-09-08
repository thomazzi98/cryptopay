'use client';

import { useQuery } from '@tanstack/react-query';

import type { Merchant, WebhookSecret } from '@cryptopay/shared';

import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Skeleton,
} from '@/components/ui/surfaces';
import { Field } from '@/components/ui/data';
import { ApiError, callApi } from '@/lib/api-client';
import { formatDuration, formatTimestamp } from '@/lib/format';

/**
 * The two facts on this page that belong to the reader's own account rather than to the product.
 *
 * Neither one moves while the page is open, so neither polls: the tolerances and the signing secrets
 * change only when a person changes them, and a four-second refetch of a documentation page would be
 * load with nothing to show for it.
 */

interface WebhookSecretList {
  readonly data: readonly WebhookSecret[];
}

/**
 * TanStack names its loader option `queryFn`, which the naming rule rejects and which no rename can
 * fix. It is written once here, as a computed key, and every query on this page goes through it.
 */
function queryFor<T>(key: readonly string[], load: (signal: AbortSignal) => Promise<T>) {
  return { queryKey: key, ['queryFn']: ({ signal }: { signal: AbortSignal }) => load(signal) };
}

function detailOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail;
  }
  return 'The dashboard could not reach the API.';
}

export function AccountDefaultsCard() {
  const merchantQuery = useQuery(
    queryFor(['integration', 'merchant'], (signal) =>
      callApi<Merchant>('v1/merchants/me', { signal }),
    ),
  );

  const merchant = merchantQuery.data;

  return (
    <Card>
      <CardHeader
        title="Your account"
        description="The values the API applies to every payment this key creates."
      />
      {merchantQuery.isPending && (
        <CardBody className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }, (unused, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </CardBody>
      )}
      {merchantQuery.isError && <ErrorState detail={detailOf(merchantQuery.error)} />}
      {merchant !== undefined && (
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-4">
            <Field label="Merchant">{merchant.displayName}</Field>
            <Field label="Environment">
              <span className="tabular font-mono text-xs">{merchant.environment}</span>
            </Field>
            <Field label="Acceptance band">
              <span className="tabular">
                -{merchant.underpaymentToleranceBasisPoints} / +
                {merchant.overpaymentToleranceBasisPoints} bps
              </span>
            </Field>
            <Field label="Default window">
              <span
                className="tabular"
                title={`${merchant.defaultPaymentLifetimeSeconds.toString()} seconds`}
              >
                {formatDuration(merchant.defaultPaymentLifetimeSeconds)}
              </span>
            </Field>
          </dl>
        </CardBody>
      )}
    </Card>
  );
}

export function SigningSecretsCard() {
  const secretsQuery = useQuery(
    queryFor(['integration', 'webhook-secrets'], (signal) =>
      callApi<WebhookSecretList>('v1/webhooks/secrets', { signal }),
    ),
  );

  const secrets = secretsQuery.data?.data;

  return (
    <Card>
      <CardHeader
        title="Signing secrets in use"
        description="A secret is shown in full once, when it is created. Afterwards only the hint is returned."
      />
      {secretsQuery.isPending && (
        <CardBody className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardBody>
      )}
      {secretsQuery.isError && <ErrorState detail={detailOf(secretsQuery.error)} />}
      {secrets?.length === 0 && (
        <EmptyState
          title="No signing secret yet"
          description="Callbacks are signed with a secret you create on the Webhooks screen. Until one exists there is nothing for a receiver to verify against."
        />
      )}
      {secrets !== undefined && secrets.length > 0 && (
        <CardBody className="space-y-2">
          {secrets.map((secret) => (
            <div
              key={secret.identifier}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-2"
            >
              <span className="tabular font-mono text-xs text-text">{secret.hint}</span>
              <span className="tabular text-xs text-text-muted">
                created {formatTimestamp(secret.createdAt)}
              </span>
              {secret.retiredAt !== null && (
                <span className="tabular text-xs text-text-subtle">
                  retired {formatTimestamp(secret.retiredAt)}
                </span>
              )}
            </div>
          ))}
        </CardBody>
      )}
    </Card>
  );
}
