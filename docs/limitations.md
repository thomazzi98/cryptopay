# Limitations

**This is a correct, honest, production-_quality_ reference implementation. It is not a production
_deployment_, and it has not been operated with real money at scale.** The distinction matters, so
this page comes before the architecture: everything below is a real exposure or a real gap, written
plainly, and none of it is hedged.

If you are evaluating whether to put money through this, read this page first and stop when
something on it is unacceptable to you.

---

## 1. Key encryption keys are environment variables on the host

This is the largest genuine exposure in the design.

Each environment's master seed is sealed with a data key, and that data key is wrapped by a key
encryption key held in `WALLET_KEY_ENCRYPTION_KEY`. That variable lives in the process environment.
Anyone who can read the environment of the API or the chain worker — a shell on the host, a memory
dump, a debug endpoint, a compromised dependency with filesystem access — can unwrap every unswept
deposit key at once.

The mitigations that exist are real but partial: seeds are per environment with AAD binding, so a
`test` envelope cannot be opened in the `live` slot; the account extended public key is never
exposed; and the key wrapping is dispatched from a `scheme` column in the database, so a KMS-backed
wrapper is one entry in a registry away.

That KMS adapter is deliberately **not** shipped. An adapter nobody runs is dead code, and this
repository forbids dead code. Adding it is a small change; operating it is the part that matters and
that this repository does not do.

## 2. Derivation is non-hardened on the secp256k1 families, and Solana pays a different price

Payment addresses on Polygon and TRON come from `m/44'/{coin}'/0'/0/{index}`. The account level is
hardened; the address level is not, because allocation has to be possible from an extended public key
alone so that the process which creates payments structurally cannot sign anything.

The consequence is standard for this construction and worth stating: **the account extended public
key plus any single leaked child private key together yield every private key in that branch.**

Mitigated by never exposing the extended public key, by per-environment seeds, by deriving a key
only at the moment it is used and zeroing it afterwards, and by sweeping on finality so the balance
sitting under those keys is small and short-lived. Not eliminated.

Solana is the other way round and could not have been arranged differently. SLIP-0010 defines
ed25519 derivation as hardened-only, so there is no extended public key and **the master seed must be
opened to issue a Solana address**. It is opened per allocation and zeroed immediately rather than
cached, so the exposure is a few milliseconds per payment created rather than the life of the
process, but the payment creation path does touch seed material on that one family and does not on
the other two. In exchange, a leaked Solana child key exposes only its own address.

`docs/security-address-derivation.md` reviews both in full, including what is deliberately not
protected.

## 3. Finality is asserted by providers we do not control

A payment completes when the confirmation count is satisfied **and** the chain's `finalized` tag
covers the settling block, seconded by a second, independently operated endpoint.

That quorum defeats one lagging or dishonest provider. It does **not** defeat a correlated failure,
and the free public endpoints this ships with may well share upstream infrastructure without saying
so. If both endpoints are wrong in the same direction at the same moment, a payment can complete on
a block that is later reorganised away.

The system's answer to a stalled finality view is to alert and hold rather than fall back to a count,
because a count cannot detect a milestone stall — blocks keep arriving while nothing finalizes. That
is the right behaviour and it is tested, but it converts the failure into an outage rather than
removing it.

## 4. There is a real custody window

Between the moment a customer's transfer is credited and the moment it is swept, the funds sit under
a key this system holds. That window is minutes, not days, but it is real, and during it the
exposures in sections 1 and 2 apply to actual money.

## 5. A short currency list, matched by contract address

Token identity is the contract address from a frozen allowlist, never the symbol. Bridged USDC.e
returns the byte-identical `symbol()` string `"USDC"`, so a symbol comparison anywhere in the credit
path would credit the wrong asset; a test asserts a USDC.e transfer to a watched address is not
credited.

The cost of that strictness is scope. Fee-on-transfer tokens and rebasing tokens are unsupported and
would be credited incorrectly if forced through. The registry carries USDC and USDT on Polygon, USDT
on TRON, USDC on Solana, and each chain's own currency; anything else is refused at the edge of the
API rather than credited wrongly.

