-- Teach the canonical form functions about Solana.
--
-- Solana writes both accounts and transaction signatures in base58, and both are case sensitive. A
-- signature is longer than an address, which is why the reference form is a separate predicate
-- rather than the address form applied twice.
--
-- Replacing a function that CHECK constraints already call is safe here because every change is a
-- widening: the branches for the existing networks are untouched, and the new branches admit rows
-- that could not previously exist at all. PostgreSQL does not revalidate a constraint when its
-- function is replaced, so a narrowing would have needed a new constraint and a validation pass.

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
    WHEN 'tron-mainnet'    THEN 'base58-exact'
    WHEN 'tron-nile'       THEN 'base58-exact'
    WHEN 'solana-mainnet'  THEN 'base58-exact'
    WHEN 'solana-devnet'   THEN 'base58-exact'
  END
$$;

CREATE OR REPLACE FUNCTION network_environment(network network_identifier)
RETURNS environment_name
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network
    WHEN 'polygon-mainnet' THEN 'live'
    WHEN 'tron-mainnet'    THEN 'live'
    WHEN 'solana-mainnet'  THEN 'live'
    ELSE 'test'
  END::environment_name
$$;

-- A signature is sixty-four bytes in base58, which lands between eighty-six and eighty-eight
-- characters. A block is identified by its blockhash, which is thirty-two bytes and lands between
-- thirty-two and forty-four, so the range spans both.
CREATE OR REPLACE FUNCTION is_canonical_reference(network network_identifier, value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network
    WHEN 'tron-mainnet'   THEN value ~ '^[0-9a-f]{64}$'
    WHEN 'tron-nile'      THEN value ~ '^[0-9a-f]{64}$'
    WHEN 'solana-mainnet' THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,90}$'
    WHEN 'solana-devnet'  THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,90}$'
    ELSE value ~ '^0x[0-9a-f]{64}$'
  END
$$;
