-- Settlement: moving credited funds out of a payment's deposit address.
--
-- Everything before this migration only ever read the chain. This is the first schema that exists
-- because the system signs and broadcasts, and the difference matters: a mistake on the read side
-- credits the wrong figure and can be corrected, while a mistake here spends money that does not
-- come back.
--
-- Three tables and one guarantee each.
--
--   settlements       one row per payment, ever. The UNIQUE on payment_id is what makes paying a
--                     merchant twice for one payment impossible rather than unlikely.
--   chain_transactions every transaction this system has ever broadcast, with the sequence number
--                     it used. The partial UNIQUE below is the double-spend guard.
--   chain_accounts    the sequence allocator, so two workers cannot hand out the same number.
--
-- The spend ledger is derived from chain_transactions rather than kept alongside it. A running
-- total in its own column is a second write that can disagree with the transactions it counts, and
-- the disagreement would be discovered by overspending.

-- 0001 declared a settlement_status enum and a payments.settlement_status column against a design
-- where settlement was a flag on the payment. Nothing ever wrote that column: no repository selects
-- it, no presenter exposes it, and the API contract that once carried it was removed. It has to go
-- before the name can be reused, and it is dead either way.
--
-- Settlement is a resource now, not a flag. That is the substantive change: a flag cannot record a
-- sequence number, a fee, a transaction reference, or an attempt that failed and will be tried
-- again, and all four are needed to move money without moving it twice.
ALTER TABLE payments DROP COLUMN settlement_status;
DROP TYPE settlement_status;

CREATE TYPE settlement_status AS ENUM (
  'pending',
  'funding',
  'sweeping',
  'confirming',
  'settled',
  'failed'
);

CREATE TYPE chain_transaction_purpose AS ENUM ('gas_funding', 'asset_sweep');

CREATE TYPE chain_transaction_status AS ENUM (
  'submitted',
  'confirming',
  'confirmed',
  'reverted',
  'dropped',
  'replaced'
);

-- Where a merchant's money goes. Per network as well as per environment, because an address that
-- exists on Polygon is not necessarily controlled by the same person on another chain, and
-- assuming otherwise is how funds are sent somewhere nobody can reach.
CREATE TABLE payout_destinations (
  merchant_id        TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  environment        environment_name NOT NULL,
  network_identifier network_identifier NOT NULL,
  account            TEXT NOT NULL CHECK (account = lower(account) AND account ~ '^0x[0-9a-f]{40}$'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (merchant_id, environment, network_identifier)
);

CREATE TABLE settlements (
  id                  TEXT PRIMARY KEY,

  -- One settlement per payment, enforced by the database rather than by the code that creates them.
  -- Every other guard against paying twice is an argument; this one is a fact.
  payment_id          TEXT NOT NULL UNIQUE REFERENCES payments (id) ON DELETE CASCADE,

  merchant_id         TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  environment         environment_name NOT NULL,
  network_identifier  network_identifier NOT NULL,

  source_account      TEXT NOT NULL CHECK (source_account = lower(source_account)),
  destination_account TEXT NOT NULL CHECK (destination_account = lower(destination_account)),

  -- Never the same address. A sweep to the address it came from burns gas and moves nothing, and
  -- the only way that happens is a configuration mistake worth failing loudly on.
  CONSTRAINT settlements_moves_somewhere CHECK (source_account <> destination_account),

  asset_reference     TEXT NOT NULL CHECK (asset_reference = lower(asset_reference)),

  -- Read back from the chain at planning time, not copied from the credited figure. The balance is
  -- what can actually be moved; the credited amount is what we believe we were paid, and a sweep
  -- built on the second one fails when they differ.
  amount              NUMERIC(78, 0) NOT NULL CHECK (amount > 0),

  status              settlement_status NOT NULL DEFAULT 'pending',
  status_version      INTEGER NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_reason      TEXT,
  settled_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT settlements_settled_has_time
    CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CONSTRAINT settlements_failure_has_reason
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL))
);

CREATE INDEX settlements_due ON settlements (network_identifier, status)
  WHERE status <> 'settled' AND status <> 'failed';

