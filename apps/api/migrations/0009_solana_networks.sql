-- The Solana networks, as enum values and nothing else.
--
-- Alone for the same reason 0007 was: PostgreSQL refuses to use a newly added enum value inside the
-- transaction that added it, and the migration runner wraps each file in one. The canonical form
-- functions that need to know about these networks are updated in the migration that follows.

ALTER TYPE network_identifier ADD VALUE IF NOT EXISTS 'solana-mainnet';
ALTER TYPE network_identifier ADD VALUE IF NOT EXISTS 'solana-devnet';
