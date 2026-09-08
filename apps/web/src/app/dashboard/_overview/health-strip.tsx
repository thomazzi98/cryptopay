import { classNames } from '@/lib/class-names';

import { formatSeconds } from './metrics';
import { isHalted, type ComponentStatus, type ReadinessReport } from './readiness';

/**
 * What an operator has to be able to see at a glance, in order: whether traffic should be reaching
 * this instance, whether any chain has stopped being scanned, and what the callback destination
 * policy is. The last one is here rather than on a settings page because a relaxed policy permits
 * deliveries to private addresses, and nothing else on the dashboard would ever mention it.
 */

const STATUS_STYLES: Readonly<Record<ComponentStatus, string>> = Object.freeze({
  ok: 'text-status-completed bg-status-completed-soft border-status-completed',
  degraded: 'text-status-underpaid bg-status-underpaid-soft border-status-underpaid',
  failed: 'text-status-canceled bg-status-canceled-soft border-status-canceled',
});

const STATUS_LABELS: Readonly<Record<ComponentStatus, string>> = Object.freeze({
  ok: 'Ready',
  degraded: 'Degraded',
  failed: 'Not ready',
});

const STATUS_GLYPHS: Readonly<Record<ComponentStatus, string>> = Object.freeze({
  ok: '✓',
  degraded: '!',
  failed: '×',
});

function HealthPill({ status, label }: { status: ComponentStatus; label: string }) {
  return (
    <span
      className={classNames(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_STYLES[status],
      )}
    >
      <span aria-hidden="true">{STATUS_GLYPHS[status]}</span>
      {label}
    </span>
  );
}

export function HealthStrip({ report }: { report: ReadinessReport }) {
  const isRelaxed = report.callbackSsrfPolicy === 'relaxed';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <HealthPill status={report.status} label={STATUS_LABELS[report.status]} />
        <span className="tabular text-xs text-text-subtle">
          Up {formatSeconds(report.uptimeSeconds)}
        </span>
      </div>

      <p
        className={classNames(
          'rounded-lg border px-3 py-2 text-xs',
          isRelaxed
            ? 'border-status-underpaid bg-status-underpaid-soft text-status-underpaid'
            : 'border-border bg-surface-sunken text-text-muted',
        )}
      >
        <span className="font-medium">
          Callback destination policy: {report.callbackSsrfPolicy}.
        </span>{' '}
        {isRelaxed
          ? 'Private and internal webhook destinations can be reached from this instance. This belongs in development only.'
          : 'Webhook destinations are re-validated against the full policy, including DNS resolution, before every attempt.'}
      </p>

      <ul className="space-y-2">
        {report.components.map((component) => (
          <li
            key={component.name}
            className={classNames(
              'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2',
              component.status === 'ok'
                ? 'border-border bg-surface'
                : 'border-border-strong bg-surface-sunken',
            )}
          >
            <HealthPill status={component.status} label={STATUS_LABELS[component.status]} />
            <span className="font-mono text-xs text-text">{component.name}</span>
            {isHalted(component) && (
              <span className="rounded-full border border-status-canceled bg-status-canceled-soft px-2 py-0.5 text-xs font-medium text-status-canceled">
                Scanning halted
              </span>
            )}
            <span className="min-w-0 flex-1 text-xs text-text-muted">{component.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