Native currency is supported on all three families and is a different detection problem rather than
a different asset. A plain value transfer emits no log, so it is found by reading block bodies on
Polygon, `TransferContract` entries on TRON and lamport deltas on Solana. On Polygon that has one
honest hole: a native transfer made **by a contract** appears in no block body and is not detected,
because the trace APIs that would show it are not served by the public endpoints this runs against.
Reconciliation compares the destination balance against the credited total, which is what notices
one.

## 6. Sweep throughput is serialized

One in-flight settlement per network, enforced by a nonce uniqueness constraint. That is what makes
a double spend impossible under a crash at broadcast, and it is also a hard throughput ceiling. A
merchant taking hundreds of payments a minute would queue behind it.

## 7. A private key is not confined to the chain its variable is named after

Discovered in this repository rather than anticipated, and recorded here because it is the kind of
mistake that reads as obviously fine.

The testnet validation key was configured as `AMOY_TESTNET_PRIVATE_KEY`. One secp256k1 key controls
the same address on **every** EVM chain simultaneously, so the name confined nothing: the key
configured here held real POL on Polygon mainnet and had already signed six transactions there. No
secret scanner could have caught it — a key in a gitignored `.env` is exactly where a key belongs,
and no pattern distinguishes a throwaway from a funded wallet.

`npm run check:testnet-key` now asks the chains instead: it derives the address locally, queries four
mainnets, and refuses a key with any balance or nonce. It cannot help anyone who does not run it.

## 8. What is not implemented

- **Refund of a sweep that fails permanently.** Settlement sweeps funds to a payout destination and
  retries what fails, but a settlement that has exhausted its attempts stays `failed` and waits for
  a person. There is no automated path that returns the money or picks a different destination.
- **Refunds.** There is no path to return money to a customer who overpaid or paid late. Both states
  are detected, recorded and surfaced; resolving them is manual.
- **Multiple merchants per key, teams, roles, or an accounts system.** The dashboard authenticates
  with an API key because that is what a merchant's server does. There is no user table.
- **Mainnet validation.** No automated test touches mainnet, deliberately. Mainnet is validated once,
  manually, by a human following a runbook.
- **Sending on TRON or Solana.** Both chains are watched and neither is signed on. There is no TRON
  or Solana signing code anywhere in this repository, which is why both declare
  `supportsSettlement: false` and why a custodial destination cannot be offered on either: money
  arriving at an address this system cannot spend from would be stranded.

## 9. What the tests do and do not prove

The integration suite runs against a real PostgreSQL 18 and a real Anvil chain, and the reorg suite
rewrites chain history with a snapshot and a revert rather than stubbing a provider. Those results
are evidence.

