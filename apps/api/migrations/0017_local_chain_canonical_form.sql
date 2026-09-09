-- Teach the canonical form functions about the two local chains.
--
-- Every change here is a widening: the branches for existing networks are untouched and the new
-- branches admit rows that could not previously exist at all, so replacing the functions is safe
-- without a validation pass. Migration 0015 records the asymmetry that makes that true.
--
-- A local chain writes addresses and references exactly as the network it stands in for, because it
-- is that network's own software. Anything else would make the local suites prove nothing.

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
    WHEN 'tron-local'      THEN 'tron-base58check'
    WHEN 'solana-mainnet'  THEN 'solana-base58'
    WHEN 'solana-devnet'   THEN 'solana-base58'
    WHEN 'solana-local'    THEN 'solana-base58'
  END
$$;

CREATE OR REPLACE FUNCTION is_canonical_reference(network network_identifier, value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE network
    WHEN 'tron-mainnet'   THEN value ~ '^[0-9a-f]{64}$'
    WHEN 'tron-nile'      THEN value ~ '^[0-9a-f]{64}$'
    WHEN 'tron-local'     THEN value ~ '^[0-9a-f]{64}$'
    WHEN 'solana-mainnet' THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,90}$'
    WHEN 'solana-devnet'  THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,90}$'
    WHEN 'solana-local'   THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,90}$'
    ELSE value ~ '^0x[0-9a-f]{64}$'
  END
$$;

-- `network_environment` already answers 'test' for everything that is not explicitly live, so both
-- local chains are covered by its ELSE branch and it does not need replacing.
