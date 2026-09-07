# ADR-0005: One HD-derived address per payment

- Status: accepted

## Context

A payment needs an address to receive money at. There are three ways to arrange that, and they differ
in who holds the keys.

## Decision

A BIP-32/44 hierarchical wallet, `m/44'/60'/0'/0/{index}`, one address per payment, allocated from the
account-level **public** key alone.

## Why

**One address per payment makes attribution structural.** With a shared address, two customers paying
the same amount in the same minute are indistinguishable, and the system has to guess or demand a memo
field that customers get wrong. With one address per payment there is nothing to attribute: the
address _is_ the payment, enforced by a uniqueness constraint on `(network, account)`.

**Allocating from the public key means the process that creates payments cannot sign.** That is not a
policy, it is arithmetic. The API holds no private key material at all, so compromising it yields no
ability to move funds.

## The comparison this decision rests on

|                | Shared address with memo                  | **HD address per payment**  | Non-custodial: pay the merchant directly                   |
| -------------- | ----------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| Attribution    | Customer must supply a memo, and will not | Structural                  | Structural, if the merchant issues one address per invoice |
| Custody window | Full custody, indefinite                  | Full custody, minutes       | **None**                                                   |
| Sweep cost     | None                                      | One transaction per payment | None                                                       |
| Merchant setup | Nothing                                   | Nothing                     | Must run key management and be online                      |
| Underpayment   | Manual                                    | Detected and surfaced       | Detected and surfaced                                      |

The non-custodial column is genuinely better on the axis that matters most, and it is not chosen
because it moves the hard part onto the merchant. They would have to derive addresses, hold keys and
stay online. A payment processor whose proposition is "you do the key management" has no proposition.

The custody window is therefore real. It is minimised rather than eliminated — sweep on finality, so
the balance under those keys is small and short-lived — and it is listed in `docs/limitations.md`
rather than argued away.

## What this costs

A sweep transaction per payment, and gas to fund it. And the exposures in `docs/limitations.md` §1
and §2: the key encryption key is an environment variable on the host, and non-hardened derivation
means the account extended public key plus any one leaked child key yields every key in the branch.

## Considered and rejected

**A shared address with a memo field.** Customers omit the memo. Every processor that has tried this
has a support queue about it.

**A fresh random key per payment, stored encrypted.** Equivalent security, and it turns key recovery
from "restore one seed" into "restore a database", which is strictly worse on the day the database is
what was lost.
