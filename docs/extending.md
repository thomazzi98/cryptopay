# Adding an asset, a network, or a chain

Three sizes of change, and they are genuinely different sizes. What follows is the actual file list
for each, not an estimate.

## A new asset on a network that already works

Say USDT on Polygon.

1. **`packages/shared/src/chain-constants.ts`** — the contract address, lowercase, and the decimals.
   Read the decimals off the contract with `eth_call`; do not assume 18, and do not assume 6 because
   USDC uses 6.
2. **`apps/api/src/infrastructure/chain/network-configuration.ts`** — one entry in that network's
   `assetAllowlist`.
3. If the asset has a bridged or wrapped lookalike, one entry in `assetDenylist` as well, so a
   transfer of the lookalike is recorded as `wrong_asset` rather than silently ignored. Bridged
   USDC.e is the reason this list exists: it returns the byte-identical `symbol()` string `"USDC"`,
   and only `name()` differs.

That is the whole change. The scanner already asks for every allowlisted asset reference in one
`eth_getLogs` call, the credit path already matches on contract address, and `GET /v1/networks`
starts advertising it to integrators with no release on their side.

**What it does not support.** Fee-on-transfer and rebasing tokens are out of scope, and the reason is
not effort: the amount that arrives is not the amount the event reports, so an acceptance band
computed from the requested amount is wrong by construction. Adding one to the allowlist would
under-credit customers. See [limitations.md](limitations.md).

## A new EVM network

Say Ethereum mainnet or BNB Smart Chain. There is no new _code_ — the chain worker already builds one
`EvmChainGateway` per configured network — but there are six places that hold data:

1. **`packages/shared/src/ledger-primitives.ts`** — add the identifier to the `NetworkIdentifier`
   union and to `NETWORK_IDENTIFIERS`.
2. **`packages/shared/src/chain-constants.ts`** — chain id, explorer base URL (no trailing slash), and
   the token addresses.
3. **`apps/api/src/infrastructure/chain/network-configuration.ts`** — one frozen entry: environment,
   native currency, `requiredConfirmations`, `requiresFinalityTag`, `maximumReorgDepth`, the asset
   lists, the explorer.
4. **`apps/api/src/configuration.ts`** — the RPC URL list, the optional keyless wallet RPC URL, and
   the two `Record<NetworkIdentifier, …>` maps that read them. Those maps are exhaustive by type, so
   forgetting one is a compile error rather than a network that silently never scans.
5. **A migration** adding the value to the `network_identifier` enum:
   `ALTER TYPE network_identifier ADD VALUE 'ethereum-mainnet';`
6. **`apps/web/.../wallet-configuration.ts`** — the wagmi chain, if customers will pay through the
   hosted checkout. Public transports only: that file ships to every customer's browser.

Then set the RPC URLs in the environment. The worker starts scanning the network on the next restart
because it iterates configured networks, and `GET /v1/networks` starts advertising it.

Four things check the entry rather than trusting it:

- `network-configuration.spec.ts` runs its invariants over **every** network — lowercase asset
  references, no asset on both lists, no duplicate chain identifier, `maximumReorgDepth` at least
  `requiredConfirmations`, a usable explorer prefix — and asserts the table covers `NETWORK_IDENTIFIERS`
  exactly.
- The gateway asserts `eth_chainId` against the configured chain identifier at first use, so an RPC
  URL pointing at the wrong chain fails loudly instead of scanning the wrong ledger.
- `/readyz` reports the network's cursor lag, so a network configured but not advancing is visible.
- Payment creation refuses a network with no cursor, so no customer is ever given an address on a
  chain nothing is watching.

**Decide `requiredConfirmations` and `requiresFinalityTag` deliberately.** They are policy, not chain
constants — nobody publishes a recommended count for Polygon, and its block time has changed twice.
A chain with a finality tag should use it: the count is the floor, and the tag is the gate. A chain
without one gets the count alone, and the count then has to be chosen for the worst reorg you are
willing to lose money to.

## A new chain family

Bitcoin, Aptos, anything that is not an EVM chain. This is the one that needs code, and it is bounded
by design rather than by optimism. TRON and Solana have both been through it, so the list below is
what it actually cost rather than what it was hoped to cost.

**1. Implement `ChainGateway`** (`apps/api/src/application/ports/chain-gateway.port.ts`) and
construct it instead of `EvmChainGateway` for that network. The port speaks ledger vocabulary with
opaque string identifiers: no transaction hash, no log index, no ABI, no chain id, and a lint rule
keeps those spellings out of `domain/` and `application/` entirely. That is what keeps the rest of
the system out of the change.

The port has a `skipped` arm on position lookup that is free on EVM and load-bearing elsewhere: a
Solana slot can legitimately produce no block, and without that arm the ancestry walk reads a healthy
chain as a reorg and halts scanning.

**2. Declare how the chain writes an account down.** `AddressForm` in
`packages/shared/src/network-descriptor.ts`, the matching branch in `isCanonicalAccount`, and the
SQL predicate of the same name. Give the family its own form rather than reusing a neighbour's:
TRON and Solana are both base58 in the same length range, and the shared form that once covered both
would have accepted each family's address where the other belonged. Migration 0015 is the repair and
the reasoning.

**3. Add an address strategy** in `apps/api/src/infrastructure/wallet/`. Two questions decide the
shape, and the second one decides a security property rather than a style:

- Which registered SLIP-0044 coin type? An address derived under the wrong one is valid and
  unreachable by any wallet restoring the seed.
- Which curve? secp256k1 supports non-hardened derivation, so the family joins the existing allocator
  and payment creation continues to hold no private key. Ed25519 does not: SLIP-0010 makes derivation
  hardened-only, there is no extended public key, and the seed must be opened per address. The
  `AddressStrategy` union has one arm for each, so the compiler makes you choose. See ADR-0009.

**4. Add a payment URI builder** in `packages/shared/src/payment-uri.ts`, or declare
`supportsPaymentUri: false` and mean it. There is one builder for the whole product; the hosted
checkout and the API both draw from it, and a second one is how a native payment ends up rendered as
a token transfer.

**5. Register the network, its assets and its capabilities.** A capability flag that is true where
the code cannot honour it is worse than a missing feature, because it is advertised.

Unchanged by a new chain: the `Payment` aggregate, the transition table, `Money`, the acceptance
band, the finality policy, every use case, the compare-and-swap SQL, the outbox, the webhook signer
and the retry schedule. That list held for both families that have been added since it was written.

**Where the claim is still not fully proven.** There are now three adapters, so the port's shape is
no longer argued from one implementation. What still does not exist is a single contract suite
parameterised by an adapter factory: `chain-gateway.spec.ts` runs against Anvil, and TRON and Solana
have their own local-node and live-network suites asserting comparable things in their own words.
Extracting one shared suite is the work that would turn "three adapters exist" into "three adapters
satisfy the same contract".

## Adding a payment status

Don't, unless the lifecycle genuinely gained a state. If you must, the transition table in
`packages/shared/src/payment-transition-table.ts` is the single place: the state machine, the API
contract, the dashboard palette and `docs/state-machine.md` are all derived from it, and the 8×8
enumeration in the test suite will tell you exactly which pairs you left undecided.

One rule survives every future state: **no edge out of a terminal status.** That edge class is what
produces double crediting, which is why a late transfer is recorded as a `late` row and an event
rather than reopening a `completed` payment.
