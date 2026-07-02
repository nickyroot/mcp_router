# ADR-006: Transports and the scope of session state

Status: Accepted

## Context

Two transport questions, one uncomfortable truth.

**Upstream** (router as server): Claude Desktop and most local clients speak
stdio; Streamable HTTP is the spec's direction for everything else.
**Downstream** (router as client): local servers are spawned child processes
over stdio; remote servers speak Streamable HTTP.

The uncomfortable truth: over stdio there is no conversation identity. Claude
Desktop launches **one** router process and shares it across every chat
window. Any "active account/context" state is therefore process-global —
switching contexts in one chat changes routing for all of them. There is no
protocol-level fix; pretending otherwise would be dishonest.

## Decision

- **Upstream:** stdio in v0.1 (it is what `router run` speaks when launched
  by a client). Streamable HTTP upstream in v0.2+, where `Mcp-Session-Id`
  gives real per-session state scoping.
- **Downstream:** both from v0.1 — stdio child processes (lazy-spawned on
  first use, health-checked, restarted with backoff, killed on shutdown) and
  Streamable HTTP for remote servers. The config's `server` block takes
  either `command/args/env` or `url`.
- **State scoping:** state is keyed by session. Over HTTP that is the real
  session ID; over stdio there is exactly one session, and we **document the
  global-state limitation prominently** rather than hide it. Mitigations,
  not cures:
  - every implicitly routed result carries the `[account: X]` marker
    (ADR-000), so cross-chat bleed is never silent;
  - the explicit `account` parameter (ADR-003) always produces a correct
    route regardless of shared state;
  - writes never route on stale ambiguity (ADR-005).

## Consequences

- The state store is an interface (`get/set per session key`) from day one;
  in-memory map now, nothing to rewrite when HTTP sessions arrive.
- Downstream child-process management is the largest chunk of non-routing
  code: crash detection, restart backoff, "provider disconnected" errors
  surfaced gracefully (a dead account must not take down the router or hide
  its sibling accounts).
- No SSE-transport support (superseded in the spec); if a user needs a
  legacy-SSE downstream server, `mcp-remote`-style bridges exist.
