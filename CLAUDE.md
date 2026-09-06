# Engineering guide

Read this before writing code in this repository. It records the rules that are enforced
mechanically, the version pins that are load-bearing, and the framework traps that have already
cost time once.

## Code style — enforced by lint, not by review

| Rule | Why |
| --- | --- |
| **No `else`** | Guard clauses, early returns, lookup maps, or a `switch` on a discriminated union. `no-else-return` alone is not enough; the config bans `IfStatement > .alternate` outright. |
| **No abbreviated identifiers** | `request` not `req`, `response` not `res`, `transaction` not `tx`, `address` not `addr`, `amount` not `amt`, `configuration` not `cfg`. Established acronyms (`id`, `url`, `api`, `http`, `rpc`, `hmac`, `sql`) are allowed. |
| **English only** | Identifiers, comments, logs, errors, commit messages, documentation. Non-ASCII string literals are rejected. |
| **Comments are rare** | Explain a non-obvious decision, a security constraint, or chain-specific behaviour. Never restate the code. If a function needs a paragraph, the function is wrong. |
| **No dead code** | No unused files, exports, dependencies, or commented-out blocks. `knip` runs in CI and sees what identifier linting cannot. |
| **No placeholders** | No `TODO` for core functionality, no `throw new Error('Not implemented')`, no fake data in a real code path. Mocks belong in tests only. |

Disabling a lint rule inline requires a description, and the two rules above cannot be disabled at
all. Without that, the first hard case gets an `eslint-disable` and the mandate is over.

## Architecture boundaries

```
domain/        pure. imports node: builtins and packages/shared only.
application/   use cases and ports. no viem, no Prisma, no Fastify, no undici.
infrastructure/ the only place viem, Prisma, Fastify and undici may appear.
```

Enforced by `no-restricted-imports` zones. A `viem` import inside `domain/` fails the build.

The chain ports speak **ledger vocabulary with opaque string identifiers**. There is no
`` `0x${string}` `` outside `infrastructure/chain/evm/`, and the identifiers `blockHash`, `logIndex`,
`topics`, `abi`, `chainId`, `slot` and `nonce` are banned in `domain/` and `application/` by a lint
rule. This is what keeps a second chain an adapter instead of a rewrite.

## Version pins — every one is deliberate

Exact versions, no carets, one root lockfile. Rationale for the non-obvious ones:

| Package | Pin | Why not `latest` |
| --- | --- | --- |
| `typescript` | **6.0.3** | `latest` is 7.0.2, the native Go port. `typescript-eslint` declares `typescript: ">=4.8.4 <6.1.0"` — TypeScript 7 breaks linting outright. |
| `vitest` / `@vitest/coverage-v8` | **4.1.11** | `latest` is 5.0.0, days old. Its headline benefit is Oxc decorator metadata and this codebase has zero decorators. |
| `vite` | **not pinned at all** | Vitest resolves its own compatible Vite. Pinning it independently is what creates the peer conflict. |
| `prisma` / `@prisma/client` | **7.10.0** | `npm install prisma` resolves `8.0.0-rc.13` from the `latest` dist-tag — a release candidate. Both packages must match exactly or the query engine skews from the client. |
| `@types/node` | **24.13.3** | Must track the Node major (24), not `latest` (26.x). |

## Framework traps

**wagmi v3 renamed the core hooks.** Most tutorials and most training data are v2:

| v2 | v3 |
| --- | --- |
| `useAccount()` | `useConnection()` |
| `useAccountEffect()` | `useConnectionEffect()` |
| `useSwitchAccount()` | `useSwitchConnection()` |
| `connectors` / `chains` off a hook result | `useConnectors()` / `useChains()` / `useConnections()` |
| mutation called directly | `.mutate` / `.mutateAsync` |

Use `useConnection().chainId` (the wallet's real chain) for the chain guard, never `useChainId()`
(the config's idea of the chain).

**Next 16.** `next.config.ts` must never contain a `webpack` key — Turbopack is the default builder
and an injected webpack option fails the build hard. `params`, `searchParams`, `cookies()` and
`headers()` are Promises and must be awaited. `next lint` was removed; ESLint is wired manually.
`serverRuntimeConfig` / `publicRuntimeConfig` are gone, which is why the dashboard talks to the API
through a BFF proxy rather than a build-time-inlined base URL.

**Tailwind v4.** `postcss.config.mjs` is `{ plugins: { '@tailwindcss/postcss': {} } }` and nothing
else — no `tailwind.config.ts`, no autoprefixer, no postcss-import. Tokens live in `globals.css`
under `@theme inline`. Because `packages/shared` is a workspace, `globals.css` must carry
`@source "../../packages/shared/src";` or classes referenced from shared code are purged **in the
production build only**. shadcn's v4 `chart.tsx` uses `var(--chart-1)`, not `hsl(var(--chart-1))`;
copying a v3 snippet renders every chart black.

**viem.** `blockTag: 'safe'` type-checks and fails at runtime on Polygon — banned by lint rule. Only
`'finalized'` and numeric heights are used. Provider errors are wrapped, so always unwrap with
`error.walk((candidate) => candidate.code === 4001)` rather than reading `error.code` directly.

## Money and addresses

- Amounts are `bigint` base units end to end. Never `number`, never `parseFloat`. On the wire an
  amount is two decimal **strings**: `baseUnits` and `display`.
- USDC has **6** decimals, not 18. Decimals are read from the contract, never assumed.
- Addresses are stored, transported and compared **lowercase**. A checksummed string is produced only
  at the presentation boundary by `getAddress()`. There is no hand-typed mixed-case address literal
  anywhere in this repository, and a lint rule enforces that.
- Token identity is the **contract address only**. Bridged USDC.e returns the byte-identical
  `symbol()` string `"USDC"`; matching on symbol credits the wrong asset.

## Commits

Conventional commits, English, imperative, scoped to a coherent change:

```
feat(payments): add compare-and-swap status transitions
fix(callbacks): keep webhook-id stable across retries
test(chain): cover reorg below the acceptance band
```

No mention of AI or code generation in commit messages.
