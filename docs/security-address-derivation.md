# Security review: payment address derivation

A payment address is the one thing in this system a customer sends real money to. If it is wrong,
predictable, reused, or derived from something an attacker can reach, nothing else in the design
matters. This page reviews how those addresses are produced across all three network families and
records the decisions that were made rather than leaving them implicit.

It is written to be disagreed with. Every claim below names the file that makes it true, so a
reviewer can check rather than trust, and each section ends with what is **not** protected.

---

## 1. Where the entropy comes from

`generateMasterSeed()` returns 64 bytes from `node:crypto`'s `randomBytes`, which is the platform
CSPRNG. There is no application-supplied entropy, no timestamp mixing and no user input anywhere in
the path, because each of those is a way to make a seed weaker than the primitive already is.

One seed per environment. `test` and `live` are separate rows with separate key material, so no
derivation on a testnet can tell you anything about a mainnet address.

**Not protected**: the quality of the platform CSPRNG itself. If `getrandom` is broken, so is this.

## 2. How a seed is stored

AES-256-GCM under a data key, and that data key is wrapped by the key encryption key in
`WALLET_KEY_ENCRYPTION_KEY`. The additional authenticated data is
`cryptopay:wallet-seed:v1:{environment}`, which binds each envelope to the environment it was
written for: a `test` row copied into the `live` slot fails authentication instead of quietly
signing mainnet transactions with a testnet seed.

The wrapping scheme is a column, not a constant, so the envelope records how it was sealed and old
rows keep opening under the old scheme when a new one arrives.

**Not protected**: anyone who can read the process environment can unwrap every seed. This is the
largest exposure in the system and is stated first in `docs/limitations.md`.

## 3. Derivation, per family

| Family  | Curve     | Path                  | Address is                                      | Creation path holds |
| ------- | --------- | --------------------- | ----------------------------------------------- | ------------------- |
| Polygon | secp256k1 | `m/44'/60'/0'/0/{i}`  | last 20 bytes of keccak256, hex                 | public key only     |
| TRON    | secp256k1 | `m/44'/195'/0'/0/{i}` | the same 20 bytes, `0x41`-prefixed, base58check | public key only     |
| Solana  | ed25519   | `m/44'/501'/{i}'/0'`  | the 32-byte public key, base58                  | **the seed**        |

Coin types are the registered SLIP-0044 values, not conventions. An address derived under the wrong
coin type is a perfectly valid address that no wallet restoring this seed would ever look at.

The Solana path is the one Phantom and the Ledger application use, so an operator recovering the
seed in a standard wallet finds the funds where they expect.

## 4. Hardened versus non-hardened, and why the answer differs by family

**This is the decision the review exists to record.** It was not inherited and it is not uniform.

Polygon and TRON derive addresses **non-hardened**, deliberately. Non-hardened derivation is what
makes a child address computable from an account-level _extended public key_, which is what lets
`HierarchicalDeterministicAllocator` hold no private key at all. Payment creation is the busiest and
most exposed code in the product, and it is structurally incapable of signing — not by policy, by
arithmetic. A test asserts the allocator's `accountKey.privateKey` is null.

The cost is the standard one and is real: **the account extended public key plus any single leaked
child private key together yield every private key in that branch.** Accepted, for these reasons:

- The extended public key is never exposed. It is not in any API response, any log, or any database
  column; only the derived address and the path are stored.
- A child key is materialised only when a settlement is signed, and zeroed immediately.
- The blast radius is one environment, since seeds are separate.
- The alternative costs the property above, and a creation path that can sign is a worse exposure
  than a branch compromise that requires an already-leaked key plus a value we never publish.

Solana derives **hardened at every level**, and this was not a choice. SLIP-0010 defines ed25519
derivation as hardened-only: ed25519 public keys are not points that can be tweaked, so there is no
extended public key and no way to compute a child address without the parent private key. The
consequences run in both directions and both are recorded here:

- **Lost**: the creation path must open the seed to issue a Solana address. It is opened per
  allocation and zeroed in a `finally` rather than cached, so the plaintext seed is absent from
  memory for all but a few milliseconds of the process's life. This is the same trade the signing
  provider already makes, for the same reason. A cached seed would be resident for the deployment's
  entire lifetime, which is strictly worse than a decryption per payment creation.
- **Gained**: a leaked Solana child key exposes nothing but that one address. The branch compromise
  described above for secp256k1 has no ed25519 analogue.

`AddressStrategy` models this as a discriminated union rather than a comment, so the difference is a
type-level fact the provider is forced to handle and a reader can see which families touch a seed
without reading an implementation.

**Not protected**: on Polygon and TRON, a leaked child key plus the extended public key. On Solana,
a compromise of the process during the window a seed is open.

## 5. Key isolation and memory

The signing provider is the only code that produces a private key, and it hands one to a callback
rather than returning it, so a caller cannot keep one alive past its purpose. The treasury sits
behind a hardened account of its own, so the branch exposure in §4 stops at the deposit addresses
and never reaches the account holding gas.

