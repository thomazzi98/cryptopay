-- Accounts are canonical for their own network, not lowercase for every network.
--
-- The rule this replaces was `column = lower(column)`, applied to nine columns. It was always an EVM
-- rule wearing a universal one's clothes. Base58 encodes information in case: TXLAQ63Xg1... and
-- txlaq63xg1... are not two spellings of one TRON account, the second is not an account at all, and
-- money sent to it is unrecoverable by anybody. The same is true of every Solana address and
-- signature. Storing either under the old rule was impossible, and storing a lowercased copy would
-- have been worse than impossible.
--
-- The replacement is stronger for EVM rather than weaker. `= lower(col)` accepted `hello`, `0x`, and
-- a forty character string of the wrong shape, because all of them equal their own lowercase form.
-- The function asserts the shape as well: 0x followed by exactly forty lowercase hex digits. Rows
-- that would have passed before and are not addresses now fail.
--
-- Two things follow from CHECK constraints calling a function. Widening a form later is safe, since
-- PostgreSQL does not revalidate a constraint when its function is replaced and every existing row
-- already satisfied the narrower rule. Narrowing one is not, and needs a new constraint with a
-- validation pass. That asymmetry is the reason the functions are written to be extended by adding
-- a family rather than by editing an existing branch.

-- ---------------------------------------------------------------------------------------------
-- The forms themselves.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION network_address_form(network network_identifier)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network
    WHEN 'polygon-mainnet' THEN 'evm-lowercase-hex'
    WHEN 'polygon-amoy'    THEN 'evm-lowercase-hex'
    WHEN 'local-anvil'     THEN 'evm-lowercase-hex'
    WHEN 'tron-mainnet'    THEN 'base58-exact'
    WHEN 'tron-nile'       THEN 'base58-exact'
  END
$$;

-- Which environment a network belongs to, so the separation is stated once instead of enumerated
-- inside a constraint that has to be rewritten every time a network is added.
CREATE FUNCTION network_environment(network network_identifier)
RETURNS environment_name
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network
    WHEN 'polygon-mainnet' THEN 'live'
    WHEN 'tron-mainnet'    THEN 'live'
    ELSE 'test'
  END::environment_name
$$;

-- Base58 has no 0, O, I or l. That is why a lowercased base58 address is not merely a different
-- string but an invalid one, and why this predicate rejects it rather than accepting a value nobody
-- holds a key for.
CREATE FUNCTION is_canonical_account(network network_identifier, value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network_address_form(network)
    WHEN 'evm-lowercase-hex' THEN value ~ '^0x[0-9a-f]{40}$'
    WHEN 'base58-exact'      THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    ELSE FALSE
  END
$$;

-- An asset is an account, or the sentinel a native currency carries because it has no contract.
CREATE FUNCTION is_canonical_asset(network network_identifier, value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value = 'native' OR is_canonical_account(network, value)
$$;

-- How a transaction or a block is named, which is a third form rather than the address form: TRON
-- writes addresses in base58 and transaction ids in bare lowercase hex, so one network needs both.
CREATE FUNCTION is_canonical_reference(network network_identifier, value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network
    WHEN 'tron-mainnet' THEN value ~ '^[0-9a-f]{64}$'
    WHEN 'tron-nile'    THEN value ~ '^[0-9a-f]{64}$'
    ELSE value ~ '^0x[0-9a-f]{64}$'
  END
$$;

-- ---------------------------------------------------------------------------------------------
-- Replacing the lowercase constraints on the payment core.
--
-- Dropped by looking them up rather than by name, because seven of the nine were written as column
-- CHECKs and carry names PostgreSQL generated. Naming a guess would silently drop nothing.
-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT conrelid::regclass AS table_name, conname
      FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid IN ('payments'::regclass, 'payment_addresses'::regclass,
                        'payment_transfers'::regclass, 'observed_blocks'::regclass)
       AND pg_get_constraintdef(oid) LIKE '%lower(%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', target.table_name, target.conname);
  END LOOP;
END
$$;

ALTER TABLE payments
  ADD CONSTRAINT payments_account_canonical
    CHECK (is_canonical_account(network_identifier, receiving_account)),
  ADD CONSTRAINT payments_asset_canonical
    CHECK (is_canonical_asset(network_identifier, asset_reference));

ALTER TABLE payment_addresses
  ADD CONSTRAINT payment_addresses_account_canonical
    CHECK (is_canonical_account(network_identifier, account));

ALTER TABLE payment_transfers
  ADD CONSTRAINT payment_transfers_transaction_canonical
    CHECK (is_canonical_reference(network_identifier, transaction_reference)),
  ADD CONSTRAINT payment_transfers_block_canonical
    CHECK (is_canonical_reference(network_identifier, block_reference)),
  ADD CONSTRAINT payment_transfers_source_canonical
    CHECK (is_canonical_account(network_identifier, source_account)),
  ADD CONSTRAINT payment_transfers_asset_canonical
    CHECK (is_canonical_asset(network_identifier, asset_reference));

ALTER TABLE observed_blocks
  ADD CONSTRAINT observed_blocks_block_canonical
    CHECK (is_canonical_reference(network_identifier, block_reference)),
  ADD CONSTRAINT observed_blocks_parent_canonical
    CHECK (is_canonical_reference(network_identifier, parent_reference));

-- ---------------------------------------------------------------------------------------------
-- Environment separation, stated once.
--
-- The constraint being replaced enumerated the networks each environment may use, so every new
-- network had to be added to it or become unusable in a way that looked like a bug elsewhere. The
-- property it protects is unchanged and remains the load-bearing one: a test-mode key is physically
-- incapable of producing a live row.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE payments DROP CONSTRAINT payments_environment_network_consistent;
ALTER TABLE payments
  ADD CONSTRAINT payments_environment_network_consistent
    CHECK (environment = network_environment(network_identifier));
