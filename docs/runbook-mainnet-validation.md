# Mainnet validation runbook

There is no automated test that spends real money in this repository, and there will not be. A test
that costs POL on every run is a test somebody eventually disables, and the day it is disabled is the
day it was needed. Mainnet is validated once, by a person, with a budget, and the result is written
down here.

## What only mainnet can show

Everything else is proved on a local chain. The settlement suite signs with keys derived from a
sealed seed, broadcasts to a node, and asserts on what the token contract says afterwards — nineteen
tests, no stubs. Anvil cannot show four things:

- **Fee estimation where the base fee moves.** Anvil's base fee is stable and low. Polygon's is not,
  and its validators enforce a priority-fee floor that a local chain has no opinion about.
- **A real chain identity.** The refusal to sign against an endpoint serving a different chain can
  only be exercised against endpoints that really do serve different chains.
- **A real receipt.** `effectiveGasPrice`, `gasUsed` and the block hash come from a real consensus.
- **Whether the spend arithmetic matches what Polygon charges.** The ceiling is only as good as the
  agreement between the estimate and the invoice.

## The budget

A hard ceiling, checked as a worst case before every send by the same `decideSpend` the settlement
engine uses. A step whose worst case would cross it is refused rather than discovered afterwards.

```bash
node scripts/validate-mainnet.mjs            # dry run: prints every cost, sends nothing
node scripts/validate-mainnet.mjs --confirm  # executes
```

Prerequisites: `POLYGON_MAINNET_RPC_URLS`, a live wallet seed
(`npm run wallet:provision --workspace @cryptopay/api -- live`), `WALLET_KEY_ENCRYPTION_KEY`, and a
funding account with a little POL.

## Run of 8 September 2026

Ceiling: **0.5 POL**. Spent: **0.0115 POL** in fees. Nothing else was consumed.

| Step                 | Signed by       | Transaction                                                                                                         | Block    | Gas   | Fee paid         |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- | -------- | ----- | ---------------- |
| 1. Fund the treasury | funding account | [`0x9f75b5b6…4298b`](https://polygonscan.com/tx/0x9f75b5b6eb5d908886f833a498b6165e3ce736f46038d0ded78e178a5b64298b) | 93447206 | 21000 | 0.00573259745898 |
| 2. Engine broadcast  | **the engine**  | [`0x570a7a56…c1b11`](https://polygonscan.com/tx/0x570a7a56d0b465f9c4b7a84cc581da427b8460c2244326fa7262ec3c540c1b11) | 93447209 | 21000 | 0.00572092198083 |

Accounts:

- Funding account `0x96BAdFc3b262170AA3Ce2D016B551c1921C4419D`
- Treasury `0xdb31ced71dfb5cc2c60471c769e22378c224e36b`, derived at `m/44'/60'/1'/0/0` from the live
  seed. Holds **0.0143 POL**, recoverable through that seed.

Chain conditions at the time: base fee 255 gwei, estimated max fee 331 gwei, priority fee 25 gwei —
the Polygon floor. Both receipts settled at ~273 gwei effective.

### What the engine did, and what was checked

| Behaviour                                            | Observed                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Refuses an endpoint that is not the configured chain | `getChainId()` returned 137 and matched before anything was signed          |
| EIP-1559 estimation against a live base fee          | 26 250 compute limit for a 21 000-gas transfer: the 125% margin, applied    |
| Reference known before submission                    | `0x570a7a56…` was derived from the signed bytes, printed, then submitted    |
| Submission classified                                | `accepted`                                                                  |
| Reconciliation asks the chain, never assumes         | `mined`, block 93447209, `succeeded: true`, 21 000 gas at 272.42 gwei       |
| Sequence claimed against the chain's own count       | chain reported 0, allocator claimed 0                                       |
| Spend ceiling arithmetic                             | 0.0315 POL committed against 0.5, refusal path exercised in the Anvil suite |

Both transactions were then re-read from a **second, independent provider** (`polygon.drpc.org`,
different operator from the one that broadcast them) and agreed on status, block, gas and fee.

### What this run did not cover

- **No ERC-20 sweep.** The rehearsal moves native currency, because acquiring mainnet USDC to sweep
  costs real money for no additional evidence: the ERC-20 call data path, the balance read and the
  two-transaction fund-then-sweep sequence are all exercised against a real token contract in
  `apps/api/test/settlement.spec.ts`.
- **No settlement row.** With no payment to settle, the transaction was driven through the
  broadcaster directly rather than through `SettlePaymentsUseCase`, so nothing was written to
  `chain_transactions` and the engine's own committed total still reads zero for mainnet. The
  repository, the compare-and-swap and the sequence allocator are covered on Anvil.
- **No reorg.** Polygon reorgs cannot be induced on demand. Reorg handling is exercised by rewriting
  history on a local chain, including the case that matters most — a fork in a window containing no
  transfers.

## Before doing this again

Re-read [limitations.md](limitations.md) first. Then:

1. Run the dry run and read every figure before passing `--confirm`.
2. Check that the funding account is one you are willing to expose. It signs on mainnet.
3. Keep `WALLET_KEY_ENCRYPTION_KEY` backed up before provisioning a live seed. Without it the
   treasury balance is unreachable — there is no other copy and no recovery path.
4. If anything is unexpectedly expensive, stop. Do not retry a transaction whose failure you have not
   understood; a retry that has not asked the chain what happened is how money is sent twice.
