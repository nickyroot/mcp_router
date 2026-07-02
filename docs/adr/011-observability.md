# ADR-011: Observability — console logs and local metrics

Status: Accepted

## Context

Two audiences: a user asking "why did that go to the wrong account?" and a
developer debugging a downstream server that misbehaves. Both are served
locally — no telemetry, no cloud, ever (ADR-013). Review pushed for metrics
from day one rather than as an afterthought; agreed, because the routing
decision (which step of ADR-005 fired) is precisely the thing users will need
to see.

One transport constraint shapes everything: over stdio, **stdout belongs to
the protocol**. All human-facing output goes to stderr.

## Decision

**Logging** — structured lines to stderr, one per routed call:

```
[12:04:31] notion/startup search_pages ok 281ms (route: active-context "work")
[12:04:44] notion/? search_pages asked (route: ambiguous, 3 candidates)
[12:05:02] github/company create_issue ERR downstream disconnected
```

Every line names the provider, account, tool, outcome, latency, and — the
part that matters — **which resolution step decided the route**. Levels:
`debug` (full payloads, redacted per ADR-009), `info` (the above), `error`.
`--log-level` flag; `debug` never logs secret values.

**Metrics** — in-memory counters and latency aggregates keyed by
(provider, account, tool, outcome), implemented as a middleware (ADR-010).
Read paths:

- `router stats` prints a table (per-account request counts, error counts,
  p50/p95 latency, route-step distribution) by reading a small JSON snapshot
  the running router writes to `~/.local/state/mcp-router/stats.json` on a
  throttle and at shutdown.
- Counters reset per process run; the snapshot is a debugging aid, not a
  time-series database.

## Consequences

- Metrics being a middleware keeps the extension seam honest and costs one
  map update per call — no measurable overhead.
- The stats snapshot file is best-effort: if two router processes run, last
  writer wins. Fine for a debugging aid; anything more is out of scope.
- No OpenTelemetry, no exporters, no config for sinks. If someone needs
  that, the metrics middleware is where they'd add it — in their fork or a
  future ADR.
