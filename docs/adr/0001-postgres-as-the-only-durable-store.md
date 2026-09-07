# ADR-0001: PostgreSQL is the only durable store

- Status: accepted
- Deciders: the team building CryptoPay

## Context

Payments need background work: scanning blocks, evaluating status, delivering callbacks. The
reflexive shape for that is Redis with BullMQ, and it is what most references reach for.

## Decision

There is no broker. Work queues are tables in the same PostgreSQL database that holds the payments,
and background processes drain them.

## Why

**BullMQ is the dual write.** A payment completes, the row commits in PostgreSQL, and then the job is
enqueued in Redis. Between those two operations the process can die, and there is no transaction
spanning them. The result is a payment that is `completed` forever with the merchant never told, and
nothing left anywhere to retry, because the notification was never written down.

The outbox removes the window rather than narrowing it. The delivery row is written in the same
transaction as the status change, so "completed and nobody was told" is not a state the database can
hold. A test forces the delivery insert to fail and asserts the payment update rolls back with it.

The same argument applies to the scan cursor: it advances inside the transaction that writes the
transfers it covers, so a crash replays the identical window and the uniqueness constraint makes the
replay a no-op.

## What this costs

Throughput. A broker is faster than `SELECT … FOR UPDATE SKIP LOCKED`, and at a volume this system
does not have, that would matter. PostgreSQL 18 handles the claim pattern well into the thousands of
jobs per second, which is several orders of magnitude above anything here.

It also costs a capability: there is no delayed-job scheduler, no priorities, no fan-out. Retry
scheduling is a `next_attempt_at` column and a query, which is less than a broker offers and exactly
as much as this needs.

## Considered and rejected

**Redis with BullMQ.** The dual write above.

**A transactional outbox plus a broker, with a relay.** Correct, and it adds a whole component and a
failure mode to gain throughput nothing here needs.

**Postgres `LISTEN`/`NOTIFY` instead of polling.** Not durable: a notification delivered while no
listener is connected is gone. It would have to sit on top of the table anyway, so it would be an
optimisation rather than a design, and it is one that can be added later without changing anything.
