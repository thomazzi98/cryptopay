-- An append-oriented record of who did what.
--
-- Distinct from payment_status_transitions, which records what the system concluded about a payment
-- from what it saw on a chain. This records what a person or an integration asked for: which key
-- created a payment, which key cancelled one, which key was used at all. When a payment turns out to
-- have been created by mistake, the transition history says what happened to it and says nothing at
-- all about who started it.
--
-- Deliberately without a foreign key to payments. An audit row outliving the thing it describes is
-- the point of an audit trail, and a cascade would delete exactly the records an investigation
-- needs. The subject is stored as a type and an identifier so a row can describe something that has
-- since been removed, or something that is not a payment at all.
--
-- Never carries a secret. The detail column holds request-shaped facts, and a test asserts no
-- credential-shaped value reaches it.

CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  merchant_id   TEXT REFERENCES merchants (id) ON DELETE SET NULL,
  api_key_id    TEXT,
  action        TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  subject_type  TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 32),
  subject_id    TEXT CHECK (subject_id IS NULL OR length(subject_id) <= 128),
  request_id    TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- What an investigation actually asks: everything this merchant did, newest first.
CREATE INDEX audit_log_merchant_idx ON audit_log (merchant_id, occurred_at DESC);
-- And the other direction: everything that touched this payment.
CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id, occurred_at DESC);
