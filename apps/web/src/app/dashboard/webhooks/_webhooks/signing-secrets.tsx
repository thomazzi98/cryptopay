'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { WebhookSecret } from '@cryptopay/shared';

import { callApi } from '@/lib/api-client';
import { formatTimestamp } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Copyable } from '@/components/ui/data';
import { Card, CardHeader, EmptyState, ErrorState, SkeletonRows } from '@/components/ui/surfaces';

import { errorDetail } from './error-detail';
import { RefreshFailureBanner } from './refresh-failure-banner';

/**
 * The secrets card, and the one moment in this dashboard that cannot be repeated.
 *
 * A rotation returns the new secret exactly once. It is therefore shown at full width with the
 * warning attached to it rather than in a toast a stray click dismisses, and the list below it only
 * ever shows hints.
 */

interface WebhookSecretList {
  readonly data: readonly WebhookSecret[];
}

function RevealedSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="mx-5 mt-4 rounded-xl border border-health-degraded bg-health-degraded-soft px-4 py-4"
    >
      <p className="text-sm font-semibold text-health-degraded">
        Copy this secret now. It will never be shown again.
      </p>
      <p className="mt-1 text-sm text-health-degraded">
        This is the only time the API returns the full value. Store it before you leave this page;
        if you lose it, the only recovery is another rotation.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-surface-raised px-3 py-2">
        <Copyable value={secret} display={secret} className="text-sm break-all" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="small" onClick={onDismiss}>
          I have stored it
        </Button>
        <span className="text-xs text-health-degraded">
          Both secrets sign during the overlap, so an endpoint still using the old one keeps
          verifying until you retire it.
        </span>
      </div>
    </div>
  );
}

function SecretRow({
  secret,
  onRetire,
  isRetiring,
  failure,
}: {
  secret: WebhookSecret;
  onRetire: (identifier: string) => void;
  isRetiring: boolean;
  failure: string | null;
}) {
  return (
    <li className="border-b border-border px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="tabular font-mono text-sm text-text">{secret.hint}</p>
          <p className="tabular mt-1 text-xs text-text-subtle">
            created {formatTimestamp(secret.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Copyable value={secret.identifier} />
          <Button
            variant="danger"
            size="small"
            loading={isRetiring}
            onClick={() => {
              onRetire(secret.identifier);
            }}
          >
            Retire
          </Button>
        </div>
      </div>
      {failure !== null && (
        <p role="alert" className="mt-2 text-sm text-health-failed">
          {failure}
        </p>
      )}
    </li>
  );
}

export function SigningSecrets() {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);

  const secretsQuery = useQuery<WebhookSecretList, unknown>({
    queryKey: ['webhook-secrets'],
    queryFn: () => callApi<WebhookSecretList>('v1/webhooks/secrets'),
  });

  const rotate = useMutation<WebhookSecret, unknown, void>({
    mutationFn: () => callApi<WebhookSecret>('v1/webhooks/secrets', { method: 'POST' }),
    onSuccess: async (created) => {
      setRevealed(created.secret);
      await queryClient.invalidateQueries({ queryKey: ['webhook-secrets'] });
    },
  });

  const retire = useMutation<void, unknown, string>({
    mutationFn: (identifier) =>
      callApi<void>(`v1/webhooks/secrets/${identifier}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['webhook-secrets'] });
    },
  });

  // The API refuses to retire the last active secret. That refusal is the useful answer, so the
  // control stays enabled and the reason is shown on the row it belongs to.
  function retirementFailure(identifier: string): string | null {
    if (!retire.isError || retire.variables !== identifier) {
      return null;
    }
    return errorDetail(retire.error);
  }

  const secrets = secretsQuery.data;
  const loadFailure = secretsQuery.isError ? errorDetail(secretsQuery.error) : null;

  function retry(): void {
    void secretsQuery.refetch();
  }

  return (
    <Card>
      <CardHeader
        title="Signing secrets"
        description="Every callback is signed with all active secrets. Rotate by overlap: create the replacement, deploy it, then retire the old one."
        action={
          <Button
            variant="primary"
            size="small"
            loading={rotate.isPending}
            onClick={() => {
              rotate.mutate();
            }}
          >
            Start a rotation
          </Button>
        }
      />

      {rotate.isError && (
        <p role="alert" className="px-5 pt-4 text-sm text-health-failed">
          {errorDetail(rotate.error)}
        </p>
      )}

      {revealed !== null && (
        <RevealedSecret
          secret={revealed}
          onDismiss={() => {
            setRevealed(null);
          }}
        />
      )}

      {secrets !== undefined && loadFailure !== null && (
        <RefreshFailureBanner detail={loadFailure} onRetry={retry} />
      )}

      {secrets === undefined && loadFailure === null && <SkeletonRows rows={2} />}

      {secrets === undefined && loadFailure !== null && (
        <ErrorState
          title="The signing secrets could not be loaded"
          detail={loadFailure}
          action={<Button onClick={retry}>Try again</Button>}
        />
      )}

      {secrets?.data.length === 0 && (
        <EmptyState
          title="No active signing secret"
          description="Callbacks cannot be verified until one exists. Start a rotation to issue the first."
        />
      )}

      {secrets !== undefined && secrets.data.length > 0 && (
        <ul className="mt-2">
          {secrets.data.map((secret) => (
            <SecretRow
              key={secret.identifier}
              secret={secret}
              isRetiring={retire.isPending && retire.variables === secret.identifier}
              failure={retirementFailure(secret.identifier)}
              onRetire={(identifier) => {
                retire.mutate(identifier);
              }}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
