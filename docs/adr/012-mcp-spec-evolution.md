# ADR-012: Tracking MCP spec evolution

Status: Accepted

## Context

MCP revs multiple times a year (protocol revisions are date-versioned;
transports have already been superseded once — HTTP+SSE → Streamable HTTP).
The router is *middleware*: it faces the spec on both sides, and sits between
clients and servers that will be on **different** revisions of it. "What if
MCP changes?" is not hypothetical; it is the weather.

## Decision

Three rules:

1. **The SDK is the spec boundary.** All protocol encoding/decoding goes
   through `@modelcontextprotocol/sdk` (ADR-001); we never hand-roll JSON-RPC
   or sniff protocol versions ourselves. Version negotiation happens
   per-connection by the SDK — upstream and each downstream connection may
   settle on different revisions, and that is normal.
2. **Passthrough by default, translate by exception.** For protocol features
   the router doesn't interpret (result content types, annotations, `_meta`
   fields), relay verbatim. The router touches only what it must: tool lists
   (merge), tool-call arguments (strip `account`), results (append marker).
   Unknown fields survive the trip. This keeps most future spec additions
   working through the router with zero changes.
3. **Adopt capabilities conservatively.** New spec features (elicitation is
   the current example) enter behind config flags only after major clients
   support them; the router must always degrade to the lowest common
   revision between its two sides. Where a capability can't be bridged
   (upstream client lacks something a downstream server wants), the router
   advertises only what it can honor end-to-end.

Testing discipline: the integration suite pins fixture servers at the oldest
revision we support *and* the SDK's current one; SDK upgrades are routine PRs
run against both.

## Consequences

- Spec churn concentrates into SDK version bumps instead of scattering
  through routing logic.
- Passthrough-by-default means we occasionally relay things we don't
  understand — by design. The alternative (allow-listing known fields) would
  make the router the ecosystem's bottleneck for every new spec feature.
- Capabilities we advertise upstream are computed, not hardcoded: the
  intersection of what our downstream connections actually support, feature
  by feature.
