# CryptoPay

A crypto payment processor that verifies every payment **independently, on-chain** — built for
Polygon, designed so a second blockchain is an adapter rather than a rewrite.

A merchant creates a payment through the API and receives a hosted checkout link. The customer pays
with MetaMask. From that point the browser is irrelevant: a backend worker scans the chain, matches
the transfer against the payment's own receiving address, re-derives the amount and asset from chain
data, tracks confirmations to a finality gate, and only then marks the payment complete and notifies
the merchant's `callbackUrl` with a signed webhook.

**The frontend is never the source of truth.** A transaction hash reported by the browser is treated
as a hint that schedules a scan — nothing more. A payment completes correctly if the customer closes
the tab the instant after signing, and a fabricated hash changes nothing. That is asserted rather
than claimed: `apps/api/test/checkout.spec.ts` sends invented hashes and checks that the credited
amount, the status and the version are all untouched.

> **Read [docs/limitations.md](docs/limitations.md) before putting money through this.** It is a
> production-_quality_ reference implementation, not a production _deployment_. Key encryption keys
> are environment variables on the host, there is a real custody window between crediting and
> sweeping, and settlement is not implemented at all. None of that is hedged there.

## Try it in thirty seconds

```bash
npm install
npm run build
npm run demo
```

That starts PostgreSQL, applies the migrations, provisions a wallet seed, issues a merchant API key
and brings up the API and the dashboard. It prints the key; paste it into the connect screen. Every
credential is generated for the run and deleted with the process, and nothing is read from or written
to `.env`.

For the deployment shape instead — three processes, three database roles, and a merchant endpoint
that verifies the signatures it receives — use `docker compose up`.

## Why it is built this way

Payment processing is mostly a correctness problem wearing a CRUD costume. The decisions that shape
this codebase all come from that, and each has a record in [docs/adr](docs/adr) with what it costs:

- **PostgreSQL is the only durable store.** Marking a payment complete and scheduling its webhook
  happen in one transaction. A queue in a second system would be a dual write: commit here, enqueue
  there, crash between, and the payment is complete forever with the merchant never told.
- **The block cursor advances only inside the transaction that writes the data it covers.** A crash
  replays the same window and unique constraints make the replay a no-op, so the recovery path is
  exercised by every ordinary tick rather than only by crashes.
- **Completion needs the finality tag, not only a confirmation count.** A count is a guess about
  block time, and Polygon's changed twice in eighteen months. When finality stalls the scanner holds
  and alerts; it never falls back to counting, because a stalled checkpoint looks exactly like a
  healthy chain to a counter.
- **Halting beats guessing.** A reorg deeper than the configured limit, or two providers disagreeing,
  stops the scanner and pages a human. Guessing during an anomaly loses money quietly.
- **Token identity is the contract address.** Bridged USDC.e returns the byte-identical `symbol()`
  string `"USDC"`. Matching on the symbol credits the wrong asset.
- **Leadership is a lease with a fencing token.** A session advisory lock has no failover when a
  process hangs but stays connected: scanning stops silently while readiness stays green.

## What the tests actually prove

The integration suite runs against a real PostgreSQL 18 and a real Anvil chain — no mocked providers,
no fake database.

- **Reorgs** are exercised by rewriting chain history with a snapshot and a revert, including the case
  that matters most: a fork in a window that contained no transfers, which a naive implementation
  cannot even detect.
- **Two money invariants** are checked after failing the database at _every_ query the scanner and the
  evaluator make, one index at a time. A transfer is never recorded above the cursor covering it, and
  a status change with a callback URL always has its delivery row. Injecting at a checkpoint someone
  picked by hand would only prove the checkpoint was picked to pass.
- **The outbox** is forced to fail its insert, and the payment update must roll back with it.
- **The SSRF policy** is driven case by case, including a DNS rebinding stub that answers with one
  public and one private address.
- **Callbacks** are delivered over a real socket to a real HTTP server and verified with the same
  module a merchant would install.

## Requirements

- Node.js 24.11.1 (see `.nvmrc`)
- npm 11.6+
- Docker, only for `docker compose up`. The tests and `npm run demo` need neither Docker nor a
  running database: both start a real PostgreSQL of their own.
- Foundry, only for the chain integration tests (`anvil` on the path).

## Working on it

```bash
npm run preflight    # Node, npm, disk space, git identity, ports
npm test             # unit and property tests
npm run test:integration
npm run lint && npm run typecheck && npm run knip
npm run scan:secrets
```

`preflight` prints the exact command to fix anything it finds. If it flags disk space or Docker, read
[docs/environment-setup.md](docs/environment-setup.md).

If you are configuring a testnet key, run `npm run check:testnet-key` first. It derives the address
locally and asks four mainnets whether it has ever been used, because one secp256k1 key controls the
same address on every EVM chain and a variable named for a testnet confines nothing.

## Repository layout

```
packages/shared/   pure, dependency-light code shared by the API, the web app and the tests:
                   ledger primitives, chain constants, the payment state machine, money,
                   API contracts, and webhook signing and verification.
apps/api/          the API and both workers: the chain scanner and the callback deliverer.
apps/web/          the Next.js dashboard and the public checkout page.
apps/demo-receiver/ a merchant endpoint that verifies with the same module the API signs with.
docs/              limitations, webhooks, the state machine, and the decision records.
scripts/           preflight, the demo runner, the secret scanner and the testnet key check.
```

## Documentation

- [docs/limitations.md](docs/limitations.md) — every real exposure and gap, unhedged.
- [docs/webhooks.md](docs/webhooks.md) — the callback contract, and the three rules implementations
  get wrong.
- [docs/state-machine.md](docs/state-machine.md) — generated from the transition table, so it cannot
  drift.
- [docs/adr](docs/adr) — eight decisions, each with what it costs and what was rejected.

## Contributing

[CLAUDE.md](CLAUDE.md) is the engineering guide: the style rules enforced by lint, the architecture
boundaries, why each load-bearing version is pinned, and the framework traps that have already cost
time once. Read it before your first change.

## License

MIT — see [LICENSE](LICENSE).
