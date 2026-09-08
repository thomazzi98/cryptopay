-- What an API key is allowed to do, not merely which merchant it belongs to.
--
-- Until now every key could do everything its merchant could. That is the wrong default for a key a
-- merchant pastes into a reporting dashboard, a monitoring probe or a partner integration: reading
-- payments and creating them are different powers, and only one of them moves money.
--
-- Existing keys are granted both scopes, because they were issued under a contract that promised
-- exactly that and silently narrowing them would break every live integration. The default for a
-- new key is the same today; making it narrower is a decision about key issuance, and issuance is
-- not part of this change.
--
-- The CHECK is what makes the set closed. Without it a typo becomes a scope that grants nothing and
-- fails at the guard rather than at the write, and a scope nobody recognises is indistinguishable
-- from one that was revoked.

ALTER TABLE api_keys
  ADD COLUMN scopes TEXT[] NOT NULL DEFAULT ARRAY['payments:read', 'payments:write'];

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_scopes_known
    CHECK (scopes <@ ARRAY['payments:read', 'payments:write']),
  ADD CONSTRAINT api_keys_scopes_present
    CHECK (cardinality(scopes) > 0);
