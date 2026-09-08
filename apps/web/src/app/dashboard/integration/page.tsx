import { AccountDefaultsCard, SigningSecretsCard } from './_integration/account-panels';
import { EndpointReference } from './_integration/endpoint-reference';
import { Lifecycle } from './_integration/lifecycle';
import { QuickStart } from './_integration/quick-start';
import { WebhookVerification } from './_integration/webhook-verification';

/**
 * The reference a developer integrates from without leaving the dashboard.
 *
 * The samples are literal text rather than anything generated, because they are copied into a
 * terminal and an editor: a body assembled at render time is a body whose bytes nobody can predict,
 * and the webhook signature covers exactly those bytes. The lifecycle list reads from the same
 * status descriptors every badge in this dashboard renders from, so the documentation cannot claim a
 * status the product does not have.
 */
export default function IntegrationPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-text">Integration</h1>
        <p className="max-w-3xl text-sm text-text-muted">
          Everything the API accepts and returns, with the two rules that decide whether a webhook
          receiver is correct. Amounts are decimal strings end to end, and addresses are lowercase
          everywhere except a rendered page.
        </p>
      </header>

      <AccountDefaultsCard />
      <QuickStart />
      <WebhookVerification />
      <SigningSecretsCard />
      <Lifecycle />
      <EndpointReference />
    </div>
  );
}
