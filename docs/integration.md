# Integrating with the API

Everything here is served by the same API the dashboard uses. There is no private endpoint the
dashboard reaches that a merchant cannot, which is deliberate: it is the cheapest possible proof that
the public API is complete.

The machine-readable contract is at **`GET /openapi.json`** — OpenAPI 3.1, generated from the same
zod schemas the server validates requests with. Generate a client from it rather than hand-writing
one. The server refuses to start if that document does not describe the routes it actually serves, so
an endpoint you find there is an endpoint that exists.

```bash
curl -s http://localhost:3001/openapi.json | jq '.paths | keys'
```

## Authentication

One header, on every merchant endpoint:

```
Authorization: Bearer cp_test_01K4QW6ZR2M8X4T7YQ0C3D5B9N_<secret>
```

The key carries the environment. A `cp_test_` key can only create, read and cancel payments on test
networks; a `cp_live_` key only on live ones. There is no environment parameter in any request, so
there is no way to get it wrong — and no way for a staging deployment holding a test key to move real
money, whatever it is asked to do.

`GET /v1/merchants/me` is the cheapest way to check a key and discover which environment it belongs
to.

## Discover what you can accept

Do not hardcode chain identifiers, token contract addresses or confirmation counts. Ask:

```bash
curl -s http://localhost:3001/v1/networks -H "Authorization: Bearer $CRYPTOPAY_API_KEY"
```

```json
{
  "data": [
    {
      "network": "polygon-amoy",
      "chainIdentifier": 80002,
      "displayName": "Polygon Amoy",
      "environment": "test",
      "nativeCurrency": { "symbol": "POL", "decimals": 18 },
      "requiredConfirmations": 5,
      "requiresFinalityTag": true,
      "assets": [
        {
          "reference": "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
          "symbol": "USDC",
          "decimals": 6
        }
      ],
      "explorerBaseUrl": "https://amoy.polygonscan.com",
      "walletRpcUrl": null
    }
  ]
}
```

A network absent from that list is not being scanned by this deployment, and payment creation on it
is refused with `503` rather than accepted into a void. When an operator adds a network, it appears
here and nothing on your side changes.

`reference` is the token identity. `symbol` is display only: bridged USDC.e returns the byte-identical
string `"USDC"` on chain, so a system that matches on symbol credits the wrong asset.

## Create a payment

```bash
curl -s -X POST http://localhost:3001/v1/payments \
  -H "Authorization: Bearer $CRYPTOPAY_API_KEY" \
  -H "Idempotency-Key: order-10422-attempt-1" \
  -H "Content-Type: application/json" \
  -d '{
        "network": "polygon-amoy",
        "assetSymbol": "USDC",
        "amount": "25.00",
        "callbackUrl": "https://merchant.example.com/webhooks/cryptopay",
        "merchantReference": "order-10422",
        "metadata": { "orderId": "10422" },
        "expiresInSeconds": 1800
      }'
```

```json
{
  "identifier": "pay_01M1ZE187S0193QC86T4Y35EPW",
  "status": "pending",
  "statusVersion": 0,
  "environment": "test",
  "network": "polygon-amoy",
  "chainIdentifier": 80002,
  "asset": { "reference": "0x41e9…7582", "symbol": "USDC", "decimals": 6 },
  "requestedAmount": { "baseUnits": "25000000", "display": "25.000000" },
  "creditedAmount": { "baseUnits": "0", "display": "0.000000" },
  "acceptanceBand": { "minimumBaseUnits": "25000000", "maximumBaseUnits": "25000000" },
  "receivingAccount": "0x1077840bd639dbd769cb7dde82235d265e73f28a",
  "confirmations": 0,
  "requiredConfirmations": 5,
  "finalityConfirmed": false,
  "checkoutUrl": "http://localhost:3000/pay/8Qk2…",
  "expiresAt": "2026-09-08T00:30:00.000Z"
}
```

Send the customer to `checkoutUrl`, or build your own page against `receivingAccount`, `asset` and
`requestedAmount.baseUnits`. Both are supported; the checkout page is a client of the same public
`GET /v1/checkout/{checkoutToken}` endpoint.

`Idempotency-Key` is **required**. It is how a network timeout on your side stays a single payment
rather than two addresses waiting for one customer:

| Situation                                    | Answer                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Same key, same body, first request finished  | `201` with `idempotency-replayed: true` and the original payment, byte for byte |
| Same key, same body, first request in flight | `429` with `Retry-After`. Retry; the eventual answer is the same payment        |
| Same key, different body                     | `422`. The key is bound to the request it was first used with                   |

## Amounts

Every amount is two decimal **strings**, never a JSON number:

