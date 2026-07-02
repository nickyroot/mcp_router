# ADR-010: Middleware pipeline as the extension point

Status: Accepted

## Context

The spec asks what extension points should exist for future policy engines
and enterprise features (approvals, audit, RBAC, rate limiting) — none of
which we are building (ADR-013), all of which we should avoid architecturally
precluding. The wrong answer is speculative plugin APIs with loaders and
manifests; the right answer is a boring, internal seam that costs nothing now.

## Decision

Every upstream tool call flows through a linear middleware pipeline before
and after the resolver:

```
incoming call
   │
   ▼
[logging] → [metrics] → [policy*] → resolve route (ADR-005) → forward downstream
   │                                                                │
   ◀───────────────────── result (marked per ADR-000) ◀─────────────┘
```

A middleware is a function `(ctx, next) => result` — the Koa/Express shape
every contributor already knows. `ctx` carries the call, the resolved route
(after the resolver runs), session state, and config. A middleware can
observe, mutate `ctx`, short-circuit with a result (that is how an approval
gate or rate limiter would say no), or pass through.

In v0.x the pipeline is **internal only**: logging and metrics are
themselves middlewares (keeping the core honest — if the seam can't support
our own cross-cutting concerns, it can't support anyone's), and the `policy`
slot is empty. No config-loadable third-party middleware, no plugin manifest,
no stability promise on `ctx`'s shape.

## Consequences

- Future enterprise features drop in as middlewares without touching the
  resolver or registry: approval = short-circuit pending confirmation;
  audit = observe-and-record; RBAC = filter by identity; rate limit =
  short-circuit on budget.
- Deliberately **not** built: dynamic `require()` of user-specified modules.
  Loading arbitrary code from config is a supply-chain hazard in a tool that
  holds credentials; if third-party middleware ever becomes a real demand, it
  gets its own ADR with a security story.
- The pipeline wraps tool calls only. List operations, notifications, and
  lifecycle events are not middleware-visible in v0.x — acceptable, since
  every anticipated policy concern attaches to calls.
- The system's load-bearing layer boundaries are: **core** (resolver,
  registry, state — pure, no I/O), **policies** (this pipeline), and
  **transport** (SDK transports, isolated in one module). There is
  deliberately no fourth "provider plugin" layer: providers are declared in
  config, never coded (ADR-007). If provider-specific behavior is ever
  needed, the escalation path is config/data first, middleware second,
  loadable code last — and only with a security story.
