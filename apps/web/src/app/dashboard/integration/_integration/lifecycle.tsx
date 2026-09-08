import { StatusBadge } from '@/components/ui/status-badge';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { describeStatus, STATUS_DISPLAY_ORDER } from '@/lib/payment-status';

/**
 * The statuses are read from the descriptors the rest of the dashboard renders from, so this list
 * cannot drift from the badge a merchant sees on a payment.
 */
export function Lifecycle() {
  return (
    <Card>
      <CardHeader
        title="Payment lifecycle"
        description="Each status is also an event type: a callback for a payment entering it is sent as payment.<status>."
      />
      <CardBody>
        <ul className="space-y-2">
          {STATUS_DISPLAY_ORDER.map((status) => {
            const descriptor = describeStatus(status);
            return (
              <li
                key={status}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg px-2 py-2 hover:bg-surface-hover"
              >
                <span className="shrink-0">
                  <StatusBadge status={status} />
                </span>
                <code className="tabular font-mono text-xs text-text-subtle">payment.{status}</code>
                <span className="min-w-0 flex-1 text-sm text-text-muted">{descriptor.summary}</span>
                <span className="shrink-0 text-xs text-text-subtle">
                  {descriptor.isFinal ? 'final' : 'still moving'}
                </span>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
