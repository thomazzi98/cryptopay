# ADR-0002: Leased leadership with fencing tokens

- Status: accepted

## Context

Exactly one process may advance a network's scan cursor at a time. Two would rescan the same window
concurrently, which is safe by construction, and would also fight over the cursor, which is not.

## Decision

A `leader_leases` table with an expiry and a monotonically increasing fencing token. The holder
renews; the token is written into every cursor update as part of the `WHERE` clause.

## Why

**A session advisory lock has no failover when a process hangs but stays connected.** That is the
failure that matters. A worker that is wedged — a stuck RPC call, a paused container, a garbage
collection pause that never ends — still holds its advisory lock, because the connection is alive.
Scanning silently stops. Readiness stays green, because the process is running and the database is
reachable. Payments keep being created and customers keep paying, and nothing is detected.

A lease expires whether or not the holder noticed it was stuck.

**The fencing token handles the other half.** A worker that hung past its expiry and then woke up
still believes it is the leader. Its writes carry a token the cursor has moved past, so they affect
zero rows: the database refuses them, rather than the worker's own opinion of whether it is still in
charge. A test kills the holder, watches the handover, and asserts the stale holder's write changes
nothing.

## What this costs

A lease can be lost while the holder is healthy but slow, which causes a handover that was not
needed. The cost of that is one duplicated scan window, which is a no-op. The cost of the opposite
mistake is undetected payments.

## Considered and rejected

**`pg_advisory_lock` on a session.** The hang case above.

**A transaction-scoped advisory lock per tick.** Correct, and it makes every tick contend on one
lock, which serialises networks that have no reason to be serialised.

**A leader election service.** A whole dependency, and its own failure modes, for a problem one table
solves.
