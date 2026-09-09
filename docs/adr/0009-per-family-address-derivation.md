# ADR-0009: Per-family address derivation, and what ed25519 costs

- Status: accepted
- Extends: [ADR-0005](0005-hd-derived-address-per-payment.md)

## Context

ADR-0005 settled how a payment gets an address on an EVM chain. TRON and Solana then arrived as
complete, tested read adapters that nothing in the product could point at, because the allocator
derived EVM addresses only. A payment on either family died at the moment an address was needed.

The question is not only how to extend the allocator. It is first whether CryptoPay should be
issuing these addresses at all.

## Decision

Destinations are derived internally, per family, from the existing master seed:

| Family  | Curve     | Path                  | Address                                         |
| ------- | --------- | --------------------- | ----------------------------------------------- |
| Polygon | secp256k1 | `m/44'/60'/0'/0/{i}`  | keccak256 key hash as hex                       |
| TRON    | secp256k1 | `m/44'/195'/0'/0/{i}` | the same key hash, `0x41`-prefixed, base58check |
| Solana  | ed25519   | `m/44'/501'/{i}'/0'`  | the ed25519 public key, base58                  |

## Why derive rather than accept a merchant's own address

The brief this work answers asks for the least custodial architecture that satisfies the existing
product requirements, so the non-custodial option was examined first and properly.

**It does not satisfy them.** The entire payment model is one address per payment: attribution is
structural, `UNIQUE (network_identifier, account)` enforces it, and over- and underpayment are
decided by comparing the balance at an address to what that one payment asked for. A single
merchant-owned address per network breaks all of that. Two customers paying the same amount in the
same minute become indistinguishable.

The usual repair is a memo, and it is available on exactly one of the three families. Solana Pay
carries a `reference` field, which is real and which the URI builder already emits. **TRON has
nothing.** There is no memo on a TRC-20 transfer that a wallet will reliably carry, so a shared TRON
address cannot attribute concurrent payments at all. Choosing merchant-owned destinations would mean
shipping a TRON integration that silently mis-attributes under concurrency, which is worse than
custody, not better.

So the answer is the same as ADR-0005's, for the same reason, and the custody window it describes now
extends to two more chains. That is a real cost and it is recorded in `docs/limitations.md` rather
than argued away.

## Why the curve changes the security property, and why that is not negotiable

This is the part worth reading twice.

The allocator's defining property is that it holds an account-level **extended public key** and no
private key at all, so the busiest and most exposed path in the product is structurally incapable of
signing. That property is a consequence of non-hardened BIP-32 derivation over secp256k1, where a
child public key is computable from the parent public key alone.

TRON is secp256k1, so it keeps the property in full and shares the implementation.

**Ed25519 has no such operation.** Ed25519 public keys are not points that can be tweaked, so
SLIP-0010 defines ed25519 derivation as hardened-only: there is no extended public key, and every
child address requires the parent private key. No arrangement of the code changes this. Solana
therefore cannot be given the property Polygon and TRON have.

What was chosen instead, and what it trades:

- The seed is opened **per allocation** and zeroed in a `finally`, not cached. A cached seed sits in
  process memory for the deployment's whole life; a per-allocation one is present for a few
  milliseconds. The signing provider already makes exactly this trade, and payment creation is not a
  hot enough path for a decryption to matter.
- The union type `AddressStrategy` has one arm that takes a seed and one that does not, so the
  difference is a fact the compiler enforces rather than a comment somebody can miss.
- Ed25519 gives something back: hardened derivation means a leaked child key exposes **only that
  address**. The branch compromise that non-hardened secp256k1 accepts has no ed25519 analogue.

The full review, including what is deliberately not protected, is in
`docs/security-address-derivation.md`.

## What this costs

- Solana payment creation touches the seed. Polygon and TRON do not. That asymmetry is permanent.
- One derivation index sequence per environment is shared across all three families, so each
  family's tree is sparse and recovery scans a range rather than a run. Cheap, and it makes
  cross-family uniqueness trivially true.
- Funds now accumulate at TRON and Solana addresses with no sweeper, because `supportsSettlement` is
  false for both and building one was out of scope. They are recoverable from the seed by an
  operator; nothing moves them automatically and no API can. Stated plainly in the limitations.

## Considered and rejected

**Force TRON and Solana into the EVM representation.** Rejected on sight: a base58 address is not a
hex address, and the lowercase canonical rule that is correct for EVM destroys a base58 one.

**One shared `base58` address form for both non-EVM families.** This was the original shape and it
was wrong. TRON and Solana write base58 in the same length range, so one form accepts each family's
address where the other belongs, and money sent to that confusion is unrecoverable. Split into
`tron-base58check` and `solana-base58` by migration 0015.

**Pre-derive a pool of Solana addresses offline** so the creation path never sees a seed. It restores
the property, and it costs a pool table, a refill worker, an exhaustion failure mode, and a new
question about where the pool is generated. Rejected as more machinery than the exposure justifies,
given the seed is open for milliseconds. Worth revisiting if Solana volume ever makes the decryption
per creation a real cost, which would be the honest trigger for it.

**A second, unrelated key hierarchy for the non-EVM families.** Rejected: two seeds to back up, two
things to lose, and no security benefit over one seed with distinct registered coin types.
