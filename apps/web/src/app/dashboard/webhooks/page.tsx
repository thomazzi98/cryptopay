import { DeliveryLog } from './_webhooks/delivery-log';
import { SigningSecrets } from './_webhooks/signing-secrets';

/**
 * The callback screen, which is a repair tool before it is a report.
 *
 * A merchant arrives here because their receiver was down when an event was sent, so the delivery
 * log leads and redelivery sits on every row rather than behind a detail page. Nothing is rendered
 * on the server: a queued delivery retries on its own schedule, and a server-rendered attempt count
 * is already wrong by the time it is read.
 */
export default function WebhooksPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-text">Callbacks</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Every webhook this environment has sent, with each attempt it took. A failed delivery
          retries on its own; redeliver when your endpoint missed one and you need it again.
        </p>
      </div>

      <DeliveryLog />
      <SigningSecrets />
    </div>
  );
}
