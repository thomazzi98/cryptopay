# Architecture decision records

Each record states a decision, the reasoning that produced it, what it costs, and what was rejected.

The cost section is not decoration. A decision recorded without its price is a decision nobody can
revisit later, because there is nothing written down to weigh against the new circumstances.

|                                                       | Decision                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [0001](0001-postgres-as-the-only-durable-store.md)    | PostgreSQL is the only durable store. There is no broker, because a broker is the dual write.     |
| [0002](0002-leased-leadership-with-fencing-tokens.md) | Leased leadership with fencing tokens: an advisory lock has no failover when a process hangs.     |
| [0003](0003-finality-tag-over-confirmation-count.md)  | The finality tag gates completion alongside the count, and a stall holds rather than falls back.  |
| [0004](0004-ledger-shaped-chain-port.md)              | The chain port speaks ledger vocabulary with opaque identifiers, so a second chain is an adapter. |
| [0005](0005-hd-derived-address-per-payment.md)        | One HD-derived address per payment, allocated from a public key so the API cannot sign.           |
| [0006](0006-standard-webhooks.md)                     | Callbacks follow Standard Webhooks, so a merchant verifies with a library they already trust.     |
| [0007](0007-ports-and-the-ones-refused.md)            | Five ports, and the reasons the obvious others are refused.                                       |
| [0008](0008-no-dependency-injection-framework.md)     | Fastify and a hand-written composition root rather than NestJS.                                   |
| [0009](0009-per-family-address-derivation.md)         | Destinations are derived per family, and ed25519 cannot keep the property secp256k1 gives.        |

## Not yet recorded

The sweep mechanism has no record, because settlement is not implemented. Writing one would be
recording an intention, and this directory is for decisions that were actually made and paid for.
