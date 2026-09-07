-- Database roles, one per process, granted only what that process needs.
--
-- This is the containment the architecture claims and it has to be real. The callback worker is the
-- only part of the system that makes outbound requests to addresses a stranger chose, so it is the
-- most likely thing in the deployment to be compromised. If it holds the same credentials as the
-- API, then compromising it means reading every merchant's payments and every API key digest.
--
-- It cannot. The grants below give it the outbox and the signing secrets and nothing else, and an
-- integration test asserts that a SELECT on payments from that role is refused.

\set ON_ERROR_STOP on

-- The API: full use of the payment tables, because it creates and reads them.
CREATE ROLE cryptopay_api LOGIN PASSWORD 'cryptopay_api_local';
GRANT CONNECT ON DATABASE cryptopay TO cryptopay_api;
GRANT USAGE ON SCHEMA public TO cryptopay_api;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO cryptopay_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cryptopay_api;

-- The chain worker: it writes what it observed and moves the cursor. It never issues an API key and
-- never touches a merchant row.
CREATE ROLE cryptopay_chain_worker LOGIN PASSWORD 'cryptopay_chain_local';
GRANT CONNECT ON DATABASE cryptopay TO cryptopay_chain_worker;
GRANT USAGE ON SCHEMA public TO cryptopay_chain_worker;
GRANT SELECT, INSERT, UPDATE ON
  payments, payment_transfers, payment_status_transitions, payment_evaluation_queue,
  block_cursors, observed_blocks, leader_leases, webhook_deliveries
  TO cryptopay_chain_worker;
GRANT SELECT ON merchants, payment_addresses TO cryptopay_chain_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cryptopay_chain_worker;

-- The callback worker: the outbox and the signing secrets. Nothing else exists as far as it is
-- concerned, and the payload it needs is already inside the delivery row.
CREATE ROLE cryptopay_callback_worker LOGIN PASSWORD 'cryptopay_callback_local';
GRANT CONNECT ON DATABASE cryptopay TO cryptopay_callback_worker;
GRANT USAGE ON SCHEMA public TO cryptopay_callback_worker;
GRANT SELECT, UPDATE ON webhook_deliveries TO cryptopay_callback_worker;
GRANT SELECT, INSERT ON webhook_delivery_attempts TO cryptopay_callback_worker;
GRANT SELECT ON webhook_secrets TO cryptopay_callback_worker;
GRANT USAGE, SELECT ON SEQUENCE webhook_delivery_attempts_id_seq TO cryptopay_callback_worker;

-- Said explicitly rather than left to the absence of a grant, so that a future default-privilege
-- change cannot quietly hand the callback worker the payments table.
REVOKE ALL ON payments, api_keys, wallet_seeds, payment_addresses FROM cryptopay_callback_worker;
REVOKE ALL ON wallet_seeds, api_keys FROM cryptopay_chain_worker;
