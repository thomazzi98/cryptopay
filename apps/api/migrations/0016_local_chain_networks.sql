-- Local TRON and Solana chains, as enum values and nothing else.
--
-- `local-anvil` has existed since the first migration for the EVM family, so that a development
-- chain redeploying its token on every start has somewhere to put it that is not a real network.
-- TRON and Solana need the same thing for the same reason, and without it a token payment on either
-- family cannot be driven through the payment lifecycle at all: the asset allowlist is frozen per
-- network and correctly refuses a contract deployed at runtime.
--
-- Alone in this file for the reason 0007 and 0009 record: PostgreSQL refuses to use a newly added
-- enum value inside the transaction that added it, and the migration runner wraps each file in one.

ALTER TYPE network_identifier ADD VALUE IF NOT EXISTS 'tron-local';
ALTER TYPE network_identifier ADD VALUE IF NOT EXISTS 'solana-local';
