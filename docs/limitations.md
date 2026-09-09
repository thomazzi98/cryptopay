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
- **A TRON or Solana payment cannot be created yet.** This is the largest gap in the multi-chain
  work and it is not visible from the feature list. The address allocator derives EVM addresses
  only, so no base58 receiving address can be issued, and the database would refuse one anyway. Both
  adapters are complete, tested read oracles that nothing in the product can currently point at a
  live payment: a request for either family is refused with `NETWORK_UNAVAILABLE`. What is missing
  is per-family key derivation, not adapter work.
- **Sending on TRON or Solana.** Both chains are watched and neither is signed on. There is no TRON
  or Solana signing code anywhere in this repository, which is why both declare
  `supportsSettlement: false` and why a custodial destination cannot be offered on either: money
  arriving at an address this system cannot spend from would be stranded.

## 9. What the tests do and do not prove

The integration suite runs against a real PostgreSQL 18 and a real Anvil chain, and the reorg suite
rewrites chain history with a snapshot and a revert rather than stubbing a provider. Those results
are evidence.

They are evidence about **this** code under **these** conditions. They say nothing about behaviour
under sustained production load, against a rate-limited provider, during a multi-hour network
partition, or with a database that has been running for a year. Nothing here has run for a year.

## 10. What multi-chain support was and was not validated on

The three families are not equally proven, and the difference matters more than the feature list.
Three levels of evidence are used below and they are not interchangeable.

- **Local chain** means a real node of that chain's own software, run in Docker on one machine, with
  transactions this suite broadcast and signed itself. It proves encoding, signing, block production
  and detection. It proves nothing about peers, forks, propagation or a public endpoint's manners.
- **Live read** means the adapter pointed at the real public network, decoding history that already
  exists there. It proves the shapes that network really returns today.
- **Mainnet** means real money.

|                                               | Polygon                     | TRON                      | Solana                 |
| --------------------------------------------- | --------------------------- | ------------------------- | ---------------------- |
| Destination derived and accepted by the chain | local chain                 | local chain               | local chain            |
| Payment URI and QR                            | decoded from the image      | decoded from the image    | decoded from the image |
| Native payment sent, detected, completed      | local chain                 | local chain               | local chain            |
| Token payment sent and detected               | local chain, full lifecycle | local chain, adapter only | not sent               |
| Reading real network history                  | live read                   | live read, cross-checked  | live read              |
| A payment sent on the public testnet          | yes, on Amoy                | **no**                    | **no**                 |
| A transaction broadcast on mainnet            | once                        | never                     | never                  |

**What the local chains are.** TRON is `tronbox/tre`, a single-witness java-tron whose genesis
pre-funds a known account. Solana is `anzaxyz/agave` running `agave-test-validator`. Both answer on
the same HTTP and JSON-RPC surfaces the adapters use in production, and both suites broadcast real
signed transactions rather than replaying fixtures. A TRON block is produced only when there is a
transaction to put in it, which is why nineteen confirmations cost a minute of real block production
that cannot be hurried.

**Where the TRON token test stops short.** A TRC-20 contract is deployed on the local node, minted,
transferred, and read back by the adapter, which is the check that matters most on TRON: event logs
carry addresses without the `0x41` byte, and reading one as an EVM address produces a plausible
identity belonging to nobody. What is not driven is the payment lifecycle for that token, because
the asset allowlist a payment is classified against is frozen per network and correctly refuses a
contract deployed at runtime. The local-development escape hatch is deliberately restricted to the
Anvil network so it cannot become a way to add an asset to a real one. That is the safety property
working rather than a gap in it.

**What no test here establishes.** That a payment sent by a real wallet on the public Nile or Devnet
networks is detected end to end. That needs a funded testnet account, and neither faucet is reachable
programmatically from the machine this was built on: Solana's devnet airdrop endpoint answers
`Internal error` and its testnet endpoint `503`, and TRON's Nile faucet is a web form. The read path
and the send path are different halves; on those two public networks only one of them has been
walked. A single funded address on each would close it, and the suites are written so that pointing
them at a public endpoint is a URL change rather than a rewrite.

**A semantic difference worth knowing before reading a Solana transfer row.** `source_account` does
not mean on Solana what it means on an EVM chain. A Solana transaction may debit several accounts,
so there is no single sender to record, and the adapter deliberately stores the account that was
credited rather than guessing which debit was the payment. The field is not published through the
gateway API; it is visible in the dashboard's transfer list, where on a Solana payment it shows the
deposit address rather than the payer.

## 11. Known open findings

A structured security review of this repository produced findings that were then adversarially
verified; sixty survived. Every finding rated critical is fixed. The ones below are rated high, are
real, and are **not** fixed. They are listed rather than quietly carried, because a review whose
output is invisible is worth nothing.

**Availability — a deployment stops, but does not lose or misreport money:**

- `/readyz` reports a stale cursor by comparing it against the lease it holds, so a worker that
  adopts a lease and then stops scanning reads as healthy.
- A single configured RPC URL leaves payments in `confirming` when that endpoint goes down: the
  finality gate requires a second, independent opinion and will not accept the same provider twice.
- The finality quorum client is not asked to prove its chain identity, so an endpoint misconfigured
  to another chain contributes an opinion about the wrong ledger rather than being refused.
- Callback delivery has no per-payment error isolation in the evaluator, and one destination that
  hangs delays the deliveries queued behind it.
- `findWatchedAccounts` has no supporting index; it is fast on a small live set and degrades with
  the total number of payments rather than the live ones.

**Correctness at the edges:**

- A transient DNS failure classifies a callback destination as unreachable and abandons it, where a
  retry would have succeeded.
- A callback claim is not fenced and does not use `FOR UPDATE SKIP LOCKED`, so two workers can
  attempt the same delivery; the receiver's own idempotency key is what prevents a duplicate.
- A payment that re-enters a status after a reorg emits no second callback, so a merchant told
  "completed" and then walked back is not told again when it completes a second time.
- A transfer that is re-mined after being orphaned keeps its earlier `credited` classification
  rather than being re-derived.
- There is no reconciliation that re-derives `credited_amount` from the transfer rows, so a bug in
  the incremental path has no independent check behind it.
- A callback response body is read in full before being discarded; a hostile endpoint can make that
  large.

**Operations:**

- No key re-wrap path: rotating `WALLET_KEY_ENCRYPTION_KEY` requires manual work.
- No seed backup or export procedure is documented beyond the provisioning command.
- No test asserts that `roles.sql` contains every table, and CI never builds the container images,
  so a permission or image regression is found at deploy time.

**Medium, and also open:** no security headers on API responses, no rate limiting, the dashboard's
Overview KPIs are derived from a single hundred-row page rather than an aggregate, `formatAmount`
truncates rather than rounds in the dashboard, and retiring a secret has no confirmation step.