CREATE TABLE chain_transactions (
  id                          TEXT PRIMARY KEY,
  settlement_id               TEXT NOT NULL REFERENCES settlements (id) ON DELETE CASCADE,
  network_identifier          network_identifier NOT NULL,
  purpose                     chain_transaction_purpose NOT NULL,

  source_account              TEXT NOT NULL CHECK (source_account = lower(source_account)),
  destination_account         TEXT NOT NULL CHECK (destination_account = lower(destination_account)),

  -- The ledger-neutral name for what an EVM chain calls a nonce. It is the ordering guarantee that
  -- makes a broadcast idempotent: two transactions from one account with the same number cannot
  -- both be mined.
  sequence_number             BIGINT NOT NULL CHECK (sequence_number >= 0),

  transaction_reference       TEXT NOT NULL
                                CHECK (transaction_reference = lower(transaction_reference)),

  value_in_native_units       NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (value_in_native_units >= 0),

  -- What this transaction could cost at worst, computed before signing. The spend ceiling is
  -- checked against the sum of these, so a ceiling can never be crossed by a transaction that is
  -- already in flight.
  maximum_fee_in_native_units NUMERIC(78, 0) NOT NULL CHECK (maximum_fee_in_native_units > 0),

  -- The chain-specific fee fields, kept opaque above the adapter. On an EVM chain this holds the
  -- gas limit and the two EIP-1559 prices; another chain would put its own shape here without a
  -- migration.
  fee_parameters              JSONB NOT NULL,

  status                      chain_transaction_status NOT NULL DEFAULT 'submitted',
  compute_used                BIGINT CHECK (compute_used >= 0),
  fee_paid_in_native_units    NUMERIC(78, 0) CHECK (fee_paid_in_native_units >= 0),
  block_height                BIGINT CHECK (block_height >= 0),
  block_reference             TEXT CHECK (block_reference = lower(block_reference)),
  failure_reason              TEXT,
  submitted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at                TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A hash identifies one transaction. Two rows claiming the same one means the code lost track of
  -- which broadcast it was reconciling.
  CONSTRAINT chain_transactions_reference_unique
    UNIQUE (network_identifier, transaction_reference)
);

-- The double-spend guard, and the reason this table exists at all.
--
-- At most one live transaction per account and sequence number. A replacement is legitimate and
-- deliberately reuses the number with a higher fee, so the original is marked 'replaced' in the same
-- database transaction that inserts its successor; a replacement written any other way is refused
-- here rather than discovered as two mined transfers.
CREATE UNIQUE INDEX chain_transactions_live_sequence
  ON chain_transactions (network_identifier, source_account, sequence_number)
  WHERE status <> 'replaced' AND status <> 'dropped';

CREATE INDEX chain_transactions_unresolved ON chain_transactions (network_identifier, status)
  WHERE status = 'submitted' OR status = 'confirming';

CREATE INDEX chain_transactions_by_settlement ON chain_transactions (settlement_id, submitted_at);

-- Where gas comes from, and how much of it is left.
--
-- The address is derived from the sealed seed, which only the settlement worker may open. Recording
-- it here is what lets the API and the dashboard tell an operator which account to fund without the
-- HTTP tier ever holding key material — the one place it must never be.
--
-- The balance is a reading, not a truth: it is whatever the settlement worker last observed, with the
-- time it observed it. An API that read the chain on request would turn an operator refreshing a page
-- into RPC load, and would still be showing a number from a moment ago.
CREATE TABLE treasury_accounts (
  network_identifier      network_identifier PRIMARY KEY,
  environment             environment_name NOT NULL,
  account                 TEXT NOT NULL CHECK (account = lower(account)),
  balance_in_native_units NUMERIC(78, 0) CHECK (balance_in_native_units >= 0),
  observed_at             TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sequence allocator.
--
-- Claiming a number takes a row lock, and the claim is reconciled against the chain's own count for
-- the account before it is used: a treasury that sent a transaction outside this system would
-- otherwise have every subsequent broadcast rejected as a duplicate, with no indication why.
CREATE TABLE chain_accounts (
  network_identifier   network_identifier NOT NULL,
  account              TEXT NOT NULL CHECK (account = lower(account)),
  next_sequence_number BIGINT NOT NULL DEFAULT 0 CHECK (next_sequence_number >= 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (network_identifier, account)
);
