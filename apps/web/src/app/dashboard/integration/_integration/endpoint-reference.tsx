import { Card, CardHeader } from '@/components/ui/surfaces';

interface Endpoint {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly summary: string;
}

const ENDPOINTS: readonly Endpoint[] = Object.freeze([
  {
    method: 'POST',
    path: '/v1/payments',
    summary: 'Create a payment. Requires an Idempotency-Key header.',
  },
  {
    method: 'GET',
    path: '/v1/payments',
    summary:
      'List payments, filtered by status, network, merchantReference or a created window. Cursor paging with startingAfter.',
  },
  { method: 'GET', path: '/v1/payments/{paymentId}', summary: 'Read one payment.' },
  {
    method: 'GET',
    path: '/v1/payments/{paymentId}/transfers',
    summary: 'Every transfer seen for this payment, orphaned and wrong-asset ones included.',
  },
  {
    method: 'GET',
    path: '/v1/payments/{paymentId}/timeline',
    summary: 'The status changes as they were recorded, with the trigger for each.',
  },
  {
    method: 'GET',
    path: '/v1/payments/{paymentId}/deliveries',
    summary: 'The callbacks sent for this payment.',
  },
  {
    method: 'POST',
    path: '/v1/payments/{paymentId}/cancel',
    summary: 'Cancel a payment that has not been funded. Rejected once money has arrived.',
  },
  {
    method: 'GET',
    path: '/v1/webhooks/deliveries',
    summary: 'List deliveries, filtered by status or payment.',
  },
  {
    method: 'GET',
    path: '/v1/webhooks/deliveries/{deliveryId}',
    summary: 'One delivery with every attempt, its response status and why it failed.',
  },
  {
    method: 'POST',
    path: '/v1/webhooks/deliveries/{deliveryId}/redeliver',
    summary:
      'Queue a delivery again, successful ones included. The webhook-id does not change, so a receiver that already handled it deduplicates.',
  },
  {
    method: 'GET',
    path: '/v1/webhooks/secrets',
    summary: 'The active signing secrets, as hints only.',
  },
  {
    method: 'POST',
    path: '/v1/webhooks/secrets',
    summary:
      'Issue a secret and start a rotation. Both secrets sign during the overlap; the full value is returned exactly once.',
  },
  {
    method: 'DELETE',
    path: '/v1/webhooks/secrets/{secretId}',
    summary: 'Retire a secret. The last remaining one cannot be retired.',
  },
  {
    method: 'GET',
    path: '/v1/merchants/me',
    summary: 'The merchant a key belongs to, and its tolerances and default payment window.',
  },
  { method: 'GET', path: '/healthz', summary: 'Liveness. No authentication.' },
  {
    method: 'GET',
    path: '/readyz',
    summary: 'Readiness, including dependencies. No authentication.',
  },
]);

const MUTATING_METHOD_CLASS = 'border-accent bg-accent-soft text-accent';
const READ_METHOD_CLASS = 'border-border bg-surface-sunken text-text-muted';

export function EndpointReference() {
  return (
    <Card>
      <CardHeader
        title="Endpoints"
        description="Every merchant endpoint takes an Authorization: Bearer key, and answers errors as RFC 9457 problem documents with a stable code."
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-5 py-2 text-xs font-medium tracking-wide text-text-subtle uppercase">
                Method
              </th>
              <th className="px-5 py-2 text-xs font-medium tracking-wide text-text-subtle uppercase">
                Path
              </th>
              <th className="px-5 py-2 text-xs font-medium tracking-wide text-text-subtle uppercase">
                What it does
              </th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((endpoint) => (
              <tr
                key={`${endpoint.method} ${endpoint.path}`}
                className="border-b border-border last:border-0 hover:bg-surface-hover"
              >
                <td className="px-5 py-2 align-top">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-xs ${
                      endpoint.method === 'GET' ? READ_METHOD_CLASS : MUTATING_METHOD_CLASS
                    }`}
                  >
                    {endpoint.method}
                  </span>
                </td>
                <td className="tabular px-5 py-2 align-top font-mono text-xs whitespace-nowrap text-text">
                  {endpoint.path}
                </td>
                <td className="px-5 py-2 align-top text-text-muted">{endpoint.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