The gateway contract at `/api/v1` has been driven end to end by the
[payment gateway](https://github.com/thomazzi98/mini-payment-gateway) against this deployment
running beside a local chain: a payment created through the contract, paid on Anvil, detected and
confirmed by the chain worker, and delivered as a signed webhook that the gateway verified. That is
evidence about the contract and the callback path; it was produced with
`PREFER_LOCAL_DEVELOPMENT_NETWORKS=true`, and no payment has been sent through that contract on a
public network.

They are evidence about **this** code under **these** conditions. They say nothing about behaviour
under sustained production load, against a rate-limited provider, during a multi-hour network
partition, or with a database that has been running for a year. Nothing here has run for a year.

## 10. What each claim on this page rests on

The three families are not equally proven, and the difference matters more than the feature list.
Three levels of evidence are used throughout this page and they are not interchangeable.

- **Verified** means an automated test in this repository asserts it against real software: a real
  PostgreSQL 18, a real node of the chain in question, transactions this suite built, signed and
  broadcast itself. It proves transaction encoding, signature verification, contract execution,
  block production and detection. It proves nothing about peers, forks, propagation, or how a public
  endpoint behaves under rate limiting, because a single node on one machine has none of those.
- **Publicly verified** means it was exercised against the real public network, and the evidence is
  something anyone can look up: a transaction on a public explorer, or history read back from an
  endpoint that serves the world.
- **Not externally verified** means it is true of this code as written and reviewed, with no test and
  no public evidence standing behind it. Everything in section 11 is at this level by definition.

|                                               | Polygon                   | TRON                   | Solana                 |
| --------------------------------------------- | ------------------------- | ---------------------- | ---------------------- |
| Destination derived and accepted by the chain | verified                  | verified               | verified               |
| Payment URI and QR                            | verified, decoded back    | verified, decoded back | verified, decoded back |
| Native payment sent, detected, completed      | verified                  | verified               | verified               |
| Token payment sent, detected, completed       | verified                  | verified               | verified               |
| Webhook published on completion               | verified                  | verified               | verified               |
| Reconciliation finding a missed payment       | verified                  | verified               | verified               |
| Reading real network history                  | publicly verified         | publicly verified      | publicly verified      |
| A payment sent on the public testnet          | publicly verified on Amoy | **not verified**       | **not verified**       |
| A transaction broadcast on mainnet            | publicly verified, once   | never attempted        | never attempted        |

**What the local chains are.** TRON is `tronbox/tre`, a single-witness java-tron whose genesis
pre-funds a known account. Solana is `anzaxyz/agave` running `agave-test-validator` with the SPL
Token and associated-token-account programs loaded at genesis. Polygon is `anvil`. All three answer
on the same HTTP and JSON-RPC surfaces the adapters use in production, and every suite broadcasts
real signed transactions rather than replaying fixtures. A TRON block is produced only when there is
a transaction to put in it and a broadcast does not return until that block exists, which makes
confirmation counting exact and makes every confirmation cost real time.

**What the token lifecycles actually do.** TRON deploys the same ERC-20 artifact the Anvil suite
uses, mints, and pays a derived destination; the assertions that matter are the recipient, the
contract and the sender, each recovered from an event log that carries none of them with the `0x41`
byte that makes them TRON addresses. Solana creates a real SPL mint and pays into a real associated
token account, derived the way the runtime derives it, which is the case that adapter is designed
around: an SPL transfer credits a token account rather than a wallet, and one test asserts the
tokens landed in the derived account while the payment was attributed to the wallet that owns it.

Both also assert the trap the token registry exists to prevent, on a real chain: the right amount, to
the right address, in the wrong asset does not settle the payment.

**What is not verified on the public networks.** That a payment sent by a real wallet on the public
Nile or Devnet networks is detected end to end. That needs a funded account on each, and neither
faucet is reachable from the machine this was built on: Solana's devnet airdrop endpoint answers
`Internal error`, its testnet endpoint `503`, and TRON's Nile faucet is a web form that did not
respond. One attempt was made and recorded rather than retried. The read path and the send path are
different halves; on those two public networks only one has been walked. A single funded address on
each would close it, and the suites are written so that pointing them at a public endpoint is a URL
change rather than a rewrite.

**A Solana transfer names no sender, and says so.** A Solana transaction may debit several accounts,
so there is no single account that sent a payment. The adapter records no source account for one
rather than guessing, `sourceAccount` is nullable in the API contract for that reason, and the
dashboard says the chain named nobody instead of showing an address. This is a property of Solana
rather than a gap in the adapter, and it is why a Solana payment cannot be attributed to a payer's
wallet the way an EVM or TRON payment can.

**Two local networks exist in the schema.** `tron-local` and `solana-local` sit alongside
`local-anvil` so that a token deployed at runtime has somewhere to be registered, which is what makes
the lifecycles above possible without weakening the frozen asset allowlist on any real network.
Registration refuses any network outside that set by name, and `resolveNetwork` refuses to hand a
caller one, so neither is reachable through the public API.

## 11. Open findings

Two structured reviews of this repository, a security review and a hardening audit, produced findings
that were then adversarially verified. Everything that could lose money, credit money that never
arrived, pay the wrong recipient, credit the wrong asset, misreport an amount, settle twice, deliver
a webhook effect twice, skip a block, or accept an asset the network denies has been fixed and
carries a test that fails when the fix is removed.

What follows is what remains: verified, real, and open. Nothing here is hidden behind a passing test
that claims otherwise, and nothing already fixed is still listed.

**Availability. A deployment stops or slows, and does not lose or misreport money:**

- `/readyz` reads a network as healthy while it is failing. The staleness check compares
  `block_cursors.updated_at` against now, and every tick stamps the lease token onto that row before
  scanning, so a worker whose scan fails on every tick keeps the timestamp fresh. Only a worker that
  stops ticking altogether is caught.
- A single configured RPC URL leaves payments in `confirming` when that endpoint goes down: the
  finality gate requires a second, independent opinion and will not accept the same provider twice.
- The finality quorum client is not asked to prove its chain identity, so an endpoint misconfigured
  to another chain contributes an opinion about the wrong ledger rather than being refused.
- The evaluator has no per-payment error isolation. One payment that throws, a chain endpoint failing
  mid-batch for instance, abandons the rest of that batch, and their queue rows stay leased until the
  lease expires and another worker claims them. Delayed, not lost.
- `findWatchedAccounts` is only half indexed. `payments_watched_idx` covers the live statuses; the
  disjunct that also returns recently settled payments during their grace window cannot use it, so
  the query degrades with the total number of payments rather than with the live ones.

**Correctness at the edges:**

- A transient DNS failure classifies a callback destination as unreachable and abandons it, where a
  retry would have succeeded.
- A payment that re-enters a status after a reorg emits no second callback, so a merchant told
  "completed" and then walked back is not told again when it completes a second time.
- A transfer that is re-mined after being orphaned keeps its earlier `credited` classification
  rather than being re-derived.
- There is no reconciliation that re-derives `credited_amount` from the transfer rows, so a bug in
  the incremental path has no independent check behind it.
- A callback response body is read in full before being discarded; a hostile endpoint can make that
  large.

**Chain reading:**

- TRON and Solana reconciliation re-check every credited transfer indefinitely rather than stopping
  once the transfer is final. The answers are correct; the cost is unbounded reads on a chain where a
  finalized transaction can no longer change.
- A lagging endpoint in the fallback list can halt an EVM network during fork resolution. The
  ancestry walk asks for a height that endpoint has not caught up to, the answer contradicts the
  recorded header, and the network halts rather than guessing. Halting is the designed response to an
  anomaly, and here the anomaly is the endpoint rather than the chain. Resuming is an operator
  action.
- With two or more endpoints configured, the finality second opinion can be served by the endpoint
  that gave the first. The quorum client is built from every URL after the first, so it overlaps only
  when the primary client has itself failed over onto the head of that list. With exactly one URL
  there is no quorum client at all and the answer is `unavailable`, which is the row above.
- TRON's payment URI is a convention rather than a ratified standard, and the capability flag says
  `supportsPaymentUri: true` for it. A wallet reading the `amount` field as whole TRX rather than as
  base units would prefill a figure a million times too large. Nothing in this system trusts the URI:
  the address, the contract, the exact amount and its base units are all shown as text beside the QR,
  and what actually arrives is what is credited.

**Presentation:**

- The dashboard's Overview KPIs are derived from a single hundred-row page rather than from an
  aggregate query, so they describe the most recent hundred payments rather than the window their
  labels name.
- `formatAmount` truncates rather than rounds. It no longer writes a non-zero amount as zero, since
  it extends to the first significant digit instead, but 0.999 still reads as 0.99.
- Retiring a secret has no confirmation step.
- A QR this system draws is checked against one third-party decoder, and that decoder will not read a
  small fraction of the symbols the encoder produces, at any image size tried. With only one decoder
  available there is no way to tell such a symbol being malformed from the decoder refusing one that
  is fine, so the round-trip corpus is derived from a fixed seed and a failure is investigated rather
  than retried. No payment depends on the QR: the address, the asset contract and the exact amount in
  both display and base units are all shown as text beside it, and what is credited is what arrives.

**Security posture:**

- No security headers on API responses. Rate limiting exists and is per key; content type, frame and
  transport headers do not.

**Operations:**

- No key re-wrap path: rotating `WALLET_KEY_ENCRYPTION_KEY` requires manual work.
- No seed backup or export procedure is documented beyond the provisioning command.
- No test asserts that `roles.sql` contains every table, and CI never builds the container images, so
  a permission or image regression is found at deploy time.
