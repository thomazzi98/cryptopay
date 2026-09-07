# ADR-0008: Fastify and a hand-written composition root, not NestJS

- Status: accepted

## Context

NestJS is the default choice for a TypeScript service of this shape. It brings a module system, a
dependency-injection container, and a large amount of structure that would otherwise be written.

## Decision

Fastify 5, with a composition root of roughly 150 lines that constructs everything explicitly, in
dependency order, in one file.

## Why

**The wiring is greppable.** Every dependency is a constructor argument, written down at the point it
is passed. There is no runtime resolution step that can fail on a token that was only ever a string,
and no decorator metadata to be missing because a build flag changed.

**No decorators means no `reflect-metadata`, no `emitDecoratorMetadata`, and no lock on a TypeScript
version.** This repository pins TypeScript 6.0.3 for reasons of its own; a framework that constrains
that pin further is a framework that decides when this project may upgrade.

**Boundaries are enforced by lint rather than by modules.** `no-restricted-imports` zones fail the
build when `domain/` imports viem. That is a stronger guarantee than a module boundary enforced by
convention and a reviewer's attention.

## What this costs

Everything NestJS provides has to be written: request logging, error shaping, validation wiring,
lifecycle. That came to a few hundred lines, each doing exactly one thing this system needs, which is
the trade being made rather than an accident of it.

It also costs familiarity. A NestJS developer joining this codebase reads the composition root
instead of already knowing the conventions. The composition root is one file and reads top to bottom,
which is the mitigation and is not nothing.

## Considered and rejected

**NestJS.** The above.

**Express.** Slower, with worse async error handling — and an unhandled rejection in this system means
a payment is not detected, which is the one failure mode worth paying to avoid.
