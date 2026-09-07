# ADR-0003: The finality tag gates completion, not the confirmation count alone

- Status: accepted

## Context

A payment is complete when the money cannot be taken back. The usual proxy for that is a confirmation
count: wait N blocks. Polygon publishes a `finalized` block tag backed by Heimdall checkpoints, which
is a statement about the same question from the chain itself.

## Decision

Both, whichever is later. `confirmations >= requiredConfirmations` **and** the `finalized` tag covers
the settling block, seconded by a second, independently operated provider. If the finality view
stalls, alert and hold. Never fall back to the count.

## Why

**A count is a guess about block time.** Twelve confirmations means one thing at two-second blocks
and something quite different at five. Polygon's block time changed twice in eighteen months, and
PIP-75 made it runtime-configurable, so any constant chosen today is a constant that will be wrong.
The finality tag self-adjusts because it is derived from the checkpoint, not from a wall clock.

**The tag alone is not enough either.** It comes from a provider we do not control, and a provider
that is lagging, cached, or lying reports a height that is not true. The count is the independent
check on that: it comes from the tip, which is a different question the same endpoint would have to
lie about consistently.

**Falling back on a stall is the worst option available.** A stalled checkpoint looks exactly like a
healthy chain to a counter: blocks keep arriving, so confirmations climb past the requirement while
nothing has actually settled. A system that falls back to a count in that moment completes payments
precisely when it is least safe to. Holding costs the merchant minutes; completing costs them the
payment.

## What this costs

Availability, deliberately. A finality outage stops completions rather than degrading them, and
someone has to be paged. That is stated in `docs/limitations.md` rather than hidden.

It also costs one extra RPC call per completion for the second opinion. That call is made only on
ticks where a payment is otherwise ready to complete — a test counts the calls to prove it — so the
cost scales with completed payments rather than with the polling rate.

## Considered and rejected

**Count only.** The block-time and stall arguments above.

**Tag only.** No independent check on a single provider.

**`blockTag: 'safe'`.** It type-checks in viem and is not served by Polygon, so it fails at runtime on
the one network this ships for. A lint rule bans it.
