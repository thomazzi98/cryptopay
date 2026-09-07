-- Callback delivery: the outbox, the signing secrets, and the record of every attempt.
--
-- The outbox exists because the alternative is a dual write. Committing a payment in PostgreSQL and
-- then enqueuing a job in a broker leaves a window in which the process can die: the payment is
-- completed forever and the merchant is never told. A row written in the same transaction as the
-- status change cannot be lost that way, and the delivery worker's only job is to drain it.

CREATE TYPE webhook_delivery_status AS ENUM (
  'pending', 'in_flight', 'delivered', 'failed', 'abandoned'
);

CREATE TYPE webhook_attempt_outcome AS ENUM (
  'delivered', 'retryable', 'permanent', 'blocked', 'timeout'
);

-- Signing secrets are per merchant and per environment, with rotation by overlap: a new secret is
-- added, both sign for a grace period, and the old one is retired once the merchant has adopted the
-- new one. Rotating by replacement would break every endpoint that had not yet been updated.
CREATE TABLE webhook_secrets (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  environment  environment_name NOT NULL,
  secret       TEXT NOT NULL CHECK (secret LIKE 'whsec_%'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at   TIMESTAMPTZ,

  CONSTRAINT webhook_secrets_retired_after_created
    CHECK (retired_at IS NULL OR retired_at >= created_at)
);

CREATE INDEX webhook_secrets_active_idx
  ON webhook_secrets (merchant_id, environment, created_at DESC) WHERE retired_at IS NULL;

CREATE TABLE webhook_deliveries (
  -- This identifier is transmitted as the `webhook-id` header and never changes, including across
  -- retries and a manual redelivery. It is the merchant's idempotency key: a retry that changed it
  -- would be processed as a second event, which for a completed payment means shipping twice.
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  payment_id        TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  environment       environment_name NOT NULL,
  event_type        TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  destination_url   TEXT NOT NULL CHECK (length(destination_url) BETWEEN 8 AND 2048),

  -- Serialized once, at enqueue, and transmitted byte for byte on every attempt. Re-serializing the
  -- object per attempt reorders keys, which changes the bytes the signature was computed over and
  -- makes verification fail on the merchant's side for reasons neither party can see.
  payload           TEXT NOT NULL,

  status            webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by        TEXT,
  claim_expires_at  TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  last_failure      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One delivery per payment event. The evaluation worker writes this row inside the transaction
  -- that changes the payment's status, and a replayed transition therefore conflicts rather than
  -- producing a second notification for the same fact.
  CONSTRAINT webhook_deliveries_event_unique UNIQUE (payment_id, event_type),

  CONSTRAINT webhook_deliveries_delivered_has_timestamp
    CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
  CONSTRAINT webhook_deliveries_claim_consistent
    CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL))
);

CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at, id) WHERE status IN ('pending', 'failed');

CREATE INDEX webhook_deliveries_payment_idx ON webhook_deliveries (payment_id, created_at DESC);

CREATE INDEX webhook_deliveries_merchant_idx
  ON webhook_deliveries (merchant_id, environment, created_at DESC);

-- One delivery in flight per merchant environment, enforced by the database rather than by the
-- worker's good intentions. It preserves the order a merchant sees events in, and it means eight
-- workers draining the queue cannot double-deliver: the second claim violates this index.
CREATE UNIQUE INDEX webhook_deliveries_single_flight
  ON webhook_deliveries (merchant_id, environment) WHERE status = 'in_flight';

CREATE TABLE webhook_delivery_attempts (
  id                     BIGSERIAL PRIMARY KEY,
  delivery_id            TEXT NOT NULL REFERENCES webhook_deliveries (id) ON DELETE CASCADE,
  attempt_number         INTEGER NOT NULL CHECK (attempt_number > 0),
  outcome                webhook_attempt_outcome NOT NULL,
  response_status        SMALLINT CHECK (response_status BETWEEN 100 AND 599),

  -- The address the request was actually pinned to, recorded because a destination that resolves to
  -- something different on the next attempt is the shape of a DNS rebinding attempt, and because a
  -- merchant debugging a firewall needs to know which of their addresses we reached.
  resolved_address       TEXT,

  -- A short prefix of the response, so support can answer "what did my endpoint say" without
  -- storing whatever a hostile endpoint chose to return.
  response_snippet       TEXT CHECK (response_snippet IS NULL OR length(response_snippet) <= 512),

  duration_milliseconds  INTEGER CHECK (duration_milliseconds >= 0),
  failure_reason         TEXT,

  -- True when the private-destination allowlist was what let this attempt through. Surfaced on the
  -- attempt row, in readiness and in the dashboard, so a development convenience can never be quietly
  -- in effect somewhere it should not be.
  used_private_allowlist BOOLEAN NOT NULL DEFAULT false,

  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT webhook_delivery_attempts_number_unique UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX webhook_delivery_attempts_delivery_idx
  ON webhook_delivery_attempts (delivery_id, attempt_number DESC);