```json
{ "baseUnits": "25000000", "display": "25.000000" }
```

`baseUnits` is the integer in the asset's smallest unit and is what you compare and store. Reading it
into a double is correct today, at six decimals, and silently wrong the first time an asset has
eighteen. `amount` on the way in is a decimal string too: `"25.00"`, not `25.0`. More precision than
the asset holds is rejected rather than rounded — the rounding would be someone's money.

## Addresses

Lowercase everywhere in this API, including `receivingAccount`. Checksum for display if you like,
never to compare.

## Being told what happened

Two ways, and they never disagree, because the webhook body carries the same payment resource
`GET /v1/payments/{id}` returns.

**Webhooks** are signed as [Standard Webhooks](https://www.standardwebhooks.com/), so `svix` or
`standardwebhooks` verifies them off the shelf. Read [webhooks.md](webhooks.md) for the verification
code, the retry schedule, and the three rules implementations get wrong. Three properties matter for
your side:

- `webhook-id` is stable across every retry and every redelivery of the same event. It is your
  idempotency key. Deduplicate on it.
- `statusVersion` increases with each applied change. Discard an event whose version is not greater
  than the one you have stored, and out-of-order delivery stops mattering.
- Return `2xx` quickly. A `3xx` is treated as permanent and never followed; the body is not read.

**Polling** works and is not second class: `GET /v1/payments?status=confirming&limit=100`, cursor
paginated with `startingAfter`. A merchant that supplies no `callbackUrl` gets no delivery rows, which
is the intended way to say "I will poll".

## Statuses you have to handle

`pending` → `partially_funded` → `confirming` → `completed`, plus the terminal ones you cannot ignore:
`overpaid`, `underpaid`, `expired`, `canceled`. The full table, generated from the code that enforces
it, is in [state-machine.md](state-machine.md).

Two of them exist because collapsing them loses money. `underpaid` is terminal and `partially_funded`
is not: a payment that received too little and then expired stays terminal, and a late transfer is
recorded as a `late` row against the payment rather than reviving it. `overpaid` is not a failure —
the customer paid, and the excess is yours to refund out of band.

There is no `failed`. A reverted ERC-20 transfer emits no event at all, so nothing to fail exists.

## Errors

Every error is [RFC 9457 problem details](https://www.rfc-editor.org/rfc/rfc9457), with
`content-type: application/problem+json`:

```json
{
  "type": "https://cryptopay.dev/problems/validation-failed",
  "title": "Request validation failed",
  "status": 422,
  "detail": "The payment could not be created from this request.",
  "code": "validation_failed",
  "requestId": "0d1f…",
  "errors": [{ "path": "amount", "message": "Must be a decimal amount as a string" }]
}
```

Branch on `code`, never on `title`. Log `requestId`: it is the `x-request-id` on the response and the
correlation id in the server logs, so quoting it in a support request is the difference between
minutes and days.

A resource belonging to another merchant answers `404`, not `403`. A `403` would confirm the
identifier exists, which is all an enumeration attack needs.

## Putting CryptoPay behind another gateway

There is a contract for exactly this, at `/api/v1`, and it is deliberately not the same surface as
`/v1`. The two answer different questions. `/v1` serves a dashboard that wants the whole truth about
a payment, including orphaned transfers and the internal status. `/api/v1` serves an orchestrator
that wants to know what to show a customer and when to release goods, and wants to know it without
learning anything about blockchains.

```http
POST /api/v1/payments
Authorization: Bearer cp_live_...
Idempotency-Key: order_12345_attempt_1
Content-Type: application/json

{
  "externalReference": "order_12345",
  "network": "polygon",
  "currency": "USDC",
  "amount": "25.00",
  "callbackUrl": "https://payment-gateway.example.com/webhooks/crypto",
  "expiresIn": 1800,
  "metadata": { "orderId": "12345" }
}
```

```json
{
  "id": "pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N",
  "status": "CREATED",
  "network": "polygon",
  "chainId": 137,
  "currency": "USDC",
  "amount": "25.000000",
  "amountReceived": "0.000000",
  "paymentDestination": { "address": "0x...", "memo": null },
  "paymentUri": "ethereum:0x3c49...@137/transfer?address=0x...&uint256=25000000",
  "qrCode": "data:image/png;base64,...",
  "expiresAt": "2026-09-08T15:30:00Z",
  "explorer": { "address": "https://polygonscan.com/address/0x...", "transaction": null }
}
```

Four things about that exchange are worth knowing before you build on it.

**You name a chain family, not a deployment.** `network` is `polygon`, `tron` or `solana`. Which
deployment of that family the payment lands on follows from the environment of the API key you used,
so a `cp_test_` key has no way to spell mainnet. Ask `GET /v1/networks` for what a key can reach.

**You name a currency, never a contract.** `currency` is `USDC`, `USDT`, `POL` and so on, and the
field will not accept an address. The server resolves the pair to an asset. This is why the Polygon
USDT contract reporting its symbol as `USDT0` is our problem rather than yours.

**`paymentUri` and `qrCode` are already correct for the chain.** Polygon gets EIP-681, Solana gets
Solana Pay, TRON gets the convention TRON wallets accept, because TRON has ratified no standard. Show
the QR code, or hand the URI to a wallet deep link. You never branch on the network to do it.

**`PAID` means paid, not paid exactly.** It covers an exact payment and an overpayment alike, so read
`amountReceived` beside it if the difference matters to you. `FAILED` with
`failureReason: "insufficient_amount"` is an underpayment: the money is real and is still at the
destination, it simply never reached the acceptance band before the payment expired.

### The lifecycle you have to handle

```text
CREATED ─────► WAITING_FOR_PAYMENT ─────► PAYMENT_DETECTED ─────► CONFIRMING ─────► PAID
   │                   │                        │                      │
   │                   ├──► EXPIRED             └──► FAILED            └──► FAILED
   │                   └──► CANCELLED
   └──► (may skip straight to PAYMENT_DETECTED or CONFIRMING)
```

Two shapes surprise people, and both are real rather than defensive. A single transfer that pays in
full goes straight to `CONFIRMING` without ever being `PAYMENT_DETECTED`, so do not wait for a state
you may never see. And a chain reorganisation can walk a payment _backwards_ — `CONFIRMING` to
`PAYMENT_DETECTED`, or to `WAITING_FOR_PAYMENT` — because value that was on the chain no longer is.
Treat state as the current answer rather than as a ratchet, and release goods on `PAID` alone.

No state leaves `PAID`, `EXPIRED`, `CANCELLED` or `FAILED`. That is what makes it safe to act on them.

### The rest of the surface

- `GET /api/v1/payments/{id}` for the payment and every chain transaction seen against it. One
  payment can have several: a partial payment, a top-up, a duplicate, or a late arrival.
- `GET /api/v1/payments/{id}/status` for polling. It is the narrow answer, without the payload you
  already hold.
- `POST /api/v1/payments/{id}/cancel`, refused once any value has been observed, because cancelling a
  payment the customer has already funded would strand real money.
- `GET /health` and `GET /readiness` for your health dashboard. Readiness reports per-network scan lag
  and whether a network has halted, which is the failure that is otherwise invisible: payments keep
  being created and nothing is ever detected.

### Idempotency

`Idempotency-Key` is required on creation. The same merchant sending the same key with the same body
receives the original payment and an `idempotency-replayed: true` header, however many times and
however concurrently. The same key with a _different_ body is refused with
`IDEMPOTENCY_KEY_CONFLICT` rather than being served the wrong payment.

Separately, `externalReference` is unique per merchant per environment. A second payment for an
order you already have one for is refused with `DUPLICATE_EXTERNAL_REFERENCE`, which is what stops a
retried order becoming two payments for the same goods.

### Errors

Every failure on this surface has one shape:

```json
{
  "error": {
    "code": "INVALID_PAYMENT_AMOUNT",
    "message": "The payment amount is invalid.",
    "requestId": "d94b1c2e-..."
  }
}
```

Branch on `code`; the message is for a person reading a log and may be reworded. `requestId` matches
the `x-request-id` response header and is what to quote when reporting a problem. Nothing else is
ever present: no stack trace, no driver message, no internal class or table name.

The codes creation can return are `VALIDATION_FAILED`, `INVALID_PAYMENT_AMOUNT`,
`UNSUPPORTED_CURRENCY`, `UNSUPPORTED_NETWORK`, `NETWORK_NOT_PERMITTED`, `NETWORK_UNAVAILABLE`,
`INVALID_CALLBACK_URL`, `DUPLICATE_EXTERNAL_REFERENCE`, `IDEMPOTENCY_KEY_REQUIRED`,
`IDEMPOTENCY_KEY_CONFLICT` and `IDEMPOTENCY_KEY_IN_USE`. Reading a payment can return
`PAYMENT_NOT_FOUND`; cancelling can also return `PAYMENT_NOT_CANCELLABLE`.

A payment belonging to another merchant answers `PAYMENT_NOT_FOUND`, exactly as one that does not
exist does. A 403 would confirm the identifier is real, which is the only thing an enumeration attack
needs.

The one thing to design for is the custody window: this system holds funds between crediting a
payment and sweeping it. See [limitations.md](limitations.md), which states the exposure plainly
rather than in a footnote.
