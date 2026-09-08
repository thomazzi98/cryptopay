-- Two holes in the idempotency reservation, both of which end in a merchant getting a payment they
-- did not ask for.
--
-- The key was scoped to the merchant alone. A merchant holds a test key and a live key, and the
-- obvious idempotency key is their own order number, so `order-10422` from the test environment
-- reserved the same row as `order-10422` from the live one. The second request then failed the
-- fingerprint comparison and was refused for twenty-four hours, with an error that describes a
-- collision the caller cannot see and cannot avoid.
--
-- The reservation also had no owner. The lock expires so an abandoned reservation does not wedge a
-- key forever, but nothing recorded who held it: a request that took longer than the lock lost it to
-- a retry, both requests created a payment, and both wrote their response over the same row. One
-- Idempotency-Key, two payments, two deposit addresses, and a customer able to pay either.
--
-- Reservations are a twenty-four hour cache of responses, not a system of record, so re-keying them
-- discards the contents rather than trying to attribute rows to an environment nothing recorded. On
-- a live deployment this is a quiet-window migration: for its duration a retry creates a new payment
-- where it would have replayed the first one.

DELETE FROM idempotency_keys;

ALTER TABLE idempotency_keys
  ADD COLUMN environment environment_name NOT NULL,
  -- Random per reservation attempt, returned to the caller, and required to write a response. A
  -- request that lost its lock discovers it when the write affects no rows, and rolls back the
  -- payment it had already created rather than leaving a second one behind.
  ADD COLUMN owner_token TEXT NOT NULL CHECK (length(owner_token) BETWEEN 16 AND 64);

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (merchant_id, environment, idempotency_key);
