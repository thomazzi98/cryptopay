-- The payment core: merchants, keys, payments, the addresses issued to them, the transfers observed
-- against them, the audit trail, and the scanning state that drives all of it.
--
-- Correctness lives in this file rather than in application code. Every rule below holds no matter
-- which code path writes, which worker races, or which bug ships: a constraint cannot be forgotten
-- the way a guard clause can.

CREATE TYPE environment_name AS ENUM ('test', 'live');

CREATE TYPE network_identifier AS ENUM ('polygon-amoy', 'polygon-mainnet', 'local-anvil');

CREATE TYPE payment_status AS ENUM (
  'pending', 'partially_funded', 'confirming',
  'completed', 'overpaid', 'underpaid', 'expired', 'canceled'
);

CREATE TYPE settlement_status AS ENUM (
  'not_applicable', 'sweep_scheduled', 'gas_funded', 'sweep_broadcast', 'swept', 'sweep_failed'
);

CREATE TYPE transfer_classification AS ENUM ('credited', 'late', 'unexpected', 'wrong_asset');

CREATE TYPE transfer_observation AS ENUM ('observed', 'finalized', 'orphaned');

CREATE TYPE idempotency_state AS ENUM ('in_progress', 'completed');

CREATE TABLE merchants (
  id                                  TEXT PRIMARY KEY,
  name                                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  underpayment_tolerance_basis_points SMALLINT NOT NULL DEFAULT 0
                                        CHECK (underpayment_tolerance_basis_points BETWEEN 0 AND 1000),
  overpayment_tolerance_basis_points  SMALLINT NOT NULL DEFAULT 0
                                        CHECK (overpayment_tolerance_basis_points BETWEEN 0 AND 1000),
  default_payment_lifetime_seconds    INTEGER NOT NULL DEFAULT 1800
                                        CHECK (default_payment_lifetime_seconds BETWEEN 60 AND 86400),
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The key identifier is the non-secret half, embedded in the presented key so lookup is indexed.
-- Only a digest of the secret half is stored, and it is compared in constant time.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  environment   environment_name NOT NULL,
  secret_digest BYTEA NOT NULL CHECK (octet_length(secret_digest) = 32),
  last_four     TEXT NOT NULL CHECK (length(last_four) = 4),
  label         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX api_keys_merchant_active_idx
  ON api_keys (merchant_id, environment) WHERE revoked_at IS NULL;

CREATE TABLE payments (
  id                        TEXT PRIMARY KEY,
  merchant_id               TEXT NOT NULL REFERENCES merchants (id),
  environment               environment_name NOT NULL,
  network_identifier        network_identifier NOT NULL,
  checkout_token            TEXT NOT NULL,
  asset_reference           TEXT NOT NULL,
  asset_symbol              TEXT NOT NULL,
  asset_decimals            SMALLINT NOT NULL CHECK (asset_decimals BETWEEN 0 AND 36),
  requested_amount          NUMERIC(78, 0) NOT NULL CHECK (requested_amount > 0),
  minimum_acceptable_amount NUMERIC(78, 0) NOT NULL,
  maximum_acceptable_amount NUMERIC(78, 0) NOT NULL,
  credited_amount           NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (credited_amount >= 0),
  receiving_account         TEXT NOT NULL,
  status                    payment_status NOT NULL DEFAULT 'pending',
  status_version            INTEGER NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  settlement_status         settlement_status NOT NULL DEFAULT 'not_applicable',
  required_confirmations    SMALLINT NOT NULL CHECK (required_confirmations >= 0),
  requires_finality_tag     BOOLEAN NOT NULL,
  confirmations_observed    INTEGER NOT NULL DEFAULT 0 CHECK (confirmations_observed >= 0),
  finality_confirmed        BOOLEAN NOT NULL DEFAULT false,
  settling_block_height     BIGINT CHECK (settling_block_height >= 0),
  created_at_block_height   BIGINT NOT NULL CHECK (created_at_block_height >= 0),
  merchant_reference        TEXT CHECK (merchant_reference IS NULL OR length(merchant_reference) <= 255),
  metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  callback_url              TEXT CHECK (callback_url IS NULL OR length(callback_url) <= 2048),
  expires_at                TIMESTAMPTZ NOT NULL,
  first_credited_at         TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payments_band_ordered CHECK (
    minimum_acceptable_amount <= requested_amount
    AND requested_amount <= maximum_acceptable_amount
  ),

  -- The load-bearing property of environment separation. A test-mode key is physically incapable of
  -- producing a mainnet row, and no application bug can make one.
  CONSTRAINT payments_environment_network_consistent CHECK (
    (environment = 'live' AND network_identifier = 'polygon-mainnet')
    OR (environment = 'test' AND network_identifier IN ('polygon-amoy', 'local-anvil'))
  ),

  CONSTRAINT payments_completed_has_timestamp
    CHECK (status <> 'completed' OR completed_at IS NOT NULL),

  -- Addresses are compared as text everywhere, so they must be stored in one casing.
  CONSTRAINT payments_account_lowercase CHECK (receiving_account = lower(receiving_account)),
  CONSTRAINT payments_asset_lowercase CHECK (asset_reference = lower(asset_reference))
);

CREATE UNIQUE INDEX payments_checkout_token_unique ON payments (checkout_token);
CREATE UNIQUE INDEX payments_receiving_account_unique
  ON payments (network_identifier, receiving_account);
CREATE UNIQUE INDEX payments_merchant_reference_unique
  ON payments (merchant_id, environment, merchant_reference) WHERE merchant_reference IS NOT NULL;

CREATE INDEX payments_watched_idx ON payments (network_identifier, receiving_account)
  WHERE status IN ('pending', 'partially_funded', 'confirming');
CREATE INDEX payments_expiry_idx ON payments (expires_at)
  WHERE status IN ('pending', 'partially_funded');
CREATE INDEX payments_confirming_idx ON payments (network_identifier, settling_block_height)
  WHERE status = 'confirming';
CREATE INDEX payments_listing_idx ON payments (merchant_id, environment, created_at DESC);

-- The only table holding derivation material. allocation_reference is never reachable from any
-- response type, and no API contract declares a field it could travel in.
CREATE TABLE payment_addresses (
  id                   TEXT PRIMARY KEY,
  payment_id           TEXT NOT NULL UNIQUE REFERENCES payments (id) ON DELETE CASCADE,
  environment          environment_name NOT NULL,
  network_identifier   network_identifier NOT NULL,
  account              TEXT NOT NULL CHECK (account = lower(account)),
  derivation_index     INTEGER NOT NULL
                         CHECK (derivation_index >= 0 AND derivation_index < 2147483648),
  allocation_reference TEXT NOT NULL,
  allocated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_addresses_index_unique UNIQUE (environment, derivation_index),
  CONSTRAINT payment_addresses_account_unique UNIQUE (network_identifier, account)
);

-- Gaps in a hierarchical-deterministic index are harmless, so a sequence is correct here and a
-- counter row would serialise every payment creation on the network to solve a non-problem.
CREATE SEQUENCE payment_address_index_test AS INTEGER START 0 MINVALUE 0;
CREATE SEQUENCE payment_address_index_live AS INTEGER START 0 MINVALUE 0;

-- The single most important constraint in the schema is on this table. The same on-chain event
-- cannot be credited twice: not by a duplicate scan, not by an overlapping range, not by a reindex
-- from genesis, not by two workers racing. Every insert is ON CONFLICT DO NOTHING, which is what
-- turns at-least-once scanning into exactly-once crediting.
CREATE TABLE payment_transfers (
  id                    TEXT PRIMARY KEY,
  payment_id            TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  network_identifier    network_identifier NOT NULL,
  transaction_reference TEXT NOT NULL CHECK (transaction_reference = lower(transaction_reference)),
  event_index           INTEGER NOT NULL CHECK (event_index >= 0),
  block_height          BIGINT NOT NULL CHECK (block_height >= 0),
  block_reference       TEXT NOT NULL CHECK (block_reference = lower(block_reference)),
  source_account        TEXT NOT NULL CHECK (source_account = lower(source_account)),
  asset_reference       TEXT NOT NULL CHECK (asset_reference = lower(asset_reference)),
  amount                NUMERIC(78, 0) NOT NULL CHECK (amount > 0),
  classification        transfer_classification NOT NULL,
  observation           transfer_observation NOT NULL DEFAULT 'observed',
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at          TIMESTAMPTZ,
  orphaned_at           TIMESTAMPTZ,

  CONSTRAINT payment_transfers_chain_identity_unique
    UNIQUE (network_identifier, transaction_reference, event_index),
  CONSTRAINT payment_transfers_orphaned_consistent
    CHECK ((observation = 'orphaned') = (orphaned_at IS NOT NULL))
);

CREATE INDEX payment_transfers_payment_idx
  ON payment_transfers (payment_id) WHERE orphaned_at IS NULL;
CREATE INDEX payment_transfers_unfinalized_idx
  ON payment_transfers (network_identifier, block_height) WHERE observation = 'observed';

-- Append-only audit, one row per applied command including same-status version bumps. The unique
-- constraint on (payment_id, to_version) is what catches a bypassed compare-and-swap: two writers
-- at the same version cannot both record, so the whole transaction rolls back.
CREATE TABLE payment_status_transitions (
  id                     BIGSERIAL PRIMARY KEY,
  payment_id             TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  from_status            payment_status NOT NULL,
  to_status              payment_status NOT NULL,
  from_version           INTEGER NOT NULL CHECK (from_version >= 0),
  to_version             INTEGER NOT NULL CHECK (to_version >= 0),
  command                TEXT NOT NULL,
  caused_by              TEXT,
  credited_amount        NUMERIC(78, 0) NOT NULL,
  confirmations          INTEGER,
  tip_block_height       BIGINT,
  finalized_block_height BIGINT,
  correlation_id         TEXT,
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_status_transitions_version_unique UNIQUE (payment_id, to_version),
  CONSTRAINT payment_status_transitions_version_advances CHECK (to_version > from_version)
);

CREATE INDEX payment_status_transitions_payment_idx
  ON payment_status_transitions (payment_id, to_version);

CREATE TABLE payment_evaluation_queue (
  payment_id   TEXT PRIMARY KEY REFERENCES payments (id) ON DELETE CASCADE,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_until TIMESTAMPTZ
);

CREATE INDEX payment_evaluation_queue_claimable_idx
  ON payment_evaluation_queue (enqueued_at, payment_id);

-- The cursor advances only inside the transaction that writes the data it covers, so a crash
-- replays the identical window and the unique constraints make the replay a no-op.
CREATE TABLE block_cursors (
  network_identifier                   network_identifier PRIMARY KEY,
  last_scanned_height                  BIGINT NOT NULL CHECK (last_scanned_height >= 0),
  last_scanned_reference               TEXT NOT NULL,
  finalized_height                     BIGINT CHECK (finalized_height >= 0),
  finalized_advanced_at                TIMESTAMPTZ,
  current_scan_range                   INTEGER NOT NULL CHECK (current_scan_range > 0),
  consecutive_successes                INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
  measured_block_interval_milliseconds INTEGER CHECK (measured_block_interval_milliseconds > 0),
  halted_at                            TIMESTAMPTZ,
  halted_reason                        TEXT,
  fencing_token                        BIGINT NOT NULL DEFAULT 0,
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT block_cursors_halt_has_reason
    CHECK ((halted_at IS NULL) = (halted_reason IS NULL))
);

-- The header ring that makes fork resolution correct. Walking payment rows instead cannot locate a
-- fork in a window containing no transfers, which is the common case, so a routine one-block reorg
-- would exhaust the depth limit and halt the network.
CREATE TABLE observed_blocks (
  network_identifier network_identifier NOT NULL,
  block_height       BIGINT NOT NULL CHECK (block_height >= 0),
  block_reference    TEXT NOT NULL CHECK (block_reference = lower(block_reference)),
  parent_reference   TEXT NOT NULL CHECK (parent_reference = lower(parent_reference)),
  observed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (network_identifier, block_height)
);

-- Separate seeds per environment, not separate account indices. The additional authenticated data
-- binds each envelope to its environment, so a test row copied into the live slot fails to decrypt
-- rather than silently signing mainnet transactions with a testnet seed.
CREATE TABLE wallet_seeds (
  id                 TEXT PRIMARY KEY,
  environment        environment_name NOT NULL,
  scheme             TEXT NOT NULL,
  key_identifier     TEXT NOT NULL,
  wrapped_data_key   BYTEA NOT NULL,
  nonce              BYTEA NOT NULL,
  ciphertext         BYTEA NOT NULL,
  authentication_tag BYTEA NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_seeds_environment_unique UNIQUE (environment)
);

CREATE TABLE idempotency_keys (
  merchant_id         TEXT NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  idempotency_key     TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_method      TEXT NOT NULL,
  request_path        TEXT NOT NULL,
  request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  state               idempotency_state NOT NULL,
  lock_expires_at     TIMESTAMPTZ NOT NULL,
  response_status     SMALLINT CHECK (response_status BETWEEN 100 AND 599),
  response_body       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (merchant_id, idempotency_key),
  CONSTRAINT idempotency_completed_has_response
    CHECK (state <> 'completed' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Leased leadership with a monotonic fencing token. A session advisory lock has no failover when a
-- process hangs but stays connected: scanning stops silently while readiness stays green.
CREATE TABLE leader_leases (
  lease_name      TEXT PRIMARY KEY,
  holder_identity TEXT NOT NULL,
  fencing_token   BIGINT NOT NULL CHECK (fencing_token > 0),
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
