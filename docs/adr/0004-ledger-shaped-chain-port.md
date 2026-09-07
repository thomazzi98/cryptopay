# ADR-0004: The chain port speaks ledger vocabulary with opaque identifiers

- Status: accepted

## Context

Polygon is the first chain. Ethereum and BSC should be adapters. Solana and Tron should be possible
without rewriting the payment logic.

## Decision

`ChainGateway` names positions, headers, transfers and finality. It never names a block hash, a log
index, a topic, an ABI, a chain id or a nonce. Every identifier is an opaque `string`. A lint rule
bans that vocabulary in `domain/` and `application/`, and bans hex-string address types outside
`infrastructure/chain/evm/`.

## Why

**The abstraction has to be designed for the second chain, not asserted to be.** An interface that
says `getLogs(topics, fromBlock, toBlock)` is an EVM client with different capitalisation, and the
first non-EVM adapter would have to lie about what it means.

The load-bearing evidence that this one is real is a single arm on one type: `LedgerPositionLookup`
has a `skipped` case. On EVM every height has a block and the case never fires. On Solana a leader
can fail to produce and the slot is legitimately empty, and an ancestry check without that case reads
a healthy Solana chain as a reorg and halts it. That arm costs nothing today and is the difference
between an adapter and a rewrite later.

Reading and writing are separate ports for a different reason: the read gateway never touches key
material, so no amount of misuse of the scanning path can sign anything.

## What this costs

A translation layer, and some awkwardness where an EVM concept has no neutral name. `event index` for
`logIndex` reads slightly foreign to someone who knows Ethereum, which is the intended trade.

## Falsifiable

A contract suite that runs against any implementation is the pass/fail target. A second adapter that
passes it is a second chain; one that needs the suite changed means this record was wrong.