Every buffer holding key material is zeroed on the way out, including the copies. That last word is
load-bearing and was a real finding of this review: `HDKey.fromMasterSeed` and the SLIP-0010 walk
both take a `Uint8Array`, and constructing one from the seed `Buffer` copies the bytes. Zeroing only
the original left the same secret reachable through a copy nobody was tracking, in all three of the
allocator, the ed25519 derivation and the signing provider. All three now zero the copy as well.

**Not protected**: `privateKeyToAccount` takes a hex **string**, and JavaScript strings are immutable
and cannot be zeroed. One private key per signature therefore reaches the garbage collector intact.
This is a property of the library's API rather than of this code, and it is the reason the seed is
never held longer than a call.

## 6. What can reach a log or an API response

`allocationReference`, `derivationIndex` and `derivationPath` are on the logger's redaction list
alongside `privateKey`, `mnemonic`, `masterSeed` and `seed`, at three levels of nesting because
pino's wildcard matches one segment.

No response type declares a field the derivation path could travel in. The gateway presenter names
every field explicitly rather than spreading the aggregate, so adding a column cannot publish one by
accident, and an integration test asserts that no creation response contains `m/44`,
`allocationReference` or `derivationIndex`.

The secret scanner runs over every tracked file on every commit and rejects a bare 64-character hex
value. The SLIP-0010 test vectors are exempted one value at a time, by value, never by path, so a
real key pasted into the same file is still caught.

## 7. Uniqueness, reuse and concurrency

An address is issued to exactly one payment and never reused. Three independent mechanisms hold it:

- `UNIQUE (network_identifier, account)` on `payment_addresses` — the database refuses a second
  payment at the same address on the same network.
- `UNIQUE (environment, derivation_index)` — one index per environment, across every family, so two
  payments cannot share a derivation index even on different chains.
- The index comes from a PostgreSQL sequence, so allocation never reads-then-writes and concurrent
  creation cannot collide. Gaps are harmless in a hierarchical-deterministic wallet, which is why a
  sequence is correct here and a counter row — which would serialise every payment creation on a
  network — is not.

An integration test creates twenty payments concurrently across all three families and asserts
twenty distinct addresses.

A consequence worth stating: because the sequence is shared across families within an environment,
each family's derivation tree is sparse. Recovery must scan an index range rather than a contiguous
run. That is the price of making cross-family uniqueness trivially true, and it is cheap: scanning
is a local computation.

**Not protected**: nothing enforces that two _deployments_ sharing one seed use disjoint index
ranges. Two installations pointed at the same seed and different databases would issue the same
addresses. Do not do that.

## 8. The database check is weaker than it looks

`is_canonical_account` is a shape check, and shapes cannot distinguish everything.

TRON is checked exactly: thirty-four characters beginning with `T`. Solana is checked as base58 of
length 32 to 44, because separating a thirty-two byte payload from TRON's twenty-five byte one
requires decoding base58, and a decoder written in SQL to guard rows this system generates itself
would add more risk than the check removes.

The application layer is stronger than the database, and deliberately so. `isCanonicalAccount`
decodes base58 and requires a Solana account to be exactly thirty-two bytes, which rejects a TRON
address outright: TRON is a twenty-five byte base58check payload written in thirty-four characters,
and that length sits inside the range a thirty-two byte key occupies, so the two can only be told
apart by what they decode to. Decoding needs arbitrary-precision arithmetic and no hash, so the
shared module stays dependency free and safe for the browser bundle.

The residual gap is therefore confined to SQL, and is precise: **a thirty-four character Solana
address beginning with `T` would satisfy the TRON rule in the database.** Such an address is legal
and possible, if rare. It is not reachable today, because every account written to these tables is
derived by this system under a known family rather than supplied by anyone, and passes through
`canonicaliseAccount` on the way. If merchant-supplied destinations are ever accepted, the SQL check
must be replaced by a real decode before that feature ships, not after.

## 9. Custody, and what deliberately does not exist

Destinations are derived on TRON and Solana, so those addresses do hold merchant funds between
payment and settlement, exactly as on Polygon. What does not exist for either family is a
broadcaster: `supportsSettlement` is false, nothing sweeps them, and there is no API that can move
them.

Funds at those addresses are **recoverable but not automatically swept**. The keys derive from the
master seed, so an operator holding the seed and the key encryption key can reach them; the system
will not do it for them. That is a deliberate limit rather than an oversight, and it is the honest
version of the sentence a reader should take away: this is not "money is stuck", and it is also not
"there is a withdrawal flow". There is no withdrawal API, no sweep API, no merchant transfer, no
custody dashboard, no key export and no key recovery interface, and none of those were added to make
the payment flow work.

## 10. What a reviewer should attack first

In rough order of expected return:

1. Read `WALLET_KEY_ENCRYPTION_KEY` from the host. Everything else is downstream of this.
2. Obtain the account extended public key for Polygon or TRON, then any one child key.
3. Find a path where an `allocationReference` reaches a log or a response.
4. Race two payment creations and try to obtain one address twice.
5. Get a base58 address of one family stored against the other family's network.

Items 3, 4 and 5 have tests that assert they fail. Items 1 and 2 are the honest exposures and are in
`docs/limitations.md`.
