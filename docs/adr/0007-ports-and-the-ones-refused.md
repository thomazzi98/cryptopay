# ADR-0007: Five ports, and the ones deliberately refused

- Status: accepted

## Context

Hexagonal architecture invites an interface for every dependency. Taken literally it produces a
codebase where every concrete class has exactly one implementation and one test double, and the
indirection buys nothing but the appearance of rigour.

## Decision

Five ports: `ChainGateway`, `SettlementBroadcaster`, `PaymentAddressAllocator`, `Clock`,
`RandomSource`. Everything else is a concrete class the use case depends on directly.

## Why each of the five earns its place

- **`ChainGateway`** — the second chain is the whole architectural claim, and ADR-0004 turns it into
  something falsifiable.
- **`SettlementBroadcaster`** — split from the gateway so the read path never touches key material.
  The split is the security property, not the testability.
- **`PaymentAddressAllocator`** — the allocation strategy is a genuine decision with live
  alternatives, compared in ADR-0005.
- **`Clock`** and **`RandomSource`** — expiry, retry schedules and jitter are otherwise untestable
  without sleeping, and a test that sleeps is flaky and slow at the same time.

## Why the obvious ones are refused

**Repository interfaces.** The integration suite runs against real PostgreSQL 18 with the real
migrations. That is strictly better evidence than a fake: it catches a constraint violation, a
serialisation failure and a missing index, none of which a hand-written double will ever produce. An
interface here would exist to enable a worse test.

**`UnitOfWork`.** The transaction is already explicit at the few places it matters, and those places
are the ones this system most needs a reader to see. Wrapping them would hide exactly the thing the
resilience suite exists to prove.

**`EventBus`.** The outbox row _is_ the publication. A bus on top would be a second mechanism for the
same fact, and a second place for the two to disagree.

**A `Logger` port, a `ConfigurationProvider`, a `CallbackTransport` class, a `RetryPolicy` class, a
class per `PaymentStatus`, CQRS buses, event sourcing.** Each would add a layer and remove nothing.
The retry policy is a frozen table and a pure function, which is already testable in isolation; the
callback transport is one function typed as a function, which is all a port would have given.

## What this costs

Use cases name concrete classes, so a reader has to know that `PaymentRepository` means PostgreSQL.
That is a real cost, and it is smaller than the cost of eleven interfaces with one implementation
each and a test suite that proves the doubles agree with themselves.
