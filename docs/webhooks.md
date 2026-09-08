# Webhooks

CryptoPay signs callbacks with [Standard Webhooks](https://www.standardwebhooks.com/), so you can
verify them with an off-the-shelf library on your first day rather than implementing anything.

## What arrives

A `POST` with a JSON body and these headers:

| Header                  | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `webhook-id`            | The event identifier. **Stable across every retry and every redelivery.** Use it as your idempotency key. |
| `webhook-timestamp`     | Unix seconds, **regenerated on each attempt**.                                                            |
| `webhook-signature`     | One or more space-separated `v1,<base64>` signatures.                                                     |
| `cryptopay-event-type`  | The event, for routing before you parse the body.                                                         |
| `cryptopay-environment` | `test` or `live`.                                                                                         |

The body carries the same payment resource `GET /v1/payments/{id}` returns, so there is one shape to
model rather than two:

```json
{
  "identifier": "whd_01K4QW6ZR2M8X4T7YQ0C3D5B9N",
  "type": "payment.completed",
  "occurredAt": "2026-09-07T18:22:41.019Z",
  "environment": "test",
  "data": { "identifier": "pay_01K4QW…", "status": "completed", "...": "…" }
}
```

Events are `payment.` followed by the status reached: `partially_funded`, `confirming`, `completed`,
`overpaid`, `underpaid`, `expired`, `canceled`.

## Verifying

The signature covers `{webhook-id}.{webhook-timestamp}.{raw body}`, HMAC-SHA256, base64. Your secret
arrives as `whsec_<base64>` and the **decoded bytes** are the key.

```js
import { Webhook } from 'standardwebhooks';

app.post('/callbacks', express.raw({ type: 'application/json' }), (request, response) => {
  const webhook = new Webhook(process.env.CRYPTOPAY_WEBHOOK_SECRET);
  try {
    // The RAW body. See the first rule below.
    const event = webhook.verify(request.body, request.headers);
    response.sendStatus(200);
    process(event);
  } catch {
    response.sendStatus(401);
  }
});
```

## Three rules implementations get wrong

**Verify the raw bytes.** If your framework parsed the body into an object, `JSON.stringify` of that
object is not what was signed: key order and whitespace differ, and the signature will never match.
Every framework has a way to keep the raw body; use it.

**Deduplicate on `webhook-id`, not on the payment identifier.** At-least-once delivery is the
contract. The same event will arrive twice eventually, and a redelivery you requested yourself
carries the **same** id deliberately, so that if you already processed it you can tell.

**Do not reject on a timestamp older than the event.** The timestamp is regenerated per attempt, so a
retry two days later still verifies. Reject on the timestamp being outside your tolerance of _now_,
which is what the libraries already do.

## Retries

Sixteen attempts across roughly 44 hours, dense at first and sparse later, with proportional jitter
and a 72-hour hard ceiling. `2xx` is success. A `3xx` is **permanent and never followed**: a redirect
would let anyone who can influence your DNS bounce a signed request carrying payment data elsewhere,
so update the URL instead. A `429` honours `Retry-After`. Other `4xx` responses are retried but give
up early, because a request your endpoint calls malformed will still be malformed on attempt sixteen.

Every attempt is recorded with the response status, a snippet of what your endpoint said, how long it
took, and **the IP address the request was actually sent to**. That last one is visible in the
dashboard and is worth checking if you are debugging a firewall.

## Sending one again

If your receiver was down, `POST /v1/webhooks/deliveries/{id}/redeliver`, or press **Redeliver** in
the dashboard. The `webhook-id` does not change, so your existing deduplication keeps working — a
receiver that already processed the event will recognise the repeat and can answer `200` without
doing anything twice.

A redelivery starts a fresh cycle: the whole retry schedule again, and the 72-hour ceiling measured
from the moment you asked rather than from the original event. That is why redelivering something
from last week works at all. The attempts already made stay in the history and the new ones are
appended, so the delivery log shows every request ever sent for that event, in order.

Redelivery is deliberately allowed for an event that was already delivered, not only for a failed
one. A merchant whose own transaction rolled back after answering `200` needs the event again, and
knows that better than we do.

## Rotating your secret

Rotation is by overlap, never by replacement. `POST /v1/webhooks/secrets` issues a new one; both sign
during the grace period, so an endpoint you have not updated yet keeps verifying. Retire the old one
with `DELETE /v1/webhooks/secrets/{id}` once you have deployed. The API refuses to retire your last
active secret: callbacks nobody can verify are worse than a stale secret that still works.

**A secret is shown once, when it is created.** There is no endpoint that reads one back, because a
value an API returns is a value that leaks through every log, proxy and screen share it passes.

If you retire every secret, deliveries are not thrown away: they are retried on the ordinary schedule
with `the merchant has no active signing secret` recorded against each attempt, and they go out by
themselves once a secret exists again. The schedule still ends them, so create one before it does.

## Where we will and will not send

Your URL must be `https` on port 443, with a fully qualified hostname and no credentials in it.
Every DNS record it resolves to is checked, and if **any** of them is a private, loopback, link-local,
carrier-grade NAT, multicast or cloud-metadata address, the delivery is refused and recorded as
blocked. The address that passed is then pinned for the connection, so a name that resolves
differently a moment later does not change where the request goes.

That is stricter than most processors and it will occasionally refuse something you meant. The
delivery log says exactly which rule refused it.
