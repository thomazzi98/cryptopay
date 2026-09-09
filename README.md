# CryptoPay

Multi-chain crypto payment infrastructure for merchants and payment gateways, built so that the
backend decides what happened by reading the chain and nothing else.

Three chain families are supported: **Polygon** (POL, USDC, USDT), **TRON** (TRX, USDT) and
**Solana** (SOL, USDC). A caller names a family and a logical currency; which network that resolves
to follows from the environment of their API key, so a test key has no way to name a main network.
Each chain is read through its own adapter, because the three genuinely differ - TRON writes
addresses in case-sensitive base58 and publishes a solidified head, Solana skips slots and states a
commitment instead of counting confirmations - and pretending otherwise produces a system that halts
on a healthy chain.

The three are not equally proven, and
[docs/limitations.md](docs/limitations.md#10-what-multi-chain-support-was-and-was-not-validated-on)
sets out exactly which parts were validated against what.

A merchant creates a payment through the API and gets a hosted checkout link. The customer pays with
their wallet. From that point the browser is irrelevant: a worker scans the chain, matches the
transfer against the address allocated to that payment alone, re-derives the amount and the asset
from chain data, holds it to a finality gate, marks the payment complete, notifies the merchant with
a signed webhook, and then moves the funds to the merchant's payout account.

**The frontend is never the source of truth.** A transaction hash reported by a browser is a hint
that schedules a scan and nothing more. A payment completes correctly if the customer closes the tab
the instant after signing, and a fabricated hash changes nothing. That is asserted rather than
claimed: `apps/api/test/checkout.spec.ts` sends invented hashes and checks that the credited amount,
the status and the version are all untouched.

> **Read [docs/limitations.md](docs/limitations.md) before putting money through this.** Key
> encryption keys are environment variables on the host, there is a real custody window between
> crediting and sweeping, the seed has no backup path, and no payment has ever been sent to a TRON
> or Solana destination and detected end to end. None of that is hedged there.

## Try it

```bash
npm install
npm run build
npm run demo
```

Starts PostgreSQL, applies the migrations, provisions a wallet seed, issues a merchant API key and
brings up the API and the dashboard. It prints the key; paste it into the connect screen. Every
credential is generated for the run and deleted with the process, and nothing is read from or written
to `.env`.

For the deployment shape instead — five processes, four database roles, and a merchant endpoint that
verifies the signatures it receives — use `docker compose up`.

## Architecture

```
                    ┌──────────────┐
   merchant ───────▶│     API      │  creates payments, reads state, sets payout destinations
                    │  (Fastify)   │  holds NO key material and cannot sign
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  PostgreSQL  │  the only durable store, and the only queue
                    └──▲───▲────▲──┘
                       │   │    │
   ┌───────────────────┘   │    └────────────────────┐
   │                       │                         │
┌──┴────────────┐  ┌───────┴────────┐   ┌────────────┴──────────┐
│ chain worker  │  │ callback worker│   │  settlement worker    │
│ reads the     │  │ signs and      │   │  the only process     │
│ chain, never  │  │ delivers       │   │  that can sign a      │
│ signs         │  │ webhooks       │   │  transaction          │
└──────┬────────┘  └───────┬────────┘   └────────────┬──────────┘
       │                   │                         │
   Polygon RPC      merchant endpoints           Polygon RPC
```

Four processes, because what each is allowed to do differs. The chain worker cannot read an API key.
The callback worker — the only one that connects to addresses a stranger chose — cannot read a
payment or a wallet seed. The settlement worker is the only one that may open a seed, and it may not
change a payment. Those are database roles, not conventions, and
`apps/api/test/resilience.spec.ts` asserts the refusals.

Inside the API the layering is enforced by lint rather than by agreement:

```
domain/         pure. node: builtins and packages/shared only.
application/    use cases and ports. no viem, no Prisma, no Fastify, no undici.
infrastructure/ the only place viem, Prisma, Fastify and undici may appear.
```

The chain ports speak ledger vocabulary with opaque string identifiers. There is no `0x${string}`
outside `infrastructure/chain/evm/`, and `blockHash`, `logIndex`, `topics`, `abi`, `chainId`, `nonce`
and `gasLimit` are banned from `domain/` and `application/` by a lint rule. That is what keeps a
second chain an adapter rather than a rewrite — see [docs/extending.md](docs/extending.md), including
where that claim is not yet proven.

## Why it is built this way

Payment processing is mostly a correctness problem wearing a CRUD costume. Every decision below has
a record in [docs/adr](docs/adr) with what it costs and what was rejected.

- **PostgreSQL is the only durable store.** Marking a payment complete and scheduling its webhook
  happen in one transaction. A queue in a second system would be a dual write: commit here, enqueue
  there, crash between, and the payment is complete forever with the merchant never told.
- **The block cursor advances only inside the transaction that writes the data it covers.** A crash
  replays the same window and unique constraints make the replay a no-op, so the recovery path runs
  on every ordinary tick rather than only after a crash.
- **Completion needs the finality tag, not only a confirmation count.** A count is a guess about
  block time, and Polygon's has changed twice in eighteen months. When finality stalls the scanner
  holds and alerts; it never falls back to counting.
- **A scanned window is checked against its own headers before it is written.** Logs and headers are
  separate requests, and a reorg between them produces a result that is internally inconsistent and
  looks fine. Committing one credits money against a block that no longer exists.
- **Halting beats guessing** — but only on evidence. A reorg deeper than the limit halts. An endpoint
  that did not answer does not: it is asked again.
- **Nothing retries by resending.** A transaction that might be in the mempool is resolved by asking
  the chain what became of it. A sequence number is claimed under a lock, reconciled against the
  chain, and handed back if nothing was sent with it.
- **A spend ceiling bounds the blast radius by amount.** Checked before signing, against the
  treasury's whole committed history, with unresolved transactions counted at their worst case.
- **Token identity is the contract address.** Bridged USDC.e returns the byte-identical `symbol()`
  string `"USDC"`. Matching on the symbol credits the wrong asset.
- **Leadership is a lease with a fencing token.** A session advisory lock has no failover when a
  process hangs but stays connected: scanning stops silently while readiness stays green.

## The payment lifecycle

Eight states, eleven status-changing edges, generated into
[docs/state-machine.md](docs/state-machine.md) from the table the code enforces, so the documentation
cannot describe a lifecycle the code does not implement.

`pending` → `partially_funded` → `confirming` → **`completed`**, plus the terminal
**`overpaid`**, **`underpaid`**, **`expired`** and **`canceled`**.

Three calls are load-bearing. `confirming` cannot expire, because expiring a funded payment because a
timer fired is stealing. There is no edge out of a terminal state, because that edge class is what
double-credits. And there is no `failed` state, because a reverted ERC-20 transfer emits no event at
all — settlement failure lives on a separate resource that cannot make a completed payment uncertain.

Settlement has its own six-state machine, and one deliberate difference: `failed` is not terminal.
Money sitting in an address this system controls has to stay reachable.

## Setup

Requirements: Node.js 24.11.1 (see `.nvmrc`), npm 11.6+. Docker only for `docker compose up`; Foundry
only for the chain integration tests. Neither the tests nor `npm run demo` need a running database —
both start a real PostgreSQL of their own.

```bash
cp .env.example .env
npm run preflight     # Node, npm, disk space, git identity, ports
```

`preflight` prints the exact command to fix anything it finds.

### Environment variables

Every variable is documented in [.env.example](.env.example). The ones that decide behaviour:

| Variable                                 | Meaning                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                           | PostgreSQL. The only durable store.                                                                    |
| `API_KEY_PEPPER`                         | Peppers API key digests, so a database copy alone does not permit offline verification of stolen keys. |
| `WALLET_KEY_ENCRYPTION_KEY`              | Wraps the data key that encrypts each environment's master seed. **Back this up before provisioning.** |
| `POLYGON_MAINNET_RPC_URLS`               | Comma separated, in preference order. Two or more: the rest second the finality opinion.               |
| `POLYGON_AMOY_RPC_URLS`                  | Same for the testnet.                                                                                  |
| `SETTLEMENT_ENABLED`                     | Whether this deployment may sign and broadcast at all. Off by default.                                 |
| `POLYGON_MAINNET_SPEND_CEILING`          | The most native currency this network may ever spend, in whole POL. Required in production.            |
| `CALLBACK_PRIVATE_DESTINATION_ALLOWLIST` | Explicit `host:port` entries that bypass only the private-address check. Must be empty in production.  |

Do not use `https://polygon-rpc.com`: it answers 401 for anonymous callers.

### Wallet setup

```bash
npm run wallet:provision --workspace @cryptopay/api -- test
npm run wallet:provision --workspace @cryptopay/api -- live
```

Each environment gets its own sealed master seed, bound to that environment by the encryption's
additional authenticated data — a test envelope copied into the live slot fails to decrypt rather
than quietly signing mainnet transactions with a testnet seed.

Deposit addresses are derived from the account **public** key at `m/44'/60'/0'/0/{index}`, so the
payment creation path cannot sign even if it is compromised. The treasury that pays for gas sits
behind a hardened index at `m/44'/60'/1'/0/0`, so a leaked deposit key does not reach it.

If you are configuring a funding key, run `npm run check:testnet-key` first. It derives the address
locally and asks four mainnets whether it has ever been used, because one secp256k1 key controls the
same address on every EVM chain and a variable named for a testnet confines nothing. It fails closed:
if the endpoints do not answer, the key is not cleared.

## Security model

| Concern                   | What actually stops it                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Test key reaching mainnet | The environment is a property of the key, a predicate on every query, and a database CHECK on `payments`.      |
| Wrong network             | Chain id asserted at startup and again before every signature. A mismatch refuses rather than warns.           |
| Double crediting          | `UNIQUE (transaction_reference, event_index)`, and a window discarded if a transfer disagrees with its header. |
| Double paying             | One settlement per payment (unique key), one live transaction per account and sequence (partial unique index). |
| Retrying a broadcast      | Resolved by asking the chain, never by sending again. The reference is known before submission.                |
| Unbounded spend           | A per-network ceiling checked before signing. Production refuses to start a signer without one.                |
| Key exposure              | The API holds no key material. Only the settlement worker may read a seed, and only inside one callback.       |
| Secrets in logs           | A redaction list, a binary-size guard, and an error serializer that keeps a URL's host and drops its path.     |
| SSRF via `callbackUrl`    | Five layers, ending in a pinned IP on an undici dispatcher. Applied at creation and before every attempt.      |
| Webhook forgery           | Standard Webhooks HMAC, constant-time compare, bounded timestamp tolerance in both directions.                 |
| Cross-merchant access     | Scoped in the query. Another merchant's resource answers 404, because 403 confirms it exists.                  |

## Testing

```bash
npm test                  # unit and property tests
npm run test:integration   # real PostgreSQL 18 and a real Anvil chain
npm run test:e2e           # Playwright, with an injected EIP-1193 wallet
npm run lint && npm run typecheck && npm run knip
npm run scan:secrets
```

The integration suite runs against real infrastructure: no mocked providers, no fake database.

- **Reorgs** are exercised by rewriting chain history with a snapshot and a revert, including the
  case that matters most — a fork in a window containing no transfers, which a naive implementation
  cannot detect at all.
- **Settlement** signs with keys derived from a sealed seed, broadcasts to a node, and asserts on
  what the token contract says afterwards.
- **Two money invariants** are checked after failing the database at _every_ query the scanner and
  the evaluator make, one index at a time.
- **The outbox** is forced to fail its insert, and the payment update must roll back with it.
- **The SSRF policy** is driven case by case, including a DNS rebinding stub.
- **Callbacks** go over a real socket to a real HTTP server and are verified with the same module a
  merchant would install.

Mainnet is validated once, by hand, with a budget, and the result is written down:
[docs/runbook-mainnet-validation.md](docs/runbook-mainnet-validation.md).

## Deployment

`docker compose up` brings up the full shape. The settlement worker is behind a profile and is off
unless `SETTLEMENT_ENABLED=true`:

```bash
docker compose up -d                          # everything except settlement
docker compose --profile settlement up -d      # including the signer
```

### Production considerations

Before real money:

1. **Move the key-encryption key out of the environment.** Compromising the settlement worker's host
   currently compromises every unswept deposit key. KMS is one entry in the key-wrapping registry.
2. **Back up `WALLET_KEY_ENCRYPTION_KEY` and the database.** The seed lives in PostgreSQL; without
   both, every issued address is unreachable. There is no other copy.
3. **Two or more paid RPC endpoints per network.** With one, there is no finality quorum and payments
   requiring the finality tag hold rather than completing.
4. **Set a spend ceiling.** The API refuses to start a production signer without one.
5. **`CRYPTOPAY_NODE_ENV=production` with an empty callback allowlist.** The two are incompatible by
   design and the process refuses to start otherwise.
6. **Alert on `/readyz`.** The failure that is otherwise invisible is a stalled cursor: payments keep
   being created, customers keep paying, nothing is detected, and everything else stays green.
7. **TLS in front of the API, and rate limiting.** There is none in the application today.

## Integrating this into a payment gateway

The machine-readable contract is at `GET /openapi.json`, generated from the same zod schemas the
server validates requests with. The server refuses to start if that document does not describe the
routes it serves, so an endpoint you find there exists.

[docs/integration.md](docs/integration.md) covers it properly. The short version: discover networks
and assets from `GET /v1/networks` instead of hardcoding them, create with a required
`Idempotency-Key`, deduplicate webhooks on `webhook-id`, discard events whose `statusVersion` is not
greater than the one you hold, and read amounts as the two decimal strings they are rather than as
JSON numbers.

## Repository layout

```
packages/shared/    pure code shared by the API, the web app and the tests: ledger primitives,
                    chain constants, both state machines, money, API contracts, the OpenAPI
                    document, and webhook signing and verification.
apps/api/           the API and three workers: chain scanning, callback delivery, settlement.
apps/web/           the Next.js dashboard and the public checkout page.
apps/demo-receiver/ a merchant endpoint that verifies with the same module the API signs with.
docs/               integration, extension, limitations, webhooks, the state machine, the mainnet
                    runbook, and the decision records.
scripts/            preflight, the demo runner, the secret scanner, the key check, the mainnet
                    rehearsal.
```

## Roadmap

In the order that would matter most:

1. **A hosted key manager** for the seed-wrapping key, retiring the largest honest exposure.
2. **A second chain**, starting by extracting the gateway suite into one parameterised by an adapter
   so both run identical assertions.
3. **Refunds**, which today are a manual transfer from the payout account.
4. **Rate limiting and a request budget per key.**
5. **More assets**, which is data rather than code — with fee-on-transfer and rebasing tokens
   deliberately out of scope, because the amount that arrives is not the amount the event reports.

## Documentation

- [docs/integration.md](docs/integration.md) — for the system on the other side of the API.
- [docs/extending.md](docs/extending.md) — adding an asset, a network, or a chain family.
- [docs/limitations.md](docs/limitations.md) — every real exposure and gap, unhedged.
- [docs/webhooks.md](docs/webhooks.md) — the callback contract and the three rules implementations
  get wrong.
- [docs/state-machine.md](docs/state-machine.md) — generated, so it cannot drift.
- [docs/runbook-mainnet-validation.md](docs/runbook-mainnet-validation.md) — what was spent, and on
  what.
- [docs/adr](docs/adr) — the decisions, each with its cost.

## Contributing

[CLAUDE.md](CLAUDE.md) is the engineering guide: the style rules enforced by lint, the architecture
boundaries, why each load-bearing version is pinned, and the framework traps that have already cost
time once. Read it before your first change.

## License

MIT — see [LICENSE](LICENSE).
