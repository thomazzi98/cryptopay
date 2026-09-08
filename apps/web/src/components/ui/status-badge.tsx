import type { PaymentStatus } from '@cryptopay/shared';

import { classNames } from '@/lib/class-names';
import { describeStatus } from '@/lib/payment-status';

/**
 * A status, shown the same way everywhere.
 *
 * The glyph is not decoration. Colour alone is unreadable to a colour-blind merchant and survives no
 * screenshot pasted into a support thread, so every badge carries a shape that means the same thing.
 */
export function StatusBadge({
  status,
  size = 'default',
  className,
}: {
  status: PaymentStatus;
  size?: 'default' | 'large';
  className?: string;
}) {
  const descriptor = describeStatus(status);

  return (
    <span
      className={classNames(
        'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        size === 'large' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs',
        className,
      )}
      style={{
        color: descriptor.token,
        backgroundColor: descriptor.softToken,
        borderColor: descriptor.token,
      }}
      title={descriptor.summary}
    >
      <span
        aria-hidden="true"
        className={classNames(!descriptor.isFinal && 'animate-status-pulse')}
      >
        {descriptor.glyph}
      </span>
      {descriptor.label}
    </span>
  );
}
