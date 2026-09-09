-- TRON and Solana are not one address form, and treating them as one accepts the worst mistake.
--
-- Both write addresses in base58 in the same length range, so the shared rule
-- `^[1-9A-HJ-NP-Za-km-z]{32,44}$` accepted a TRON address wherever a Solana one belonged and the
-- reverse. Neither chain would ever deliver such a payment, and no key exists for the string that
-- was stored, so the money is unrecoverable by anybody. The two shapes are distinguishable: a TRON
-- address is a twenty-five byte base58check payload, always thirty-four characters beginning with
-- `T`; a Solana address is a thirty-two byte ed25519 public key with no prefix at all.
--
-- This narrows the TRON rule, and migration 0008 recorded why that cannot be done by replacing the
-- function alone: PostgreSQL does not revalidate a CHECK when the function it calls is replaced, so
-- an existing row that violates the narrower rule would survive and never be noticed. Every
-- constraint that reaches this predicate is therefore dropped and re-added, which validates the
-- whole table.
--
-- The Solana rule is left as a length-bounded base58 match, because separating a thirty-two byte
-- payload from a twenty-five byte one requires decoding base58, and a decoder written in SQL to
-- guard rows this system generates itself would be more risk than the check removes. The
-- application asserts the byte length where it can decode; docs/security-address-derivation.md
-- records the residual gap.

CREATE OR REPLACE FUNCTION network_address_form(network network_identifier)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network
    WHEN 'polygon-mainnet' THEN 'evm-lowercase-hex'
    WHEN 'polygon-amoy'    THEN 'evm-lowercase-hex'
    WHEN 'local-anvil'     THEN 'evm-lowercase-hex'
    WHEN 'tron-mainnet'    THEN 'tron-base58check'
    WHEN 'tron-nile'       THEN 'tron-base58check'
    WHEN 'solana-mainnet'  THEN 'solana-base58'
    WHEN 'solana-devnet'   THEN 'solana-base58'
  END
$$;

CREATE OR REPLACE FUNCTION is_canonical_account(network network_identifier, value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network_address_form(network)
    WHEN 'evm-lowercase-hex' THEN value ~ '^0x[0-9a-f]{40}$'
    WHEN 'tron-base58check'  THEN value ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'
    WHEN 'solana-base58'     THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    ELSE FALSE
  END
$$;

-- Re-adding each constraint is what forces the validation pass over the existing rows.
ALTER TABLE payments
  DROP CONSTRAINT payments_account_canonical,
  DROP CONSTRAINT payments_asset_canonical,
  ADD CONSTRAINT payments_account_canonical
    CHECK (is_canonical_account(network_identifier, receiving_account)),
  ADD CONSTRAINT payments_asset_canonical
    CHECK (is_canonical_asset(network_identifier, asset_reference));

ALTER TABLE payment_addresses
  DROP CONSTRAINT payment_addresses_account_canonical,
  ADD CONSTRAINT payment_addresses_account_canonical
    CHECK (is_canonical_account(network_identifier, account));

ALTER TABLE payment_transfers
  DROP CONSTRAINT payment_transfers_source_canonical,
  DROP CONSTRAINT payment_transfers_asset_canonical,
  ADD CONSTRAINT payment_transfers_source_canonical
    CHECK (is_canonical_account(network_identifier, source_account)),
  ADD CONSTRAINT payment_transfers_asset_canonical
    CHECK (is_canonical_asset(network_identifier, asset_reference));
