import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';

import { CodeBlock } from './code-block';
import { CALLBACK_BODY_SAMPLE, NODE_CRYPTO_SAMPLE, STANDARD_WEBHOOKS_SAMPLE } from './samples';

/**
 * Two implementations of one scheme, because the two ways receivers get this wrong are not fixed by
 * choosing a library: a re-serialized body and an unstable idempotency key both verify locally and
 * fail in production.
 */

const RULES: readonly { readonly title: string; readonly body: string }[] = Object.freeze([
  {
    title: 'The webhook-id is the idempotency key',
    body: 'It is the delivery identifier and it is byte-identical across every retry and every redelivery you ask for from the dashboard. Store it, and treat a second arrival of the same id as already handled. Deduplicating on anything else, including the payment identifier or the timestamp, ships the order twice.',
  },
  {
    title: 'Verify the raw bytes, never a re-serialization',
    body: 'The signature covers the exact body that arrived. Parsing the JSON and serializing it again reorders keys and rewrites number formatting, so the digest no longer matches and nothing in either log says why. Read the body as a Buffer before any parser touches it.',
  },
]);

export function WebhookVerification() {
  return (
    <Card>
      <CardHeader
        title="Verifying a callback"
        description="Standard Webhooks signing: HMAC-SHA256 over the string {webhook-id}.{webhook-timestamp}.{raw body}, compared in constant time."
      />
      <CardBody className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {RULES.map((rule) => (
            <div
              key={rule.title}
              className="rounded-lg border border-border-strong bg-surface-sunken px-4 py-3"
            >
              <p className="text-sm font-medium text-text">{rule.title}</p>
              <p className="mt-1 text-sm text-text-muted">{rule.body}</p>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">What arrives</h3>
          <p className="max-w-3xl text-sm text-text-muted">
            The timestamp is regenerated on every attempt, so a retry after an outage still lands
            inside the tolerance window. The <code className="font-mono text-xs">data</code> field
            carries the same payment resource that{' '}
            <code className="font-mono text-xs">GET /v1/payments/{'{paymentId}'}</code> returns and
            is elided below.
          </p>
          <CodeBlock label="Callback request" code={CALLBACK_BODY_SAMPLE} />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">With a Standard Webhooks library</h3>
          <p className="max-w-3xl text-sm text-text-muted">
            CryptoPay signs the published Standard Webhooks scheme, so{' '}
            <code className="font-mono text-xs">standardwebhooks</code> and{' '}
            <code className="font-mono text-xs">svix</code> both verify it unchanged. Pass the
            secret exactly as it was issued, <code className="font-mono text-xs">whsec_</code>{' '}
            prefix included; the library decodes the base64 that follows and uses those bytes as the
            key.
          </p>
          <CodeBlock label="receiver.js" code={STANDARD_WEBHOOKS_SAMPLE} />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">With node:crypto and no dependency</h3>
          <p className="max-w-3xl text-sm text-text-muted">
            The same computation written out. Note the two comparisons that are not shortcuts: the
            timestamp window is bounded in both directions, and every candidate signature is
            compared without an early exit so the time taken reveals nothing about which secret
            matched.
          </p>
          <CodeBlock label="verify-callback.js" code={NODE_CRYPTO_SAMPLE} />
        </div>
      </CardBody>
    </Card>
  );
}
