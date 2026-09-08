/**
 * The samples this page renders.
 *
 * Every field in the request and response bodies below exists in the API contract, and every path
 * exists in the routes. They are kept here as plain strings rather than assembled from live data on
 * purpose: a developer copies them into a terminal, so what is shown has to be what runs.
 */

export const CREATE_PAYMENT_SAMPLE = `export CRYPTOPAY_API_URL="https://api.your-cryptopay-host.example"
export CRYPTOPAY_API_KEY="cp_live_..."

curl -sS "$CRYPTOPAY_API_URL/v1/payments" \
  -H "authorization: Bearer $CRYPTOPAY_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{
    "network": "polygon-mainnet",
    "assetSymbol": "USDC",
    "amount": "25.00",
    "callbackUrl": "https://merchant.example.com/webhooks/cryptopay",
    "merchantReference": "order-10422",
    "metadata": { "orderId": "order-10422" },
    "expiresInSeconds": 1800
  }'`;

export const CREATED_PAYMENT_SAMPLE = `HTTP/1.1 201 Created

{
  "identifier": "pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N",
  "status": "pending",
  "statusVersion": 0,
  "environment": "live",
  "network": "polygon-mainnet",
  "chainIdentifier": 137,
  "asset": {
    "reference": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    "symbol": "USDC",
    "decimals": 6
  },
  "requestedAmount": { "baseUnits": "25000000", "display": "25.000000" },
  "creditedAmount": { "baseUnits": "0", "display": "0.000000" },
  "acceptanceBand": {
    "minimumBaseUnits": "24950000",
    "maximumBaseUnits": "25050000"
  },
  "receivingAccount": "0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d",
  "confirmations": 0,
  "requiredConfirmations": 12,
  "finalityConfirmed": false,
  "settlingBlockHeight": null,
  "merchantReference": "order-10422",
  "callbackUrl": "https://merchant.example.com/webhooks/cryptopay",
  "metadata": { "orderId": "order-10422" },
  "checkoutUrl": "https://pay.example.com/pay/9f2Qk1sZtN0aVx7BdR3cLu",
  "explorerAccountUrl": "https://polygonscan.com/address/0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d",
  "createdAt": "2026-09-07T09:12:44.108Z",
  "expiresAt": "2026-09-07T09:42:44.108Z",
  "completedAt": null,
  "transfers": []
}`;

export const POLL_PAYMENT_SAMPLE = `curl -sS "$CRYPTOPAY_API_URL/v1/payments/pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N" \
  -H "authorization: Bearer $CRYPTOPAY_API_KEY"

# The same resource, later in its life. Only the fields that moved are shown here.
{
  "status": "completed",
  "statusVersion": 4,
  "creditedAmount": { "baseUnits": "25000000", "display": "25.000000" },
  "confirmations": 12,
  "requiredConfirmations": 12,
  "finalityConfirmed": true,
  "settlingBlockHeight": "64821907",
  "completedAt": "2026-09-07T09:19:02.443Z"
}`;

export const STANDARD_WEBHOOKS_SAMPLE = `import express from 'express';
import { Webhook } from 'standardwebhooks';

const webhook = new Webhook(process.env.CRYPTOPAY_WEBHOOK_SECRET);
const application = express();

// express.raw, not express.json: the signature covers the bytes that arrived.
application.post(
  '/webhooks/cryptopay',
  express.raw({ type: 'application/json' }),
  async (request, response) => {
    let event;
    try {
      event = webhook.verify(request.body, {
        'webhook-id': request.get('webhook-id'),
        'webhook-timestamp': request.get('webhook-timestamp'),
        'webhook-signature': request.get('webhook-signature'),
      });
    } catch {
      response.status(400).send('invalid signature');
      return;
    }

    // event.identifier is the webhook-id, stable across every retry and redelivery.
    const alreadyHandled = await recordEventOnce(event.identifier);
    if (alreadyHandled) {
      response.status(200).send('ok');
      return;
    }

    // statusVersion only ever increases, so an out-of-order delivery is discarded here.
    await applyPaymentUpdate(event.data);
    response.status(200).send('ok');
  },
);`;

export const NODE_CRYPTO_SAMPLE = `import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = 'whsec_';

function constantTimeEquals(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  // timingSafeEqual throws on a length mismatch, and the throw itself leaks the length.
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

// rawBody is a Buffer of exactly the bytes received. Never JSON.parse then re-serialize.
export function verifyCallback(rawBody, headers, secrets) {
  const identifier = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  if (identifier === undefined || !Number.isSafeInteger(timestamp)) {
    return false;
  }

  // Bounded in both directions: rejecting only old timestamps leaves a captured request replayable.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TOLERANCE_SECONDS) {
    return false;
  }

  // The header carries one or more space-separated signatures. During a secret rotation both the
  // old and the new secret sign, so accept a match against any of them.
  const presented = String(headers['webhook-signature'] ?? '')
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => entry.slice('v1,'.length));

  let matched = false;
  for (const secret of secrets) {
    const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
    const hmac = createHmac('sha256', Buffer.from(encoded, 'base64'));
    hmac.update(\`\${identifier}.\${timestamp}.\`);
    hmac.update(rawBody);
    const expected = hmac.digest('base64');
    // Not exited early on a mismatch, so the time taken does not reveal which candidate matched.
    for (const candidate of presented) {
      matched = constantTimeEquals(expected, candidate) || matched;
    }
  }
  return matched;
}`;

export const CALLBACK_BODY_SAMPLE = `POST /webhooks/cryptopay HTTP/1.1
webhook-id: whd_01K4QW7A5B8N2C6D0E4F8G1H3J
webhook-timestamp: 1788000000
webhook-signature: v1,K4kM0y9c1s7Xh2p8Qb6Rj3Tn5Vw7Zy9Ac1Ef3Gh5Ik=
cryptopay-event-type: payment.completed
cryptopay-environment: live
content-type: application/json

{
  "identifier": "whd_01K4QW7A5B8N2C6D0E4F8G1H3J",
  "type": "payment.completed",
  "occurredAt": "2026-09-07T09:19:02.443Z",
  "environment": "live",
  "data": { "identifier": "pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N", "status": "completed" }
}`;
