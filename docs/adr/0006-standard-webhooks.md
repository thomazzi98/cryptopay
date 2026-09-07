# ADR-0006: Callbacks follow Standard Webhooks

- Status: accepted

## Context

A merchant has to verify that a callback came from us and was not tampered with. Every processor
invents a scheme; most are an HMAC over some string, and every one differs in the details.

## Decision

[Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp` and
`webhook-signature: v1,<base64>`, signing `{id}.{timestamp}.{body}` with HMAC-SHA256. Branding goes in
extra `cryptopay-` headers where it cannot affect verification.

## Why

**A merchant verifies with a library they already trust, on their first day.** `svix` and
`standardwebhooks` are installed and audited by people who are not us. A bespoke scheme means every
merchant writes cryptographic code against our prose, and some of them write it wrong in a way we
never see.

**The same module signs, verifies and is tested here.** A verifier written separately for the
documentation is a verifier that drifts from the signer, and the drift is discovered by a merchant.

## The three details that decide whether this works

Each has its own test, because each is where implementations break.

The id is byte-identical across retries and across a manual redelivery. It is the merchant's
idempotency key, and a retry that changed it is processed as a second event, which for a completed
payment means shipping the order twice.

The timestamp is regenerated per attempt. Reusing the event's original timestamp puts every retry past
the tolerance window, so a merchant who was briefly down can never be told what happened. This is the
mirror of the rule above and the one that gets confused with it.

The body is serialized once, at enqueue, and stored. Every attempt transmits those exact bytes.
Re-serializing per attempt reorders keys, and the signature then covers something the merchant never
received.

## What this costs

Little. The scheme is more conservative than a bespoke one would need to be, and the `whsec_` prefix
it recommends collides with Stripe's secret-scanning pattern on GitHub. That is a real annoyance, and
it is why no credential-shaped literal is written in this repository's source at all, even a
fabricated one.
