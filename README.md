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
the tab the instant after signing, and a fabricated hash changes nothing.

## Why it is built this way

Payment processing is mostly a correctness problem wearing a CRUD costume. The decisions that shape
this codebase all come from that:

- **Postgres is the only durable store.** Marking a payment complete and scheduling its webhook
  happen in one transaction. A queue in a second system would be a dual write: commit here, enqueue
  there, crash between, and the payment is complete forever with the merchant never told.
- **The block cursor advances only inside the transaction that writes the data it covers.** A crash
  replays the same window and unique constraints make the replay a no-op. The recovery path is
  therefore exercised by every normal tick, not only by crashes.
- **Halting beats guessing.** When a reorg runs deeper than the configured limit, or two providers
  disagree about finality, the scanner stops and pages a human. Guessing during an anomaly loses
  money quietly.
- **Token identity is the contract address.** Bridged USDC.e returns the byte-identical `symbol()`
  string `"USDC"`. Matching on the symbol credits the wrong asset.

## Status

Under active construction. The build is milestone-driven and every commit leaves `main` green; see
the git history for what has landed. This README grows with it — nothing is documented here before
it exists.

## Requirements

- Node.js 24.11.1 (see `.nvmrc`)
- npm 11.6+
- Docker (only for `docker compose up` and the Postgres used by integration tests)

## Getting started

```bash
npm install
npm run preflight   # verifies Node, npm, disk space, git identity, Docker, ports
npm test
npm run typecheck
```

`preflight` reports the exact command to fix anything it finds. If it flags disk space or Docker,
read [docs/environment-setup.md](docs/environment-setup.md).

## Repository layout

```
packages/shared/   pure, dependency-light code shared by the API, the web app and the tests:
                   ledger primitives, chain constants, the payment state machine, money,
                   API contracts, webhook signing and verification.
apps/              the API, its workers, and the Next.js dashboard and checkout.
docs/              architecture, decision records, and operational notes.
scripts/           preflight and other repository tooling.
```

## Contributing

[CLAUDE.md](CLAUDE.md) is the engineering guide: the style rules that are enforced by lint, the
architecture boundaries, why each load-bearing version is pinned, and the framework traps that have
already cost time once. Read it before your first change.

## License

MIT — see [LICENSE](LICENSE).
